#!/bin/bash
# Wrapper invoked by the SessionEnd hook and the launchd timer.
# Deterministic, $0 tokens, read-only on sources. Logs to _sync/sync.log.
# Self-throttles: skips if it ran successfully in the last 60s (hook + timer dedupe).
set -uo pipefail

SYNC_DIR="/Users/home/v1/Agent Workspaces/_sync"
LOG="$SYNC_DIR/sync.log"
STAMP="$SYNC_DIR/.last-run"
NOW=$(date +%s)

if [ -f "$STAMP" ]; then
  LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt 60 ]; then exit 0; fi
fi

PY=$(command -v python3 || echo /usr/bin/python3)
# Guard: if sync.py is mid-edit (won't parse), skip this run cleanly instead of crashing.
if ! "$PY" -c "import ast,sys; ast.parse(open('$SYNC_DIR/sync.py').read())" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') skipped: sync.py not parseable (mid-edit)" >> "$LOG"
  exit 0
fi
{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') sync start ====="
  "$PY" "$SYNC_DIR/sync.py" 2>&1 | grep -v "zshenv"
  "$PY" "$SYNC_DIR/skills_inspect.py" 2>&1 | grep -v "zshenv"   # refresh the skills audit ($0)
  echo "===== done ====="
} >> "$LOG" 2>&1

echo "$NOW" > "$STAMP"
# keep log bounded
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
