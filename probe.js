/**
 * Hash256 Contract Prober
 * Run: node probe.js
 * Tries all common function name patterns and reports which ones work.
 */
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error('Set RPC_URL env var'); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC_URL);

// Both possible contract addresses
const CONTRACTS = [
  '0xa9951Cfb634dc103472FC51DD106cBb7E53f60Cc',
  '0x9cF531798F8468483557d18F4172eDd6Bd2360cc',
];

// All plausible read function names to probe
const CANDIDATES = [
  'epoch()',
  'currentEpoch()',
  'getEpoch()',
  'epochNumber()',
  'miningEpoch()',
  'epochId()',
  'epochDifficulty()',
  'activeDifficulty()',
  'difficulty()',
  'currentDifficulty()',
  'getDifficulty()',
  'targetDifficulty()',
  'miningDifficulty()',
  'currentReward()',
  'reward()',
  'rewardPerMint()',
  'mintReward()',
  'totalMints()',
  'totalMiningMinted()',
  'totalSupply()',
];

async function probe() {
  for (const addr of CONTRACTS) {
    console.log(`\n══════════════════════════════`);
    console.log(`Contract: ${addr}`);
    console.log(`══════════════════════════════`);

    for (const sig of CANDIDATES) {
      const selector = ethers.id(sig).slice(0, 10);
      try {
        const result = await provider.call({ to: addr, data: selector });
        if (result && result !== '0x') {
          const val = BigInt(result);
          console.log(`  ✅ ${sig.padEnd(30)} → ${val}`);
        } else {
          console.log(`  ⬜ ${sig.padEnd(30)} → empty`);
        }
      } catch (e) {
        console.log(`  ❌ ${sig.padEnd(30)} → revert`);
      }
    }
  }
  console.log('\nDone. Share results above.');
}

probe().catch(console.error);
