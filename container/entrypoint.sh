#!/bin/bash
# NanoClaw container entrypoint — runs init, compiles agent-runner, starts agent.
# All timing output goes to stderr (captured by container-runner on exit).
set -e

export _t0=$(date +%s%3N)
_profile() {
  local now=$(date +%s%3N)
  local elapsed=$(( now - _t0 ))
  echo "[entrypoint +${elapsed}ms] $1" >&2
}

_profile "start"

# Run worker init script if mounted (repos, tools, credentials)
if [ -x /workspace/init.sh ]; then
  _profile "init.sh start"
  /workspace/init.sh 2>&1 >&2 || echo "[entrypoint] WARNING: init.sh failed" >&2
  _profile "init.sh done"
fi

# Use pre-built dist from Docker image if source hasn't changed.
# The host mounts agent-runner source to /app/src at runtime (synced from
# container/agent-runner/src/ on the host). If the host source differs from
# what the image was built with, tsc recompiles. Rebuild the container image
# after agent-runner changes to avoid this 2-3s penalty on every spawn.
DIST_DIR="/app/dist"
needs_compile=false
if [ ! -f "$DIST_DIR/index.js" ]; then
  needs_compile=true
elif [ -f "$DIST_DIR/.src-hash" ] && [ -d /app/src ]; then
  current_hash=$(find /app/src -name '*.ts' -exec md5sum {} + 2>/dev/null | awk '{print $1}' | sort | md5sum | cut -d' ' -f1)
  built_hash=$(cat "$DIST_DIR/.src-hash")
  [ "$current_hash" != "$built_hash" ] && needs_compile=true
else
  needs_compile=true
fi

if [ "$needs_compile" = true ]; then
  _profile "tsc start (source changed)"
  cd /app && npx tsc 2>&1 >&2
  # Reuse the hash we already computed (avoids re-reading all .ts files)
  [ -n "$current_hash" ] && echo "$current_hash" > "$DIST_DIR/.src-hash"
  _profile "tsc done"
else
  _profile "tsc skipped (dist up-to-date)"
fi

# Read container input from stdin
_profile "reading stdin"
cat > /tmp/input.json

# Start the agent
_profile "starting agent"
node "$DIST_DIR/index.js" < /tmp/input.json
