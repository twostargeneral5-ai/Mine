'use strict';
const { ethers } = require('ethers');
const { spawn }  = require('child_process');
const path       = require('path');
const readline   = require('readline');
const fs         = require('fs');

const RPC_URL     = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const LOG_INT     = parseInt(process.env.LOG_INTERVAL || '5');
const MAX_GAS     = parseInt(process.env.MAX_GAS_GWEI || '30');
const CHAIN_ID    = 1n;

const SOLVER_PATH = process.env.SOLVER ||
  ['/app/lean25','/app/solver/lean25',
   path.join(__dirname,'..','lean25'),
   path.join(__dirname,'..','solver','lean25')]
  .find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
  || '/app/lean25';

if (!RPC_URL || !PRIVATE_KEY) {
  console.error('[FATAL] Set RPC_URL and PRIVATE_KEY'); process.exit(1);
}

/* ── Auto-probe: find which contract + functions actually work ─── */
const CONTRACTS = [
  '0xa9951Cfb634dc103472FC51DD106cBb7E53f60Cc',
  '0x9cF531798F8468483557d18F4172eDd6Bd2360cc',
];
const EPOCH_NAMES = [
  'epoch()','currentEpoch()','getEpoch()','epochNumber()',
  'miningEpoch()','epochId()','getCurrentEpoch()',
];
const DIFF_NAMES = [
  'activeDifficulty()','epochDifficulty()','difficulty()',
  'currentDifficulty()','getDifficulty()','targetDifficulty()',
  'miningDifficulty()','getActiveDifficulty()',
];
const MINE_SIGS = [
  'mine(uint256,uint256[])',
  'mine(uint256,uint32[])',
  'mine(uint256,uint32[42])',
  'submitProof(uint256,uint256[])',
  'submit(uint256,uint256[])',
];

async function probe(provider) {
  console.log('\n══ CONTRACT PROBE ══');
  let bestContract = null, epochFn = null, diffFn = null, mineFn = null;

  for (const addr of CONTRACTS) {
    console.log(`\n[PROBE] Trying contract: ${addr}`);

    // Check if contract exists
    const code = await provider.getCode(addr);
    if (code === '0x') { console.log('  ✗ No code at this address'); continue; }
    console.log(`  ✓ Contract exists (${code.length/2-1} bytes)`);

    let foundEpoch = null, foundDiff = null;

    for (const fn of EPOCH_NAMES) {
      const sel = ethers.id(fn).slice(0,10);
      try {
        const r = await provider.call({ to: addr, data: sel });
        if (r && r !== '0x') {
          console.log(`  ✅ ${fn} → ${BigInt(r)}`);
          if (!foundEpoch) foundEpoch = fn;
        } else {
          console.log(`  ⬜ ${fn} → empty`);
        }
      } catch { console.log(`  ❌ ${fn} → revert`); }
    }

    for (const fn of DIFF_NAMES) {
      const sel = ethers.id(fn).slice(0,10);
      try {
        const r = await provider.call({ to: addr, data: sel });
        if (r && r !== '0x') {
          console.log(`  ✅ ${fn} → 0x${BigInt(r).toString(16).slice(0,12)}…`);
          if (!foundDiff) foundDiff = fn;
        } else {
          console.log(`  ⬜ ${fn} → empty`);
        }
      } catch { console.log(`  ❌ ${fn} → revert`); }
    }

    for (const sig of MINE_SIGS) {
      const sel = ethers.id(sig).slice(0,10);
      const bcode = await provider.getCode(addr);
      if (bcode.includes(sel.slice(2))) {
        console.log(`  ✅ mine sig match: ${sig}`);
        if (!mineFn) mineFn = sig;
      } else {
        console.log(`  ⬜ mine sig not in bytecode: ${sig}`);
      }
    }

    if (foundEpoch && !bestContract) {
      bestContract = addr; epochFn = foundEpoch; diffFn = foundDiff;
    }
  }

  console.log('\n══ PROBE RESULTS ══');
  if (bestContract) {
    console.log(`CONTRACT : ${bestContract}`);
    console.log(`EPOCH FN : ${epochFn}`);
    console.log(`DIFF FN  : ${diffFn}`);
    console.log(`MINE SIG : ${mineFn}`);
  } else {
    console.log('NO WORKING CONTRACT FOUND.');
    console.log('Possible issues:');
    console.log('  1. V2 contract not yet deployed on mainnet');
    console.log('  2. Wrong chain (check if hash256 uses Base/Arbitrum)');
    console.log('  3. Alchemy key rate-limited');
  }
  console.log('══════════════════\n');

  return { bestContract, epochFn, diffFn, mineFn };
}

