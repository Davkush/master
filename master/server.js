const express = require('express');
const cors    = require('cors');
const Redis   = require('ioredis');
const { v4: uuidv4 } = require('uuid');

// 🔁 CHECKPOINT ADDITION #1: Filesystem helpers for persistence
const fs = require('fs');
const path = require('path');

const CHECKPOINT_DIR = process.env.CHECKPOINT_DIR || '/checkpoint';
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, 'puzzle71_checkpoint.json');

if (!fs.existsSync(CHECKPOINT_DIR)) {
  fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      console.log(`[✓] Loaded checkpoint: chunk ${data.lastChunkIndex}, scanned ${data.totalScanned}`);
      return data;
    }
  } catch (err) {
    console.error('[!] Failed to load checkpoint:', err.message);
  }
  return null;
}

function saveCheckpoint(lastChunkIndex, totalScanned) {
  try {
    const data = { lastChunkIndex, totalScanned, savedAt: new Date().toISOString() };
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[!] Failed to save checkpoint:', err.message);
  }
}
// 🔁 END CHECKPOINT ADDITION #1

const app = express();
app.use(express.json());
app.use(cors());

// ── Puzzle #71 constants ──────────────────────────────────────────────────────
const PUZZLE_ADDRESS = '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU';
const RANGE_START    = BigInt('0x400000000000000000');
const RANGE_END      = BigInt('0x7fffffffffffffffff');
const TOTAL_KEYS     = RANGE_END - RANGE_START + 1n;

const CHUNK_SIZE     = BigInt('0x10000000000'); // 2^40
const TOTAL_CHUNKS   = Number((TOTAL_KEYS + CHUNK_SIZE - 1n) / CHUNK_SIZE);

// ── Redis ─────────────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
redis.on('error', err => console.error('[Redis]', err.message));

// 🔁 CHECKPOINT ADDITION #2: Restore state on Redis connect
redis.on('connect', async () => {
  console.log('[✓] Connected to Redis');
  const checkpoint = loadCheckpoint();
  if (checkpoint) {
    await redis.set('puzzle71:next_chunk', checkpoint.lastChunkIndex + 1);
    await redis.set('puzzle71:total_scanned', checkpoint.totalScanned);
    console.log(`[→] Resuming from chunk ${checkpoint.lastChunkIndex + 1}`);
  } else {
    await redis.set('puzzle71:next_chunk', 0);
    await redis.set('puzzle71:total_scanned', 0);
    console.log('[→] Starting fresh scan from chunk 0');
  }
});
// 🔁 END CHECKPOINT ADDITION #2

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
  const idx = await redis.incr('puzzle71:next_chunk');
  return idx - 1;
}

async function markChunkDone(index, workerId) {
  await redis.sadd('puzzle71:done_chunks', index.toString());
  await redis.hset('puzzle71:chunk_workers', index.toString(), workerId);
  await redis.incr('puzzle71:total_scanned');
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/range', async (req, res) => {
  try {
    const chunkIndex = await getNextChunkIndex();
    if (chunkIndex >= TOTAL_CHUNKS) {
      return res.json({ status: 'exhausted', message: 'All chunks assigned' });
    }
    const range = chunkToRange(chunkIndex);
    const workerId = req.query.worker_id || uuidv4();

    await redis.hset('puzzle71:assignments', chunkIndex.toString(), JSON.stringify({
      workerId, assignedAt: Date.now(), range
    }));

    console.log(`[+] Assigned chunk ${chunkIndex}/${TOTAL_CHUNKS} to ${workerId.slice(0,8)}`);
    res.json({ status: 'ok', workerId, chunk: range, totalChunks: TOTAL_CHUNKS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/done', async (req, res) => {
  const { chunk_index, worker_id, keys_checked } = req.body;
  await markChunkDone(chunk_index, worker_id);
  const scanned = await redis.get('puzzle71:total_scanned');
  const pct = ((Number(scanned) / TOTAL_CHUNKS) * 100).toFixed(6);
  console.log(`[✓] Chunk ${chunk_index} done by ${(worker_id||'?').slice(0,8)} | Progress: ${pct}% (${scanned}/${TOTAL_CHUNKS})`);
  res.json({ status: 'ok', progress: pct });
});

app.post('/found', async (req, res) => {
  const { private_key, worker_id, chunk_index } = req.body;
  const ts = new Date().toISOString();
  const result = { private_key, worker_id, chunk_index, found_at: ts };

  console.log('\n🔑🔑🔑 KEY FOUND 🔑🔑🔑');
  console.log(JSON.stringify(result, null, 2));

  await redis.set('puzzle71:RESULT', JSON.stringify(result));
  await redis.lpush('puzzle71:result_log', JSON.stringify(result));

  process.stdout.write(`\n[CRITICAL] PUZZLE #71 SOLVED\nPrivate Key: ${private_key}\nWorker: ${worker_id}\nTime: ${ts}\n`);

  res.json({ status: 'ok', message: 'Key recorded. You found it!' });
});

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

// 🔁 CHECKPOINT ADDITION #3: Periodic checkpoint saves (every 30s)
setInterval(async () => {
  try {
    const nextChunk = await redis.get('puzzle71:next_chunk');
    const scanned = await redis.get('puzzle71:total_scanned');
    if (nextChunk) {
      saveCheckpoint(parseInt(nextChunk) - 1, parseInt(scanned || 0));
    }
  } catch (err) {
    console.error('[!] Checkpoint save error:', err.message);
  }
}, 30000);
// 🔁 END CHECKPOINT ADDITION #3

// ── Start ─────────────────────────────────────────────────────────────────────

// 🔁 CHECKPOINT ADDITION #4: Graceful shutdown handlers
process.on('SIGTERM', async () => {
  console.log('[!] SIGTERM received, saving checkpoint...');
  try {
    const nextChunk = await redis.get('puzzle71:next_chunk');
    const scanned = await redis.get('puzzle71:total_scanned');
    if (nextChunk) {
      saveCheckpoint(parseInt(nextChunk) - 1, parseInt(scanned || 0));
    }
  } catch (err) {
    console.error('[!] Final checkpoint save failed:', err.message);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[!] SIGINT received, saving checkpoint...');
  try {
    const nextChunk = await redis.get('puzzle71:next_chunk');
    const scanned = await redis.get('puzzle71:total_scanned');
    if (nextChunk) {
      saveCheckpoint(parseInt(nextChunk) - 1, parseInt(scanned || 0));
    }
  } catch (err) {
    console.error('[!] Final checkpoint save failed:', err.message);
  }
  process.exit(0);
});
// 🔁 END CHECKPOINT ADDITION #4

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
