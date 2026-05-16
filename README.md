# Hash256 V2 Miner

Headless Node.js miner for Hash256 V2 (Cuckoo Cycle 25).  
Runs on Railway with a compiled C solver — no WASM needed.

## How it works

1. Fetches current epoch + difficulty from the contract
2. Computes your wallet-bound challenge:
   `keccak256(chainId ‖ contract ‖ yourAddress ‖ epoch)`
3. For each nonce, derives a graph seed:
   `keccak256(challenge ‖ nonce)`
4. Feeds the seed to the C lean solver (Cuckoo Cycle N=25, 80 trim rounds)
5. If a 42-cycle is found AND passes difficulty, submits `mine(nonce, proof)` on-chain

## Deploy to Railway (from phone)

### 1. Create GitHub repo
- Go to github.com → New repository → name it `hash256-miner`
- Upload all these files (use GitHub's web UI or mobile app)

### 2. Set environment variables
In Railway dashboard → your service → Variables:

| Variable | Value |
|---|---|
| `RPC_URL` | Your Alchemy/Infura mainnet URL |
| `PRIVATE_KEY` | Your wallet private key |
| `MAX_GAS_GWEI` | `25` (adjust to your preference) |
| `LOG_INTERVAL` | `5` |

### 3. Deploy
- Railway → New Project → Deploy from GitHub → select your repo
- Railway detects the `Dockerfile` automatically
- Build takes ~2 minutes (compiles the C solver with `-O3`)
- Service starts mining immediately

## Speed on Railway

| Plan | vCPU | Approx. attempts/min |
|---|---|---|
| Hobby ($5/mo) | 1 shared | ~8–12 |
| Pro ($20/mo) | 2 dedicated | ~18–25 |

Each attempt is one full Cuckoo Cycle solve (~5–8s on a real CPU in C).

## Logs to watch for

```
[0s]  ★ New epoch 47  difficulty=0000ffff…  challenge=0x3a9f…
[12s] [MINE ] nonce=2  epoch=47  rate~10/min  solved=0  submitted=0
[18s] [CYCLE] found at nonce=3  (solved=1)
[18s] [DIFF ] ✓ passes difficulty!
[18s] [TX]    Submitting  nonce=3  edges=[142,891,...]
[19s] ✅ MINED!  block=21234567  balance=1000.0 HASH
```

## Notes

- The C solver uses ~35 MB RAM per instance
- `MAX_GAS_GWEI` prevents wasting ETH when the network is busy
- Each epoch lasts ~1,000 blocks (~3.3 hours)
- Your wallet needs a small amount of ETH for gas (~$0.50–2 per submission)
