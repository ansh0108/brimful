#!/usr/bin/env bash
# brimful-run: launch a Claude task that auto-registers itself for resume if the
# usage limit cuts it off. Zero token overhead - it only watches exit output.
#
# Usage:
#   brimful-run.sh -p "do the long task"      # headless task
#   brimful-run.sh                            # interactive (best-effort capture)
#
# If Claude stops with a limit message, this records the reset time and queues a
# resume job. Run the dispatcher (cron/launchd/watch) and it continues for free
# once the window reopens.

set -uo pipefail
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
LOGFILE="$(mktemp -t brimful-run.XXXXXX)"
WORKDIR="$(pwd)"

# Run claude, mirroring output to the user while capturing it for inspection.
"$CLAUDE_BIN" "$@" 2>&1 | tee "$LOGFILE"

# Look for a usage-limit message and extract the reset time.
RESET_LINE="$(grep -iE "resets?( at)? +[0-9]" "$LOGFILE" | tail -1)"
rm -f "$LOGFILE"

if [[ -z "$RESET_LINE" ]]; then
  exit 0  # finished normally, nothing to resume
fi

RESET_TIME="$(echo "$RESET_LINE" | grep -ioE "[0-9]{1,2}(:[0-9]{2})? *(am|pm)?" | head -1 | tr -d ' ')"
if [[ -z "$RESET_TIME" ]]; then
  echo "[brimful] Limit detected but could not parse reset time. Register manually:"
  echo "  node \"$PLUGIN_DIR/scripts/brimful.mjs\" resume add --dir \"$WORKDIR\" --after \"<time>\""
  exit 0
fi

echo ""
echo "[brimful] Usage limit detected. Queuing auto-resume at $RESET_TIME."
node "$PLUGIN_DIR/scripts/brimful.mjs" resume add \
  --dir "$WORKDIR" \
  --after "$RESET_TIME" \
  --prompt "Continue the task you were working on before the usage limit interrupted you."
echo "[brimful] Make sure the dispatcher is running so it resumes for free:"
echo "  node \"$PLUGIN_DIR/scripts/dispatch.mjs\" watch"
