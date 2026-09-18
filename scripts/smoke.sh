#!/usr/bin/env bash
# Boots the server in local-only mode, exercises the read endpoints,
# and shuts it down. Run from the repo root: bash scripts/smoke.sh
set -uo pipefail

rm -rf /tmp/rd-smoke
RUNTIME_DIR=/tmp/rd-smoke PORT=8123 node server/dist/index.js > /tmp/rd-smoke.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 30); do
  sleep 1
  curl -sf -m 2 localhost:8123/api/status >/dev/null 2>&1 && break
done

echo "=== server log ==="
cat /tmp/rd-smoke.log
echo
echo "=== /api/status ==="
curl -s -m 8 localhost:8123/api/status
echo
echo
echo "=== /api/rules (first 900 chars) ==="
curl -s -m 8 localhost:8123/api/rules | head -c 900
echo
echo
echo "=== runtime repo git log ==="
git -C /tmp/rd-smoke/primary log --oneline 2>&1 | head -5
