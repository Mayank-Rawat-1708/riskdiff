#!/usr/bin/env bash
# on_error hook. Best-effort: appends a short note to memory/MEMORY.md
# so a failed run isn't silently invisible. Never blocks -- always
# returns {"action":"allow"} even if the append itself fails, since an
# error handler that can itself fatally error is a bad idea.
set -uo pipefail

INPUT="$(cat)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMFILE="${SCRIPT_DIR}/../memory/MEMORY.md"
TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

MSG="$(node -e '
  let raw = process.argv[1];
  try {
    const d = JSON.parse(raw);
    process.stdout.write(String(d.error ?? d.message ?? "unknown error").slice(0, 300));
  } catch { process.stdout.write("unknown error"); }
' "$INPUT" 2>/dev/null || echo "unknown error")"

{
  echo ""
  echo "### ${TS} -- agent run error"
  echo "${MSG}"
} >> "$MEMFILE" 2>/dev/null || true

echo '{"action":"allow"}'
