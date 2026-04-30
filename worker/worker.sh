#!/bin/bash
# ── Bitcoin Puzzle #71 — Worker Agent ─────────────────────────────────────────

MASTER_URL="${MASTER_URL:-http://localhost:3000}"
WORKER_ID="${WORKER_ID:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}"
THREADS="${THREADS:-$(nproc)}"
ADDRESS_FILE="/opt/puzzle71.txt"
TARGET="1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU"
RESULT_FILE="/tmp/keyhunt_result.txt"

echo "=============================================="
echo " Bitcoin Puzzle #71 — Worker"
echo " Worker ID : $WORKER_ID"
echo " Master    : $MASTER_URL"
echo " Threads   : $THREADS"
echo "=============================================="

# Wait for master to be available
echo "[*] Waiting for master node..."
until curl -sf "${MASTER_URL}/stats" > /dev/null 2>&1; do
  echo "    Master not ready, retrying in 5s..."
  sleep 5
done
echo "[+] Master is up."

run_keyhunt() {
  local start_hex="$1"
  local end_hex="$2"
  local chunk_idx="$3"

  echo "[*] Chunk $chunk_idx | Range: $start_hex → $end_hex"
  rm -f "$RESULT_FILE"

  # Run keyhunt in sequential mode on assigned range
  # -m address: search by address (no public key needed)
  # -f: address file
  # -r: hex range
  # -t: threads
  # -s: status interval (seconds)
  timeout 7200 keyhunt \
    -m address \
    -f "$ADDRESS_FILE" \
    -r "${start_hex}:${end_hex}" \
    -t "$THREADS" \
    -s 60 \
    2>&1 | tee "$RESULT_FILE"

  # Check if key was found in output
  if grep -qiE "(found|winner|private key|HIT)" "$RESULT_FILE" 2>/dev/null; then
    local privkey
    privkey=$(grep -iE "private key|found|HIT" "$RESULT_FILE" | grep -oE "[0-9a-fA-F]{64}" | head -1)
    if [ -n "$privkey" ]; then
      echo ""
      echo "🔑🔑🔑 KEY FOUND: $privkey"
      # Report to master
      curl -s -X POST "${MASTER_URL}/found" \
        -H "Content-Type: application/json" \
        -d "{\"private_key\":\"$privkey\",\"worker_id\":\"$WORKER_ID\",\"chunk_index\":$chunk_idx}" \
        | tee /tmp/found_response.json
      echo ""
      echo "[CRITICAL] Reported to master. KEEP THIS TERMINAL OPEN."
      # Also save locally in case network fails
      echo "$privkey" > /root/PUZZLE71_KEY_FOUND.txt
      echo "Chunk: $chunk_idx | Key: $privkey" >> /root/PUZZLE71_KEY_FOUND.txt
      # Don't exit — keep reporting
      while true; do
        echo "[HOLD] Key found: $privkey — Master notified. Do not restart."
        sleep 30
      done
    fi
  fi
}

report_done() {
  local chunk_idx="$1"
  curl -s -X POST "${MASTER_URL}/done" \
    -H "Content-Type: application/json" \
    -d "{\"chunk_index\":$chunk_idx,\"worker_id\":\"$WORKER_ID\",\"keys_checked\":1}" \
    > /dev/null
}

# ── Main loop: request chunks from master and search ─────────────────────────
echo "[*] Starting search loop..."
consecutive_errors=0

while true; do
  # Request next chunk
  RESPONSE=$(curl -sf "${MASTER_URL}/range?worker_id=${WORKER_ID}" 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
    consecutive_errors=$((consecutive_errors + 1))
    echo "[!] Failed to reach master (attempt $consecutive_errors). Retrying in 10s..."
    sleep 10
    if [ $consecutive_errors -ge 20 ]; then
      echo "[!] Master unreachable for too long. Exiting."
      exit 1
    fi
    continue
  fi
  consecutive_errors=0

  STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)

  if [ "$STATUS" = "exhausted" ]; then
    echo "[!] All chunks assigned. Search complete. Exiting worker."
    exit 0
  fi

  if [ "$STATUS" != "ok" ]; then
    echo "[!] Unexpected master response: $RESPONSE"
    sleep 10
    continue
  fi

  CHUNK_IDX=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['chunk']['index'])" 2>/dev/null)
  START_HEX=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['chunk']['start'])" 2>/dev/null)
  END_HEX=$(echo "$RESPONSE"   | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['chunk']['end'])"   2>/dev/null)
  TOTAL=$(echo "$RESPONSE"     | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totalChunks','?'))" 2>/dev/null)

  echo ""
  echo "════════════════════════════════════════"
  echo " Chunk   : $CHUNK_IDX / $TOTAL"
  echo " Start   : $START_HEX"
  echo " End     : $END_HEX"
  echo " Worker  : $WORKER_ID"
  echo "════════════════════════════════════════"

  run_keyhunt "$START_HEX" "$END_HEX" "$CHUNK_IDX"
  report_done "$CHUNK_IDX"

  echo "[+] Chunk $CHUNK_IDX done. Requesting next chunk..."
  sleep 1
done
