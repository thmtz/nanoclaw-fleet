#!/bin/bash
# Worker initialization script — runs on first container boot.
# Clones repos and installs tools defined in the worker profile.
# Values use | as separator (newlines break docker -e parsing).
# This script is idempotent — safe to run multiple times.
# Timing output goes to stderr for startup profiling.

set -e

WORKSPACE="/workspace/group"
SKILLS_DIR="/home/node/.claude/skills"

# Startup profiling — uses entrypoint's _t0 if available, else sets its own
if [ -z "$_t0" ]; then
  _t0=$(date +%s%3N)
fi
_profile() {
  local now=$(date +%s%3N)
  local elapsed=$(( now - _t0 ))
  echo "[init +${elapsed}ms] $1" >&2
}

_profile "start"

# ── Symlink mounted configs ───────────────────────────────────
mkdir -p ~/.config
for dir in /workspace/extra/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  # Symlink to ~/.config/<name> by default.
  # Add special cases here for configs that live outside ~/.config/
  ln -sfn "$dir" ~/.config/"$name"
done
_profile "configs symlinked"

# ── SSH key setup ─────────────────────────────────────────────
# Use the host's SSH key (same key registered with cloud providers).
# Falls back to workspace copy, then generates a new key as last resort.
if [ ! -f ~/.ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  HOST_SSH="/workspace/extra/host-ssh"
  if [ -f "$HOST_SSH/id_ed25519" ]; then
    cp "$HOST_SSH/id_ed25519" ~/.ssh/ && chmod 600 ~/.ssh/id_ed25519
    cp "$HOST_SSH/id_ed25519.pub" ~/.ssh/ 2>/dev/null || true
    [ -f "$HOST_SSH/known_hosts" ] && cp "$HOST_SSH/known_hosts" ~/.ssh/ 2>/dev/null || true
    echo "[init] Using host SSH key (shared with cloud providers)"
  elif [ -f "$WORKSPACE/.ssh/id_ed25519" ]; then
    cp "$WORKSPACE/.ssh/"* ~/.ssh/ 2>/dev/null || true
    chmod 600 ~/.ssh/id_ed25519
    echo "[init] Restored SSH key from workspace"
  else
    ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q
    mkdir -p "$WORKSPACE/.ssh"
    cp ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub "$WORKSPACE/.ssh/"
    echo "[init] Generated new SSH key (persisted to workspace)"
  fi
fi
_profile "ssh keys"

# ── Clone repos (|-separated, parallel, skip if already cloned) ─
if [ -n "$WORKER_REPOS" ]; then
  cd "$WORKSPACE"
  IFS='|' read -ra REPOS <<< "$WORKER_REPOS"
  cloned=0
  skipped=0
  pids=()
  clone_urls=()
  for repo_url in "${REPOS[@]}"; do
    [ -z "$repo_url" ] && continue
    repo_name=$(basename "$repo_url" .git)
    if [ ! -d "$repo_name" ]; then
      echo "[init] Cloning $repo_url..."
      git clone "$repo_url" 2>&1 &
      pids+=($!)
      clone_urls+=("$repo_url")
      cloned=$((cloned + 1))
    else
      skipped=$((skipped + 1))
    fi
  done
  # Wait for all clones and report failures
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      echo "[init] WARNING: Failed to clone ${clone_urls[$i]}"
    fi
  done
  _profile "repos (cloned=$cloned, skipped=$skipped)"
else
  _profile "repos (none configured)"
fi

# ── Install skills ─────────────────────────────────────────────
install_skills_from() {
  local src="$1" label="$2"
  [ -d "$src" ] || return 0
  mkdir -p "$SKILLS_DIR"
  local count=0
  for skill_dir in "$src"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    [[ "$skill_name" == .* ]] && continue
    if [ ! -e "$SKILLS_DIR/$skill_name" ]; then
      ln -sfn "$skill_dir" "$SKILLS_DIR/$skill_name"
      count=$((count + 1))
    fi
  done
  if [ $count -gt 0 ]; then
    echo "[init] Installed $count $label skills"
  fi
}

if [ -n "$WORKER_SKILLS_REPO" ]; then
  SKILLS_REPO_DIR="$WORKSPACE/$WORKER_SKILLS_REPO"
  if [ -d "$SKILLS_REPO_DIR" ]; then
    install_skills_from "$SKILLS_REPO_DIR" "repo"
  else
    echo "[init] WARNING: Skills repo $WORKER_SKILLS_REPO not found at $SKILLS_REPO_DIR"
  fi
fi

install_skills_from "/workspace/extra/host-skills" "host"
_profile "skills installed"

# ── Set up shared beads inbox (optional — requires dolt server on host) ──
# To enable: set BEADS_ENABLED=1 in worker profile env, and run a dolt
# server on the host.
if [ "${BEADS_ENABLED:-0}" = "1" ]; then
  INBOX_DIR="/workspace/shared-beads/inbox"
  BEADS_HOST="${BEADS_SERVER_HOST:-host.docker.internal}"
  BEADS_PORT="${BEADS_SERVER_PORT:-3307}"
  BEADS_DB="${BEADS_DATABASE:-claude_inbox}"
  mkdir -p "$INBOX_DIR/.beads"
  cat > "$INBOX_DIR/.beads/metadata.json" << BEADSCFG
{"database":"dolt","backend":"dolt","dolt_mode":"server","dolt_server_host":"$BEADS_HOST","dolt_database":"$BEADS_DB"}
BEADSCFG
  echo "$BEADS_PORT" > "$INBOX_DIR/.beads/dolt-server.port"
  echo "issue-prefix: ${BEADS_PREFIX:-claude-inbox}" > "$INBOX_DIR/.beads/config.yaml"
  _profile "beads configured"
else
  _profile "beads skipped (set BEADS_ENABLED=1 to enable)"
fi

# ── Install tools (|-separated) ──────────────────────────────
if [ -n "$WORKER_TOOLS" ]; then
  IFS='|' read -ra TOOLS <<< "$WORKER_TOOLS"
  for tool_cmd in "${TOOLS[@]}"; do
    [ -z "$tool_cmd" ] && continue
    echo "[init] Installing: $tool_cmd"
    eval "$tool_cmd" 2>&1 || echo "[init] WARNING: Failed to install: $tool_cmd"
    _profile "tool: $tool_cmd"
  done
else
  _profile "tools (none configured)"
fi

_profile "complete"
