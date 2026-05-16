/**
 * Hash256 V2 – Node.js Miner Orchestrator
 * Spawns the C lean solver, feeds it seeds, submits winning cycles on-chain.
 */

'use strict';

const { ethers }   = require('ethers');
const { spawn }    = require('child_process');
const path         = require('path');
const readline     = require('readline');
const fs           = require('fs');

/* ── config ─────────────────────────────────────────────────────── */
const RPC_URL       = process.env.RPC_URL;
const PRIVATE_KEY   = process.env.PRIVATE_KEY;
const CONTRACT_ADDR = process.env.CONTRACT || '0xa9951Cfb634dc103472FC51DD106cBb7E53f60Cc';
const CHAIN_ID      = 1n;
const LOG_INTERVAL  = parseInt(process.env.LOG_INTERVAL || '5');
const MAX_GAS_GWEI  = parseInt(process.env.MAX_GAS_GWEI || '30');

// Find solver binary wherever it was placed
const SOLVER_PATH = process.env.SOLVER ||
  ['/app/lean25', '/app/solver/lean25',
   path.join(__dirname, '..', 'lean25'),
   path.join(__dirname, '..', 'solver', 'lean25')]
  .find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } })
  || '/app/lean25';

if (!RPC_URL || !PRIVATE_KEY) {
  console.error('[FATAL] Set RPC_URL and PRIVATE_KEY in environment.');
  process.exit(1);
}

/* ── ABI (matched to actual contract function names) ────────────── */
const ABI = [
  'function currentEpoch()      view returns (uint256)',
  'function activeDifficulty()  view returns (uint256)',
  'function currentReward()     view returns (uint256)',
  'function balanceOf(address)  view returns (uint256)',
  'function mine(uint256 nonce, uint256[] calldata edges) external',
  'event Mined(address indexed miner, uint256 nonce, uint256 reward)',
];

/* ── state ──────────────────────────────────────────────────────── */
let provider, signer, contract;
let currentEpochNum  = -1n;
let currentDiff      = 0n;
let currentChallenge = null;
let nonce            = 0;
let attempted        = 0;
let solved           = 0;
let submitted        = 0;
let startTime        = Date.now();

/* ── helpers ────────────────────────────────────────────────────── */
function log(...args) {
  const s = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`[${s}s]`, ...args);
}

function computeChallenge(epoch) {
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'address', 'uint256'],
    [CHAIN_ID, CONTRACT_ADDR, signer.address, epoch]
  );
}

function computeSeed(challenge, n) {
  return ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256'],
    [challenge, BigInt(n)]
  ).slice(2); // strip 0x → 64 hex chars for C solver
}

function checkDifficulty(challenge, proof) {
  // keccak256(challenge || edges as uint256[]) < activeDifficulty
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256[]'],
    [challenge, proof.map(BigInt)]
  );
  const hash = ethers.keccak256(encoded);
  return BigInt(hash) < currentDiff;
}

/* ── chain polling ──────────────────────────────────────────────── */
async function refreshEpoch() {
  try {
    const [ep, diff] = await Promise.all([
      contract.currentEpoch(),
      contract.activeDifficulty(),
    ]);
    if (ep !== currentEpochNum) {
      currentEpochNum  = ep;
      currentDiff      = diff;
      currentChallenge = computeChallenge(ep);
      nonce            = 0;
      log(`★ New epoch ${ep}  diff=${diff.toString(16).slice(0,12)}…  challenge=${currentChallenge.slice(0,18)}…`);
    }
  } catch (e) {
    log('[WARN] epoch refresh failed:', e.message?.slice(0, 100));
  }
}

/* ── submission ─────────────────────────────────────────────────── */
async function submitSolution(n, proof) {
  try {
    const gasPrice   = (await provider.getFeeData()).gasPrice;
    const gasPriceGw = Number(gasPrice / 10n**9n);
    if (gasPriceGw > MAX_GAS_GWEI) {
      log(`[SKIP] gas ${gasPriceGw} gwei > MAX_GAS_GWEI, skipping`);
      return;
    }
    log(`[TX] Submitting nonce=${n}  edges[0..2]=${proof.slice(0,3).join(',')}`);
    const tx = await contract.mine(BigInt(n), proof.map(BigInt), { gasLimit: 600_000n });
    log(`[TX] Sent  ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (receipt.status === 1) {
      submitted++;
      const bal = await contract.balanceOf(signer.address);
      log(`✅ MINED!  block=${receipt.blockNumber}  balance=${ethers.formatUnits(bal,18)} HASH`);
    } else {
      log('[WARN] tx reverted');
    }
  } catch (err) {
    log('[ERR] submit:', err.message?.slice(0, 150));
  }
}

/* ── solver process ─────────────────────────────────────────────── */
function startSolver() {
  log(`[SOLVER] Starting binary: ${SOLVER_PATH}`);

  const proc = spawn(SOLVER_PATH, [], { stdio: ['pipe', 'pipe', 'inherit'] });

  proc.on('error', err => {
    console.error('[FATAL] Cannot start solver:', err.message);
    process.exit(1);
  });

  proc.on('exit', code => {
    log(`[SOLVER] exited (${code}), restarting in 2s…`);
    setTimeout(startSolver, 2000);
  });

  const rl = readline.createInterface({ input: proc.stdout });

  rl.on('line', async line => {
    line = line.trim();
    if (line.startsWith('CYCLE')) {
      const parts = line.split(' ').slice(1).map(Number);
      if (parts.length === 42) {
        solved++;
        const n = nonce - 1;
        log(`[CYCLE] found nonce=${n} (solved=${solved})`);
        if (currentChallenge && checkDifficulty(currentChallenge, parts)) {
          log('[DIFF] ✓ passes difficulty!');
          await submitSolution(n, parts);
        } else {
          log('[DIFF] ✗ cycle found, difficulty not met — continuing');
        }
      }
    }
    feedNext(proc);
  });

  feedNext(proc);
  return proc;
}

function feedNext(proc) {
  if (!currentChallenge) {
    setTimeout(() => feedNext(proc), 500);
    return;
  }
  const n = nonce++;
  attempted++;
  if (n % LOG_INTERVAL === 0) {
    const rate = (attempted / ((Date.now() - startTime) / 60000)).toFixed(1);
    log(`[MINE] nonce=${n}  epoch=${currentEpochNum}  ~${rate}/min  solved=${solved}  submitted=${submitted}`);
  }
  proc.stdin.write(computeSeed(currentChallenge, n) + '\n');
}

/* ── main ───────────────────────────────────────────────────────── */
async function main() {
  log('═══════════════════════════════════════');
  log(' Hash256 V2 Miner  –  Cuckoo Cycle 25 ');
  log('═══════════════════════════════════════');

  provider = new ethers.JsonRpcProvider(RPC_URL);
  signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  contract = new ethers.Contract(CONTRACT_ADDR, ABI, signer);

  log(`Wallet  : ${signer.address}`);
  log(`RPC     : ${RPC_URL}`);
  log(`Contract: ${CONTRACT_ADDR}`);
  log(`Solver  : ${SOLVER_PATH}`);

  await refreshEpoch();

  if (currentEpochNum < 0n) {
    log('[FATAL] Could not fetch epoch. Check RPC_URL and CONTRACT.');
    process.exit(1);
  }

  setInterval(refreshEpoch, 30_000);

  startSolver();
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
