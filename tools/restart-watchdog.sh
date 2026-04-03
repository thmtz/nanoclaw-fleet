#!/bin/bash
# NanoClaw restart watchdog
# Watches for a signal file and rebuilds + restarts NanoClaw.
# Runs as a systemd user service (nanoclaw-restart.service).
#
# To trigger a restart from inside a container:
#   touch /home/host/.nanoclaw-restart
#
# The watchdog will:
#   1. Detect the signal file
#   2. Clean tsc cache and run npm run build
#   3. Restart nanoclaw + nanoclaw-shim services
#   4. Remove the signal file
#
# Optional: write a reason to the signal file for logging:
#   echo "fixed IPC bug" > /home/host/.nanoclaw-restart

set -e

SIGNAL_FILE="$HOME/.nanoclaw-restart"
NANOCLAW_DIR="${NANOCLAW_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG_PREFIX="[restart-watchdog]"

log() {
  echo "$LOG_PREFIX $(date '+%H:%M:%S') $1"
}

log "Started, watching $SIGNAL_FILE"

while true; do
  if [ -f "$SIGNAL_FILE" ]; then
    reason=""
    if [ -s "$SIGNAL_FILE" ]; then
      reason=" (reason: $(cat "$SIGNAL_FILE"))"
    fi
    log "Signal detected${reason}, rebuilding..."

    cd "$NANOCLAW_DIR"

    # Remove tsc incremental cache to force a full rebuild.
    # Without this, tsc may skip recompilation after git merges/rebases
    # because its .tsbuildinfo hash cache says "already compiled" even
    # though the source files changed.
    rm -f tsconfig.tsbuildinfo

    if npm run build 2>&1; then
      log "Build succeeded, restarting nanoclaw + shim..."
      systemctl --user restart nanoclaw nanoclaw-shim
      log "Restart complete"
    else
      log "ERROR: Build failed, not restarting"
    fi

    rm -f "$SIGNAL_FILE"
  fi
  sleep 2
done
