/**
 * Hash256 V2 – Node.js Miner Orchestrator
 * Spawns the C lean solver, feeds it seeds, submits winning cycles on-chain.
 */

'use strict';

const { ethers }   = require('ethers');
const { spawn }    = require('child_process');
const path         = require('path');
const readline     = require('readline');

/* ── config (from .env) ─────────────────────────────────────────── */
const RPC_URL        = process.env.RPC_URL;
const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const CONTRACT_ADDR  = process.env.CONTRACT || '0xa9951Cfb634dc103472FC51DD106cBb7E53f60Cc';
const CHAIN_ID       = 1n;
const SOLVER_PATH    = process.env.SOLVER || path.join(__dirname, '..', 'solver', 'lean25');
const LOG_INTERVAL   = parseInt(process.env.LOG_INTERVAL  || '10');   // log every N nonces
const MAX_GAS_GWEI   = parseInt(process.env.MAX_GAS_GWEI  || '30');   // skip tx if gas > this

if (!RPC_URL || !PRIVATE_KEY) {
  console.error('[FATAL] Set RPC_URL and PRIVATE_KEY in environment.');
  process.exit(1);
}

/* ── contract ABI ───────────────────────────────────────────────── */
const ABI = [
  'function epoch()                               view returns (uint256)',
  'function epochDifficulty()                     view returns (uint256)',
  'function totalSupply()                         view returns (uint256)',
  'function balanceOf(address)                    view returns (uint256)',
  // V2 mine:  mine(uint256 nonce, uint32[42] proof)
  'function mine(uint256 nonce, uint32[42] calldata proof) external',
  'event Mined(address indexed miner, uint256 indexed epoch, uint256 reward)',
];

/* ── state ──────────────────────────────────────────────────────── */
let provider, signer, contract;
let currentEpoch     = -1n;
let currentDifficulty = 0n;
let currentChallenge  = null;   // bytes32 hex string
let nonce            = 0;
let attempted        = 0;
let solved           = 0;
let submitted        = 0;
let startTime        = Date.now();

/* ── helpers ────────────────────────────────────────────────────── */
function log(...args) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`[${elapsed}s]`, ...args);
}

function computeChallenge(epoch) {
  // challenge = keccak256(abi.encodePacked(chainId, contract, miner, epoch))
  return ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'address', 'uint256'],
    [CHAIN_ID, CONTRACT_ADDR, signer.address, epoch]
  );
}

function computeSeed(challenge, n) {
  // seed = keccak256(abi.encodePacked(challenge, nonce))
  // This seeds the Cuckoo graph for attempt n
  return ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256'],
    [challenge, BigInt(n)]
  ).slice(2); // strip '0x' → 64 hex chars for C solver
}

function checkDifficulty(challenge, proof) {
  // valid iff keccak256(challenge || edges_packed) < epochDifficulty
  // edges are uint32[42], ABI-encoded (no padding needed for packed)
  const edgesHex = proof.map(e => e.toString(16).padStart(8, '0')).join('');
  const hash = ethers.keccak256(challenge + edgesHex);
  return BigInt(hash) < currentDifficulty;
}

/* ── chain polling ──────────────────────────────────────────────── */
async function refreshEpoch() {
  try {
    const [ep, diff] = await Promise.all([
      contract.epoch(),
      contract.epochDifficulty(),
    ]);
    if (ep !== currentEpoch) {
      currentEpoch      = ep;
      currentDifficulty = diff;
      currentChallenge  = computeChallenge(ep);
      nonce             = 0;  // reset nonce for new epoch
      log(`★ New epoch ${ep}  difficulty=${diff.toString(16).slice(0,12)}…  challenge=${currentChallenge.slice(0,18)}…`);
    }
  } catch (e) {
    log('[WARN] epoch refresh failed:', e.message);
  }
}

