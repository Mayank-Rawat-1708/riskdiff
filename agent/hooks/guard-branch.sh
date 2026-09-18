#!/usr/bin/env bash
# pre_tool_use hook. Receives tool-call context as JSON on stdin, must
# print exactly one JSON object to stdout: {"action":"allow"} or
# {"action":"block","reason":"..."}.
#
# NOTE ON ASSUMPTIONS: the exact stdin schema for *script-based* hooks
# isn't spelled out in gitagent's README as precisely as the
# programmatic hook shape (ctx.toolName / ctx.args) is -- this reads
# a couple of plausible field names defensively rather than assuming
# one. See NOTES.md.
set -euo pipefail

INPUT="$(cat)"
TOOL="$(node -e '
  let raw = process.argv[1];
  try {
    const d = JSON.parse(raw);
    process.stdout.write(String(d.toolName ?? d.tool ?? d.tool_name ?? ""));
  } catch { process.stdout.write(""); }
' "$INPUT" 2>/dev/null || echo "")"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"

if [[ "$BRANCH" == "main" && ( "$TOOL" == "write" || "$TOOL" == "cli" ) ]]; then
  REASON="guard-branch: refusing a ${TOOL} call while checked out on main -- rule proposals must happen on a proposal/* branch (see agent/RULES.md #1)"
  printf '{"action":"block","reason":%s}' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$REASON")"
else
  echo '{"action":"allow"}'
fi