/* ── State ───────────────────────────────────────────────────── */
let provider, signer, contract;
let CONTRACT_ADDR, EPOCH_FN, DIFF_FN, MINE_FN;
let currentEpochNum = -1n, currentDiff = 0n, currentChallenge = null;
let nonce = 0, attempted = 0, solved = 0, submitted = 0;
const startTime = Date.now();

function log(...a) { console.log(`[${((Date.now()-startTime)/1000).toFixed(0)}s]`,...a); }

function computeChallenge(epoch) {
  return ethers.solidityPackedKeccak256(
    ['uint256','address','address','uint256'],
    [CHAIN_ID, CONTRACT_ADDR, signer.address, epoch]
  );
}
function computeSeed(challenge, n) {
  return ethers.solidityPackedKeccak256(
    ['bytes32','uint256'],[challenge, BigInt(n)]
  ).slice(2);
}
function checkDiff(challenge, proof) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32','uint256[]'],[challenge, proof.map(BigInt)]
  );
  return BigInt(ethers.keccak256(encoded)) < currentDiff;
}

async function refreshEpoch() {
  try {
    const ep   = await provider.call({ to: CONTRACT_ADDR, data: ethers.id(EPOCH_FN).slice(0,10) });
    const diff = await provider.call({ to: CONTRACT_ADDR, data: ethers.id(DIFF_FN).slice(0,10) });
    const epNum  = BigInt(ep);
    const diffNum = BigInt(diff);
    if (epNum !== currentEpochNum) {
      currentEpochNum  = epNum;
      currentDiff      = diffNum;
      currentChallenge = computeChallenge(epNum);
      nonce = 0;
      log(`★ Epoch ${epNum}  diff=0x${diffNum.toString(16).slice(0,10)}…`);
    }
  } catch(e) { log('[WARN] epoch refresh:', e.message?.slice(0,80)); }
}

async function submitSolution(n, proof) {
  try {
    const abi = [`function ${MINE_FN || 'mine(uint256,uint256[])'} external`]
      .map(x => x.replace('mine(uint256,uint256[])','mine(uint256 nonce, uint256[] calldata edges)'));
    const c = new ethers.Contract(CONTRACT_ADDR, [
      'function mine(uint256 nonce, uint256[] calldata edges) external'
    ], signer);
    const gp = (await provider.getFeeData()).gasPrice;
    if (Number(gp/10n**9n) > MAX_GAS) { log('[SKIP] gas too high'); return; }
    log(`[TX] mine nonce=${n}`);
    const tx = await c.mine(BigInt(n), proof.map(BigInt), { gasLimit: 600_000n });
    log(`[TX] sent ${tx.hash}`);
    const r = await tx.wait(1);
    if (r.status===1) {
      submitted++;
      log(`✅ MINED! block=${r.blockNumber}`);
    } else log('[WARN] tx reverted');
  } catch(e) { log('[ERR] submit:', e.message?.slice(0,120)); }
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
      if (parts.length===42) {
        solved++;
        const n = nonce-1;
        log(`[CYCLE] nonce=${n} solved=${solved}`);
        if (currentChallenge && checkDiff(currentChallenge, parts)) {
          log('[DIFF] ✓ passes!');
          await submitSolution(n, parts);
        } else log('[DIFF] ✗ not met');
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
  if (n%LOG_INT===0) {
    const rate=(attempted/((Date.now()-startTime)/60000)).toFixed(1);
    log(`[MINE] nonce=${n} epoch=${currentEpochNum} ~${rate}/min solved=${solved}`);
  }
  proc.stdin.write(computeSeed(currentChallenge,n)+'\n');
}

async function main() {
  log('═══════════════════════════════════════');
  log(' Hash256 V2 Miner  –  Cuckoo Cycle 25 ');
  log('═══════════════════════════════════════');

  provider = new ethers.JsonRpcProvider(RPC_URL);
  signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  log(`Wallet : ${signer.address}`);
  log(`Solver : ${SOLVER_PATH}`);

  // Auto-probe to find correct contract + functions
  const { bestContract, epochFn, diffFn, mineFn } = await probe(provider);

  if (!bestContract || !epochFn) {
    log('[FATAL] Could not find working contract. See PROBE RESULTS above.');
    process.exit(1);
  }

  CONTRACT_ADDR = bestContract;
  EPOCH_FN      = epochFn;
  DIFF_FN       = diffFn || 'activeDifficulty()';
  MINE_FN       = mineFn;

  await refreshEpoch();
  setInterval(refreshEpoch, 30_000);
  startSolver();
}

main().catch(e => { console.error('[FATAL]',e); process.exit(1); });
