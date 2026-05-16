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

const SOLVER_PATH = process.env.SOLVER ||
  ['/app/lean25','/app/solver/lean25',
   path.join(__dirname,'..','lean25'),
   path.join(__dirname,'..','solver','lean25')]
  .find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
  || '/app/lean25';

if (!RPC_URL || !PRIVATE_KEY) {
  console.error('[FATAL] Set RPC_URL and PRIVATE_KEY'); process.exit(1);
}

// Known function signatures lookup (4-byte selector → name)
const KNOWN_SIGS = {
  '900cf0cf': 'epoch()',
  '76671808': 'currentEpoch()',
  '9b19251a': 'activeDifficulty()',
  '6de9f32b': 'currentDifficulty()',
  '26ef699d': 'mine(uint256,uint256[])',
  'b88d4fde': 'mine(uint256,uint32[42])',
  '1249c58b': 'mint()',
  'a0712d68': 'mint(uint256)',
  '4e6ec247': 'mine(bytes32,uint256[])',
  '3ccfd60b': 'withdraw()',
  '06fdde03': 'name()',
  '95d89b41': 'symbol()',
  '18160ddd': 'totalSupply()',
  '70a08231': 'balanceOf(address)',
  '313ce567': 'decimals()',
  'f2fde38b': 'transferOwnership(address)',
  '8da5cb5b': 'owner()',
  '5c975abb': 'paused()',
  'd5abeb01': 'maxSupply()',
  'b187bd26': 'isMintingEnabled()',
  '54fd4d50': 'version()',
  'fc0c546a': 'token()',
  '8456cb59': 'pause()',
  '3f4ba83a': 'unpause()',
  'dd62ed3e': 'allowance(address,address)',
  'a9059cbb': 'transfer(address,uint256)',
  '23b872dd': 'transferFrom(address,address,uint256)',
};

async function extractSelectors(provider, addr) {
  const bytecode = await provider.getCode(addr);
  if (bytecode === '0x') return [];
  
  const hex = bytecode.slice(2);
  const selectors = new Set();
  
  // Scan for PUSH4 (0x63) followed by 4 bytes — these are likely function selectors
  for (let i = 0; i < hex.length - 10; i += 2) {
    if (hex.slice(i, i+2) === '63') {
      const sel = hex.slice(i+2, i+10);
      selectors.add(sel);
    }
  }
  return [...selectors];
}

async function probe(provider) {
  const CONTRACT = '0xa9951Cfb634dc103472FC51DD106cBb7E53f60Cc';
  console.log('\n══ DEEP CONTRACT PROBE ══');
  console.log(`Contract: ${CONTRACT}\n`);

  const bytecode = await provider.getCode(CONTRACT);
  console.log(`Bytecode size: ${bytecode.length/2 - 1} bytes`);

  const selectors = await extractSelectors(provider, CONTRACT);
  console.log(`\nAll function selectors found in bytecode (${selectors.length}):`);

  for (const sel of selectors) {
    const known = KNOWN_SIGS[sel] || '???';
    // Try calling it
    try {
      const result = await provider.call({ to: CONTRACT, data: '0x' + sel });
      if (result && result !== '0x' && result.length > 2) {
        let decoded = 'raw:' + result.slice(0,18) + '…';
        try { decoded = BigInt(result).toString(); } catch {}
        console.log(`  ✅ 0x${sel}  ${known.padEnd(35)} → ${decoded}`);
      } else {
        console.log(`  ⬜ 0x${sel}  ${known.padEnd(35)} → empty/void`);
      }
    } catch {
      console.log(`  🔒 0x${sel}  ${known.padEnd(35)} → needs args`);
    }
  }

  // Also get current block for epoch calculation
  const block = await provider.getBlockNumber();
  console.log(`\nCurrent block: ${block}`);
  console.log(`Epoch (block/1000): ${Math.floor(block/1000)}`);
  console.log(`Epoch (block/500):  ${Math.floor(block/500)}`);
  console.log(`Epoch (block/2000): ${Math.floor(block/2000)}`);
  console.log('\n══ END PROBE ══\n');

  return selectors;
}

// ── State ─────────────────────────────────────────────────────
let provider, signer;
let CONTRACT_ADDR = '0xa9951Cfb634dc103472FC51DD106cBb7E53f60Cc';
let MINE_SEL      = null;  // will be set after probe
let currentDiff   = 0n;
let currentEpoch  = 0n;
let currentChallenge = null;
let nonce = 0, attempted = 0, solved = 0, submitted = 0;
const startTime = Date.now();

