#!/usr/bin/env bash
# Manual / review smoke: five curls against a running pocket-term-2 bridge.
# Usage: PT2_BASE=http://127.0.0.1:7690 ./scripts/smoke.sh
set -euo pipefail

BASE="${PT2_BASE:-http://127.0.0.1:7690}"
PANE="${PT2_PANE:-w9:p8}"

echo "== 1) GET /herd/api/state =="
curl -fsS "${BASE}/herd/api/state" | head -c 400
echo
echo

echo "== 2) GET /herd/api/events (3s sample) =="
curl -fsS -N -m 3 "${BASE}/herd/api/events" || true
echo
echo

echo "== 3) GET /herd/api/pane/${PANE}/messages =="
curl -fsS "${BASE}/herd/api/pane/${PANE}/messages?limit=10" | head -c 400
echo
echo

echo "== 4) POST /herd/api/seen/${PANE} =="
curl -fsS -X POST "${BASE}/herd/api/seen/${PANE}" -H 'Content-Type: application/json' -d '{}'
echo
echo

echo "== 5) GET /herd/api/missing → expect 404 =="
code=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/herd/api/missing" || true)
echo "HTTP ${code}"
test "${code}" = "404"

echo
echo "smoke ok"
