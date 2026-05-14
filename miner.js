// miner.js — main thread: fetches challenge, spawns WASM workers, submits solution
const { ethers } = require("ethers");
const { Worker } = require("worker_threads");
const path = require("path");
const os = require("os");

// ── CONFIG ──────────────────────────────────────────────
const RPC_URL          = process.env.RPC_URL;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const WALLETS = [
  { address: "0xb6aDCA24b2863b020Fc7A557BD7D03f37b17fd8B", privateKey: process.env.PK_1 },
  { address: "0xb854d024304ff23b907551e1fa9e4c7cdb2cf380", privateKey: process.env.PK_2 },
  { address: "0xad31851a46d00e2b49f05f9eb63f8bd61b00a21d", privateKey: process.env.PK_3 },
  { address: "0xec3c406217c59ab659ab5b089ba17e78cec3e63e", privateKey: process.env.PK_4 },
  { address: "0xbb9c6a8108ca06f1bad5eb22dc12a03ee52e1c34", privateKey: process.env.PK_5 },
  { address: "0x2491b9ba4a6aba33af033a6e77b87c9f02c0cf70", privateKey: process.env.PK_6 },
];

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function currentDifficulty() view returns (uint256)",
  "function epochBlocksLeft() view returns (uint256)",
  "function mine(bytes32 nonce) external",
];

const THREADS = Math.max(2, os.cpus().length - 1);
// ────────────────────────────────────────────────────────

async function mineForWallet(wallet, idx) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(wallet.privateKey, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

  console.log(`\n[W${idx + 1}] ${wallet.address} | ${THREADS} WASM threads`);

  while (true) {
    try {
      const [challenge, difficulty, blocksLeft] = await Promise.all([
        contract.getChallenge(wallet.address),
        contract.currentDifficulty(),
        contract.epochBlocksLeft(),
      ]);

      console.log(`\n[W${idx + 1}] Challenge:   ${challenge.slice(0, 14)}...`);
      console.log(`[W${idx + 1}] Difficulty:  ${difficulty.toString().slice(0, 14)}...`);
      console.log(`[W${idx + 1}] Epoch left:  ${blocksLeft} blocks`);
      console.log(`[W${idx + 1}] Mining...`);

      const startTime = Date.now();
      let totalTries = 0;
      const epochMs = Math.max(30000, Number(blocksLeft) * 12000);

      const result = await new Promise((resolve, reject) => {
        const workers = [];

        const epochTimer = setTimeout(() => {
          workers.forEach(w => w.terminate());
          resolve({ epochRotated: true });
        }, epochMs);

        for (let t = 0; t < THREADS; t++) {
          const w = new Worker(path.join(__dirname, "worker.js"), {
            workerData: {
              challenge,
              difficulty: difficulty.toString(),
              threadId:   t,
              totalThreads: THREADS,
            },
          });
          workers.push(w);

          w.on("message", msg => {
            if (msg.found) {
              clearTimeout(epochTimer);
              workers.forEach(x => x.terminate());
              resolve(msg);
            } else {
              totalTries += msg.tries;
              const elapsed = (Date.now() - startTime) / 1000;
              const mhs = (totalTries / elapsed / 1e6).toFixed(2);
              process.stdout.write(
                `\r[W${idx + 1}] ${mhs} MH/s | ${(totalTries / 1e6).toFixed(1)}M hashes | ${Math.floor(elapsed)}s`
              );
            }
          });

          w.on("error", err => {
            console.error(`\n[W${idx + 1}] Worker error: ${err.message}`);
          });
        }
      });

      if (result.epochRotated) {
        console.log(`\n[W${idx + 1}] Epoch rotated — refreshing challenge...`);
        continue;
      }

      console.log(`\n[W${idx + 1}] ✅ SOLUTION FOUND! Nonce: ${result.nonce}`);
      console.log(`[W${idx + 1}] Submitting transaction...`);

      try {
        const tx = await contract.mine(result.nonce, {
          gasLimit: 200000,
          maxFeePerGas:         ethers.parseUnits("20", "gwei"),
          maxPriorityFeePerGas: ethers.parseUnits("3",  "gwei"),
        });
        console.log(`[W${idx + 1}] TX sent: ${tx.hash}`);
        const receipt = await tx.wait();
        if (receipt.status === 1) {
          console.log(`\n🎉🎉 [W${idx + 1}] 100 HASH MINED! Block: ${receipt.blockNumber} TX: ${tx.hash} 🎉🎉\n`);
        } else {
          console.log(`[W${idx + 1}] ❌ TX reverted — epoch may have shifted. Retrying...`);
        }
      } catch (e) {
        console.log(`[W${idx + 1}] ❌ TX error: ${e.message.slice(0, 100)}`);
      }

      await new Promise(r => setTimeout(r, 3000));

    } catch (e) {
      console.error(`\n[W${idx + 1}] Error: ${e.message.slice(0, 120)}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

async function main() {
  if (!RPC_URL) { console.error("❌ RPC_URL not set!"); process.exit(1); }

  const active = WALLETS.filter(w => w.privateKey);
  if (!active.length) { console.error("❌ No private keys! Set PK_1 in env vars."); process.exit(1); }

  console.log("=".repeat(55));
  console.log("  HASH256 WASM MINER — keccak256 via WebAssembly");
  console.log(`  Threads: ${THREADS} | Active wallets: ${active.length}`);
  console.log(`  Contract: ${CONTRACT_ADDRESS}`);
  console.log("=".repeat(55));

  await Promise.all(active.map((w, i) => mineForWallet(w, i)));
}

main().catch(console.error);
