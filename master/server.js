const express = require('express');
const cors    = require('cors');
const Redis   = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cors());

// ── Puzzle #71 constants ──────────────────────────────────────────────────────
const PUZZLE_ADDRESS = '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU';
const RANGE_START    = BigInt('0x400000000000000000');
const RANGE_END      = BigInt('0x7fffffffffffffffff');
const TOTAL_KEYS     = RANGE_END - RANGE_START + 1n;

// Each chunk = 2^40 keys (~1.1 trillion) — ~1h per worker per chunk on CPU
const CHUNK_SIZE     = BigInt('0x10000000000'); // 2^40
const TOTAL_CHUNKS   = Number((TOTAL_KEYS + CHUNK_SIZE - 1n) / CHUNK_SIZE);

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', err => console.error('[Redis]', err.message));

// ── Helpers ───────────────────────────────────────────────────────────────────
function chunkToRange(chunkIndex) {
  const start = RANGE_START + BigInt(chunkIndex) * CHUNK_SIZE;
  const end   = start + CHUNK_SIZE - 1n < RANGE_END
                ? start + CHUNK_SIZE - 1n
                : RANGE_END;
  return {
    start: start.toString(16).padStart(18, '0'),
    end:   end.toString(16).padStart(18, '0'),
    index: chunkIndex,
  };
}

async function getNextChunkIndex() {
  // next_chunk counter in Redis — atomic increment
  const idx = await redis.incr('puzzle71:next_chunk');
  return idx - 1; // 0-based
}

async function markChunkDone(index, workerId) {
  await redis.sadd('puzzle71:done_chunks', index.toString());
  await redis.hset('puzzle71:chunk_workers', index.toString(), workerId);
  await redis.incr('puzzle71:total_scanned');
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Worker calls this to get its next chunk assignment
app.get('/range', async (req, res) => {
  try {
    const chunkIndex = await getNextChunkIndex();
    if (chunkIndex >= TOTAL_CHUNKS) {
      return res.json({ status: 'exhausted', message: 'All chunks assigned' });
    }
    const range = chunkToRange(chunkIndex);
    const workerId = req.query.worker_id || uuidv4();

    // Track assignment
    await redis.hset('puzzle71:assignments', chunkIndex.toString(), JSON.stringify({
      workerId, assignedAt: Date.now(), range
    }));

    console.log(`[+] Assigned chunk ${chunkIndex}/${TOTAL_CHUNKS} to ${workerId.slice(0,8)}`);
    res.json({ status: 'ok', workerId, chunk: range, totalChunks: TOTAL_CHUNKS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Worker calls this when chunk is complete (no key found)
app.post('/done', async (req, res) => {
  const { chunk_index, worker_id, keys_checked } = req.body;
  await markChunkDone(chunk_index, worker_id);
  const scanned = await redis.get('puzzle71:total_scanned');
  const pct = ((Number(scanned) / TOTAL_CHUNKS) * 100).toFixed(6);
  console.log(`[✓] Chunk ${chunk_index} done by ${(worker_id||'?').slice(0,8)} | Progress: ${pct}% (${scanned}/${TOTAL_CHUNKS})`);
  res.json({ status: 'ok', progress: pct });
});

// Worker calls this when it finds the key — THE MONEY CALL
app.post('/found', async (req, res) => {
  const { private_key, worker_id, chunk_index } = req.body;
  const ts = new Date().toISOString();
  const result = { private_key, worker_id, chunk_index, found_at: ts };

  console.log('\n🔑🔑🔑 KEY FOUND 🔑🔑🔑');
  console.log(JSON.stringify(result, null, 2));

  // Store permanently in Redis
  await redis.set('puzzle71:RESULT', JSON.stringify(result));
  await redis.lpush('puzzle71:result_log', JSON.stringify(result));

  // Alert to stdout (Railway logs)
  process.stdout.write(`\n[CRITICAL] PUZZLE #71 SOLVED\nPrivate Key: ${private_key}\nWorker: ${worker_id}\nTime: ${ts}\n`);

  res.json({ status: 'ok', message: 'Key recorded. You found it!' });
});

// Stats dashboard
app.get('/stats', async (req, res) => {
  const [nextChunk, scanned, result, workers] = await Promise.all([
    redis.get('puzzle71:next_chunk'),
    redis.get('puzzle71:total_scanned'),
    redis.get('puzzle71:RESULT'),
    redis.hgetall('puzzle71:assignments'),
  ]);

  const done    = parseInt(scanned || '0');
  const total   = TOTAL_CHUNKS;
  const pct     = ((done / total) * 100).toFixed(8);
  const remaining = total - done;

  res.json({
    puzzle:         '#71',
    target_address: PUZZLE_ADDRESS,
    range:          `0x400000000000000000 → 0x7fffffffffffffffff`,
    chunk_size:     `2^40 (${CHUNK_SIZE.toString()} keys)`,
    total_chunks:   total,
    assigned:       parseInt(nextChunk || '0'),
    scanned:        done,
    remaining:      remaining,
    progress_pct:   pct,
    solved:         !!result,
    result:         result ? JSON.parse(result) : null,
    active_workers: Object.keys(workers || {}).length,
  });
});

// Simple HTML dashboard
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Puzzle #71 Master</title>
  <meta http-equiv="refresh" content="10">
  <style>
    body { background:#0d0d0d; color:#e0e0e0; font-family:monospace; padding:30px; }
    h1 { color:#367bf0; } .key { color:#26a65b; font-size:1.4em; font-weight:bold; }
    .val { color:#00c8ff; } pre { background:#111; padding:16px; border-radius:4px; }
    .found { background:#1a4a1a; border:2px solid #26a65b; padding:20px; border-radius:6px; }
  </style>
</head>
<body>
  <h1>⛏ Bitcoin Puzzle #71 — Master Node</h1>
  <p>Auto-refreshes every 10s. <a href="/stats" style="color:#367bf0">JSON stats</a></p>
  <script>
    fetch('/stats').then(r=>r.json()).then(d=>{
      document.body.innerHTML += '<pre>' + JSON.stringify(d, null, 2) + '</pre>';
      if(d.solved) document.body.innerHTML += '<div class="found"><p class="key">🔑 KEY FOUND: ' + d.result.private_key + '</p></div>';
    });
  </script>
</body>
</html>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║  Bitcoin Puzzle #71 — MASTER NODE        ║
║  Target : ${PUZZLE_ADDRESS}  ║
║  Range  : 2^70 → 2^71-1                  ║
║  Chunks : ${TOTAL_CHUNKS.toLocaleString()} total (2^40 each)   ║
║  Port   : ${PORT}                              ║
╚══════════════════════════════════════════╝
  `);
});
