'use strict';
const { ethers } = require('ethers');
const { spawn }  = require('child_process');
const path       = require('path');
const readline   = require('readline');
const fs         = require('fs');

const RPC_URL     = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const LOG_INT     = parseInt(process.env.LOG_INTERVAL || '5');
const MAX_GAS     = parseInt(process.env.MAX_GAS_GWEI  || '30');
const CHAIN_ID    = 1n;
const CONTRACT    = '0xa9951Cfb634dc103472FC51DD106cBb7E53f60Cc';

// Known working selectors (confirmed by probe)
const SEL_EPOCH = '0x1f21bfbf';   // returns currentEpoch (4877)
const SEL_DIFF  = '0x9b19251a';   // returns activeDifficulty

const SOLVER_PATH = process.env.SOLVER ||
  ['/app/lean25','/app/solver/lean25',
   path.join(__dirname,'..','lean25'),
   path.join(__dirname,'..','solver','lean25')]
  .find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
  || '/app/lean25';

if (!RPC_URL || !PRIVATE_KEY) {
  console.error('[FATAL] Set RPC_URL and PRIVATE_KEY'); process.exit(1);
}

// All unknown "needs args" selectors — one of these is mine()
const UNKNOWN_WRITE = [
  '21d0ee70','259982e5','2c246df4','575e24b4','68bdd8b6',
  '6c2bbe7e','6fe7e6eb','70be72e3','734f912b','7979136e',
  '9f063efc','a0893e8f','a6a15183','af463bd3','b47b2fb1',
  'b6a8b0fa','c1cbcec3','c30a0f25','c7284e45','c89962e4',
  'c96cf0f1','d00123fe','d294f093','dc98354e','e1b4af69',
  'eb3fc565','f37381ad','07621eca','085f9343'
];

// ── Find mine() selector by testing each unknown with (uint256, uint256[42]) ─
async function findMineSel(provider) {
  // If user set it manually, use that
  if (process.env.MINE_SELECTOR) {
    console.log(`[MINE_SEL] Using env override: ${process.env.MINE_SELECTOR}`);
    return process.env.MINE_SELECTOR;
  }

  console.log('\n══ FINDING MINE() SELECTOR ══');
  const nonce = 0n;
  const edges = Array.from({length:42}, (_,i) => BigInt(i*100));
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256','uint256[42]'], [nonce, edges]
  ).slice(2);

  // Score each selector — "missing revert data" = wrong selector, anything else = candidate
  const candidates = [];

  for (const sel of UNKNOWN_WRITE) {
    const data = '0x' + sel + encoded;
    try {
      const r = await provider.call({ to: CONTRACT, data });
      console.log(`  ✅ 0x${sel} → CALL SUCCEEDED (${r.slice(0,20)})`);
      candidates.push({ sel, score: 10, reason: 'succeeded' });
    } catch(e) {
      const msg = String(e.message || '').toLowerCase();
      const hasReason = !msg.includes('missing revert data') &&
                        !msg.includes('data=null') &&
                        !msg.includes('call_exception');
      if (hasReason) {
        console.log(`  🔍 0x${sel} → ${String(e.message||'').slice(0,100)}`);
        candidates.push({ sel, score: 5, reason: e.message?.slice(0,80) });
      }
    }
  }

  // Also test with (uint256, uint32[42]) encoding
  console.log('\n  [trying uint32[42] encoding...]');
  const encoded32 = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256','uint32[42]'], [nonce, edges.map(Number)]
  ).slice(2);
  for (const sel of UNKNOWN_WRITE) {
    const data = '0x' + sel + encoded32;
    try {
      const r = await provider.call({ to: CONTRACT, data });
      console.log(`  ✅32 0x${sel} → SUCCEEDED`);
      candidates.push({ sel, score: 10, reason: 'succeeded-32' });
    } catch(e) {
      const msg = String(e.message || '').toLowerCase();
      const hasReason = !msg.includes('missing revert data') &&
                        !msg.includes('data=null') &&
                        !msg.includes('call_exception');
      if (hasReason) {
        console.log(`  🔍32 0x${sel} → ${String(e.message||'').slice(0,100)}`);
        candidates.push({ sel, score: 5, reason: e.message?.slice(0,80) });
      }
    }
  }

  if (candidates.length > 0) {
    const best = candidates.sort((a,b) => b.score - a.score)[0];
    console.log(`\n  ★ Best mine() candidate: 0x${best.sel} (${best.reason})`);
    console.log('  → Set MINE_SELECTOR=0x' + best.sel + ' in Railway Variables to lock it in');
    console.log('══════════════════════════\n');
    return '0x' + best.sel;
  }

  console.log('\n  ⚠ Could not auto-detect mine() — will skip submissions');
  console.log('  → Check if the contract requires msg.sender to be registered first');
  console.log('══════════════════════════\n');
  return null;
}

// ── State ─────────────────────────────────────────────────────────
let provider, signer;
let MINE_SEL    = null;
let USE_32BIT   = false;
let currentEpoch = -1n, currentDiff = 0n, currentChallenge = null;
let nonce = 0, attempted = 0, solved = 0, submitted = 0;
const startTime = Date.now();