function log(...a) { console.log(`[${((Date.now()-startTime)/1000).toFixed(0)}s]`,...a); }

function computeEpoch(blockNum) { return BigInt(Math.floor(blockNum / 1000)); }

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
  const enc = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32','uint256[]'],[challenge, proof.map(BigInt)]
  );
  return BigInt(ethers.keccak256(enc)) < currentDiff;
}

async function refreshEpoch() {
  try {
    const block = await provider.getBlockNumber();
    const ep    = computeEpoch(block);

    // Read difficulty
    const diffData = await provider.call({
      to: CONTRACT_ADDR,
      data: '0x9b19251a'  // activeDifficulty()
    });
    const diff = BigInt(diffData);

    if (ep !== currentEpoch || diff !== currentDiff) {
      currentEpoch = ep;
      currentDiff  = diff;
      currentChallenge = computeChallenge(ep);
      nonce = 0;
      log(`★ Block ${block}  Epoch ${ep}  diff=0x${diff.toString(16).slice(0,12)}…`);
    }
  } catch(e) { log('[WARN] refresh:', e.message?.slice(0,80)); }
}

async function submitSolution(n, proof) {
  if (!MINE_SEL) { log('[SKIP] mine() selector unknown — check probe output above'); return; }
  try {
    const gp = (await provider.getFeeData()).gasPrice;
    if (Number(gp / 10n**9n) > MAX_GAS) { log('[SKIP] gas too high'); return; }

    // Encode: mine(uint256 nonce, uint256[] edges)
    const data = MINE_SEL +
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256','uint256[]'],
        [BigInt(n), proof.map(BigInt)]
      ).slice(2);

    log(`[TX] mine nonce=${n} sel=${MINE_SEL}`);
    const tx = await signer.sendTransaction({
      to: CONTRACT_ADDR, data, gasLimit: 600_000n
    });
    log(`[TX] sent ${tx.hash}`);
    const r = await tx.wait(1);
    if (r.status === 1) {
      submitted++;
      log(`✅ MINED! block=${r.blockNumber}`);
    } else {
      log('[WARN] tx reverted — mine() selector might be wrong');
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
  if (n % LOG_INT === 0) {
    const rate = (attempted/((Date.now()-startTime)/60000)).toFixed(1);
    log(`[MINE] nonce=${n} epoch=${currentEpoch} ~${rate}/min solved=${solved}`);
  }
  proc.stdin.write(computeSeed(currentChallenge, n) + '\n');
}

async function main() {
  log('═══════════════════════════════════════');
  log(' Hash256 V2 Miner  –  Cuckoo Cycle 25 ');
  log('═══════════════════════════════════════');

  provider = new ethers.JsonRpcProvider(RPC_URL);
  signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  log(`Wallet : ${signer.address}`);

  // Deep probe — prints ALL selectors in bytecode
  const selectors = await probe(provider);

  // Try to identify the mine() selector from what's in bytecode
  // Remove known read-only / ERC20 selectors
  const READONLY = new Set([
    '06fdde03','95d89b41','18160ddd','70a08231','313ce567',
    '8da5cb5b','5c975abb','d5abeb01','b187bd26','54fd4d50',
    '9b19251a','6de9f32b','fc0c546a','dd62ed3e','900cf0cf',
    '76671808','3ccfd60b',
  ]);
  const writeSels = selectors.filter(s => !READONLY.has(s));
  log(`\nPossible write functions (${writeSels.length}): ${writeSels.map(s=>'0x'+s).join('  ')}`);
  log('→ The mine() function is likely one of these. Check probe output above.\n');

  // Use the first unknown write selector as mine() candidate
  // (Override with MINE_SELECTOR env var once identified)
  if (process.env.MINE_SELECTOR) {
    MINE_SEL = process.env.MINE_SELECTOR;
    log(`[CONFIG] Using MINE_SELECTOR=${MINE_SEL}`);
  } else if (writeSels.length > 0) {
    MINE_SEL = writeSels[0];
    log(`[GUESS] Using first write selector as mine(): 0x${MINE_SEL}`);
  }

  await refreshEpoch();
  setInterval(refreshEpoch, 15_000);
  startSolver();
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