/* ── submission ─────────────────────────────────────────────────── */
async function submitSolution(n, proof) {
  try {
    const gasPrice = (await provider.getFeeData()).gasPrice;
    const gasPriceGwei = Number(gasPrice / 10n**9n);
    if (gasPriceGwei > MAX_GAS_GWEI) {
      log(`[SKIP] gas ${gasPriceGwei} gwei > MAX_GAS_GWEI ${MAX_GAS_GWEI}`);
      return;
    }

    log(`[TX] Submitting  nonce=${n}  edges=[${proof[0]},${proof[1]},...,${proof[41]}]`);
    const tx = await contract.mine(BigInt(n), proof, {
      gasLimit: 500_000n,
    });
    log(`[TX] Sent  hash=${tx.hash}`);
    const receipt = await tx.wait(1);
    if (receipt.status === 1) {
      submitted++;
      const bal = await contract.balanceOf(signer.address);
      log(`✅ MINED!  block=${receipt.blockNumber}  balance=${ethers.formatUnits(bal,18)} HASH`);
    } else {
      log(`[WARN] tx reverted  hash=${tx.hash}`);
    }
  } catch (err) {
    log('[ERR] submit failed:', err.message?.slice(0, 120));
  }
}

/* ── solver process ─────────────────────────────────────────────── */
function startSolver() {
  log(`[SOLVER] Starting  ${SOLVER_PATH}`);
  const proc = spawn(SOLVER_PATH, [], { stdio: ['pipe', 'pipe', 'inherit'] });

  proc.on('error', err => {
    console.error('[FATAL] Cannot start solver:', err.message);
    console.error('  → Make sure the binary was compiled (check Dockerfile / build step)');
    process.exit(1);
  });

  proc.on('exit', (code) => {
    log(`[SOLVER] exited with code ${code}, restarting in 2s…`);
    setTimeout(startSolver, 2000);
  });

  const rl = readline.createInterface({ input: proc.stdout });

  rl.on('line', async (line) => {
    line = line.trim();

    if (line.startsWith('CYCLE')) {
      const parts = line.split(' ').slice(1).map(Number);
      if (parts.length === 42) {
        solved++;
        const n = nonce - 1;  // nonce already incremented
        log(`[CYCLE] found at nonce ${n}  (solved=${solved})`);

        // difficulty check
        if (currentChallenge && checkDifficulty(currentChallenge, parts)) {
          log(`[DIFF ] ✓ passes difficulty!`);
          await submitSolution(n, parts);
        } else {
          log(`[DIFF ] ✗ cycle found but difficulty not met, continuing…`);
        }
      }
    } else if (line === 'NONE') {
      // No cycle for this nonce — normal, continue
    }

    // Feed next seed
    feedNext(proc);
  });

  // Feed the very first seed
  feedNext(proc);

  return proc;
}

function feedNext(proc) {
  if (!currentChallenge) {
    // Chain not ready yet, retry shortly
    setTimeout(() => feedNext(proc), 500);
    return;
  }

  const n = nonce++;
  attempted++;

  if (n % LOG_INTERVAL === 0) {
    const rate = (attempted / ((Date.now() - startTime) / 1000 / 60)).toFixed(1);
    log(`[MINE ] nonce=${n}  epoch=${currentEpoch}  rate~${rate}/min  solved=${solved}  submitted=${submitted}`);
  }

  const seed = computeSeed(currentChallenge, n);
  proc.stdin.write(seed + '\n');
}

/* ── entry point ────────────────────────────────────────────────── */
async function main() {
  log('═══════════════════════════════════════');
  log(' Hash256 V2 Miner  –  Cuckoo Cycle 25 ');
  log('═══════════════════════════════════════');

  provider = new ethers.JsonRpcProvider(RPC_URL);
  signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  contract = new ethers.Contract(CONTRACT_ADDR, ABI, signer);

  log(`Wallet : ${signer.address}`);
  log(`RPC    : ${RPC_URL}`);
  log(`Contract: ${CONTRACT_ADDR}`);

  // Initial epoch fetch
  await refreshEpoch();
  if (currentEpoch < 0n) {
    log('[FATAL] Could not fetch epoch. Check RPC_URL and CONTRACT address.');
    process.exit(1);
  }

  // Poll for epoch changes every 30s
  setInterval(refreshEpoch, 30_000);

  // Listen for Mined events (to know when others mine)
  contract.on('Mined', (miner, epoch, reward) => {
    if (miner.toLowerCase() === signer.address.toLowerCase()) return;
    log(`[EVENT] Other miner hit epoch ${epoch}  miner=${miner.slice(0,10)}…`);
  });

  // Start the C solver loop
  startSolver();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