function log(...a) { console.log(`[${((Date.now()-startTime)/1000).toFixed(0)}s]`,...a); }

function computeChallenge(epoch) {
  return ethers.solidityPackedKeccak256(
    ['uint256','address','address','uint256'],
    [CHAIN_ID, CONTRACT, signer.address, epoch]
  );
}
function computeSeed(challenge, n) {
  return ethers.solidityPackedKeccak256(
    ['bytes32','uint256'], [challenge, BigInt(n)]
  ).slice(2);
}
function checkDiff(challenge, proof) {
  const enc = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32','uint256[]'], [challenge, proof.map(BigInt)]
  );
  return BigInt(ethers.keccak256(enc)) < currentDiff;
}

async function refreshEpoch() {
  try {
    const [epRaw, diffRaw] = await Promise.all([
      provider.call({ to: CONTRACT, data: SEL_EPOCH }),
      provider.call({ to: CONTRACT, data: SEL_DIFF  }),
    ]);
    const ep   = BigInt(epRaw);
    const diff = BigInt(diffRaw);
    if (ep !== currentEpoch || diff !== currentDiff) {
      currentEpoch     = ep;
      currentDiff      = diff;
      currentChallenge = computeChallenge(ep);
      nonce = 0;
      log(`★ Epoch ${ep}  diff=0x${diff.toString(16).slice(0,12)}…  challenge=${currentChallenge.slice(0,18)}…`);
    }
  } catch(e) { log('[WARN] refresh:', e.message?.slice(0,80)); }
}

async function submitSolution(n, proof) {
  if (!MINE_SEL) { log('[SKIP] mine() selector not found yet'); return; }
  try {
    const gp = (await provider.getFeeData()).gasPrice;
    if (Number(gp / 10n**9n) > MAX_GAS) { log('[SKIP] gas too high'); return; }

    let data;
    if (USE_32BIT) {
      data = MINE_SEL + ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256','uint32[42]'], [BigInt(n), proof]
      ).slice(2);
    } else {
      data = MINE_SEL + ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256','uint256[42]'], [BigInt(n), proof.map(BigInt)]
      ).slice(2);
    }

    log(`[TX] Submitting nonce=${n} sel=${MINE_SEL} 32bit=${USE_32BIT}`);
    const tx = await signer.sendTransaction({ to: CONTRACT, data, gasLimit: 600_000n });
    log(`[TX] Sent ${tx.hash}`);
    const r = await tx.wait(1);
    if (r.status === 1) {
      submitted++;
      log(`✅ MINED! block=${r.blockNumber}`);
    } else {
      log('[WARN] tx reverted — check MINE_SELECTOR or proof encoding');
    }
  } catch(e) { log('[ERR] submit:', e.message?.slice(0,150)); }
}

function startSolver() {
  log(`[SOLVER] ${SOLVER_PATH}`);
  const proc = spawn(SOLVER_PATH, [], { stdio:['pipe','pipe','inherit'] });
  proc.on('error', e => { console.error('[FATAL] solver:', e.message); process.exit(1); });
  proc.on('exit', c => { log(`[SOLVER] exit ${c}, restart…`); setTimeout(startSolver,2000); });
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', async line => {
    line = line.trim();
    if (line.startsWith('CYCLE')) {
      const parts = line.split(' ').slice(1).map(Number);
      if (parts.length === 42) {
        solved++;
        const n = nonce - 1;
        log(`[CYCLE] nonce=${n} solved=${solved}`);
        if (currentChallenge && checkDiff(currentChallenge, parts)) {
          log('[DIFF] ✓ passes difficulty!');
          await submitSolution(n, parts);
        } else log('[DIFF] ✗ difficulty not met, continuing…');
      }
    }
    feedNext(proc);
  });
  feedNext(proc);
}

function feedNext(proc) {
  if (!currentChallenge) { setTimeout(()=>feedNext(proc),500); return; }
  const n = nonce++;
  attempted++;
  if (n % LOG_INT === 0) {
    const rate = (attempted/((Date.now()-startTime)/60000)).toFixed(1);
    log(`[MINE] nonce=${n} epoch=${currentEpoch} ~${rate}/min solved=${solved} submitted=${submitted}`);
  }
  proc.stdin.write(computeSeed(currentChallenge, n) + '\n');
}

async function main() {
  log('═══════════════════════════════════════');
  log(' Hash256 V2 Miner  –  Cuckoo Cycle 25 ');
  log('═══════════════════════════════════════');

  provider = new ethers.JsonRpcProvider(RPC_URL);
  signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  log(`Wallet   : ${signer.address}`);
  log(`Contract : ${CONTRACT}`);
  log(`Solver   : ${SOLVER_PATH}`);

  // Get initial epoch/difficulty
  await refreshEpoch();
  if (currentEpoch < 0n) {
    log('[FATAL] Cannot read epoch/difficulty from contract');
    process.exit(1);
  }

  // Find mine() selector
  MINE_SEL = await findMineSel(provider);

  // Poll for epoch changes every 15s
  setInterval(refreshEpoch, 15_000);

  // Start solving
  startSolver();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
