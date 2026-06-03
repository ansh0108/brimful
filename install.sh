#!/usr/bin/env bash
# Brimful installer. Sets up the persistent state dir, migrates any existing
# config/backlog, wires the statusLine, and prints how to schedule the dispatcher.
# Idempotent and safe to re-run. Run with --with-cron to also add a cron entry.

set -uo pipefail
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${BRIMFUL_HOME:-$HOME/.brimful}"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "[brimful] Node.js is required but not found on PATH." >&2
  exit 1
fi

echo "[brimful] Plugin dir: $PLUGIN_DIR"
echo "[brimful] State dir:  $DATA_DIR"
mkdir -p "$DATA_DIR"

# Make scripts executable.
chmod +x "$PLUGIN_DIR"/scripts/*.mjs 2>/dev/null || true
chmod +x "$PLUGIN_DIR"/bin/*.sh 2>/dev/null || true

# Seed/migrate config.
if [[ ! -f "$DATA_DIR/config.json" ]]; then
  if [[ -f "$PLUGIN_DIR/config.json" ]]; then
    cp "$PLUGIN_DIR/config.json" "$DATA_DIR/config.json"
    echo "[brimful] Migrated existing config.json -> $DATA_DIR"
  else
    "$NODE_BIN" "$PLUGIN_DIR/scripts/brimful.mjs" config > "$DATA_DIR/config.json"
    echo "[brimful] Seeded default config."
  fi
fi

# Seed/migrate backlog.
if [[ ! -f "$DATA_DIR/backlog.md" ]]; then
  if [[ -f "$PLUGIN_DIR/backlog.md" ]]; then
    cp "$PLUGIN_DIR/backlog.md" "$DATA_DIR/backlog.md"
    echo "[brimful] Migrated existing backlog.md -> $DATA_DIR"
  else
    printf '# Brimful backlog\n\nFormat: - [priority] description @/optional/repo (S/M/L)\n\n## Tasks\n' > "$DATA_DIR/backlog.md"
    echo "[brimful] Seeded empty backlog."
  fi
fi

# Wire the statusLine (official numbers, zero tokens).
"$NODE_BIN" "$PLUGIN_DIR/scripts/wire-statusline.mjs"

# Optional cron entry.
CRON_LINE="*/30 * * * * $NODE_BIN $PLUGIN_DIR/scripts/dispatch.mjs tick >> $DATA_DIR/dispatch.log 2>&1"
if [[ "${1:-}" == "--with-cron" ]]; then
  if crontab -l 2>/dev/null | grep -qF "dispatch.mjs tick"; then
    echo "[brimful] Cron entry already present."
  else
    ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
    echo "[brimful] Added cron entry (every 30 min)."
  fi
fi

echo ""
echo "[brimful] Done. Next steps:"
echo "  1. Check the meter:   $NODE_BIN $PLUGIN_DIR/scripts/brimful.mjs report"
echo "  2. Edit your backlog: $DATA_DIR/backlog.md"
echo "  3. Schedule draining/resume (if you did not pass --with-cron):"
echo "       $CRON_LINE"
echo "  4. Pause anytime:     touch $DATA_DIR/.brimful-pause   (rm to resume)"
