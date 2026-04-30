# Bitcoin Puzzle #71 — Distributed Keyhunt Cluster

**Target:** `1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU`  
**Range:** `0x400000000000000000` → `0x7fffffffffffffffff` (71-bit)  
**Prize:** ~7.1 BTC  
**Tool:** Keyhunt (CPU, address mode — public key not exposed)

---

## Architecture

```
Browser → Master Dashboard (stats, progress)
              │
           Redis (chunk state, result storage)
              │
    ┌─────────┼──────────┐
    ▼         ▼          ▼
 Worker1   Worker2   WorkerN
 Keyhunt   Keyhunt   Keyhunt
 chunk 0   chunk 1   chunk N
```

**Master** splits the 71-bit range into chunks of 2^40 keys each (~33.5M total chunks).  
**Workers** poll master for a chunk, run keyhunt, report done, get next chunk — forever.  
**If a worker finds the key**, it reports to master AND saves locally at `/root/PUZZLE71_KEY_FOUND.txt`.

---

## Deploy on Railway — Step by Step

### Step 1: Deploy Redis

1. Railway dashboard → **New Project**
2. **Add a service** → **Database** → **Redis**
3. Copy the `REDIS_URL` from the Redis service variables

### Step 2: Deploy Master

1. Push `master/` folder to a GitHub repo
2. New service → Deploy from GitHub → select that repo
3. Set environment variables:
   ```
   REDIS_URL=<your redis url from step 1>
   PORT=3000
   ```
4. Settings → Networking → **Generate Domain** (you need the master URL for workers)
5. Wait for deploy → visit `https://your-master.up.railway.app/stats`

### Step 3: Deploy Workers

1. Push `worker/` folder to a **separate** GitHub repo
2. New service → Deploy from GitHub → select worker repo
3. Set environment variables:
   ```
   MASTER_URL=https://your-master.up.railway.app
   THREADS=4
   ```
4. Deploy → worker starts scanning automatically

### Step 4: Scale Workers

In Railway dashboard → Worker service → **Settings → Replicas → set to 5-10**

Each replica is an independent worker picking up chunks from master.  
No duplicate work — Redis guarantees atomic chunk assignment.

---

## Environment Variables

### Master
| Variable    | Required | Description              |
|-------------|----------|--------------------------|
| `REDIS_URL` | ✅        | Redis connection string  |
| `PORT`      | ✅        | Web port (Railway sets)  |

### Worker
| Variable     | Required | Default     | Description                    |
|--------------|----------|-------------|--------------------------------|
| `MASTER_URL` | ✅        | —           | Full URL of master service     |
| `THREADS`    | ❌        | `nproc`     | CPU threads for keyhunt        |
| `WORKER_ID`  | ❌        | auto-uuid   | Worker identifier in logs      |

---

## Monitoring

Visit `https://your-master.up.railway.app/` for the live dashboard.  
Or hit `https://your-master.up.railway.app/stats` for raw JSON:

```json
{
  "puzzle": "#71",
  "target_address": "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU",
  "total_chunks": 33554432,
  "scanned": 142,
  "progress_pct": "0.00042319%",
  "solved": false,
  "active_workers": 8
}
```

---

## Performance Estimates (CPU only)

| Setup              | Keys/s      | Time to scan 1 chunk (2^40) | Chunks/day |
|--------------------|-------------|------------------------------|------------|
| 1 worker, 4 threads | ~2M keys/s | ~6 hours                    | ~4         |
| 5 workers, 4 threads| ~10M keys/s| ~1.2 hours per worker       | ~20        |
| 10 workers, 8 threads| ~40M keys/s| ~30 min per worker         | ~48        |

The total space has ~33.5M chunks. This is a probabilistic search — you could find it on chunk 1 or chunk 33M.

---

## If The Key Is Found

1. Master logs: `[CRITICAL] PUZZLE #71 SOLVED`
2. Worker saves to `/root/PUZZLE71_KEY_FOUND.txt`  
3. Dashboard shows the key
4. Use the private key immediately via Electrum or bitcoin-cli to sweep funds

**Sweep command:**
```bash
bitcoin-cli importprivkey <PRIVATE_KEY_WIF> "puzzle71" false
bitcoin-cli sendtoaddress <YOUR_ADDRESS> 7.1
```

---

## Notes

- Keyhunt runs in **address mode** (no public key needed — correct for #71)
- Each chunk is atomically assigned — no two workers scan the same range
- Workers auto-restart on Railway crash and pick up from next unassigned chunk
- Redis persists all progress across deploys
