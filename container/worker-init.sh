#!/bin/bash
# Worker initialization — clones repos + installs tools defined in the fleet
# worker profile, mirrored from v1 nanoclaw-fleet's worker-profiles/init.sh.
#
# Reads /workspace/agent/container.json which the host writes with
# `fleetProfile.{repos,tools,skills_repo,env}` at create_worker time.
# Idempotent — safe to run on every container boot.
#
# Host invokes this via the container command (see src/container-runner.ts).
# Exit status is best-effort: a clone failure or tool install failure logs
# a warning but does NOT block agent startup, because users expect the
# agent to still be reachable even if one repo is unavailable.

set +e

WORKSPACE="/workspace"
AGENT_DIR="/workspace/agent"
SKILLS_DIR="/home/node/.claude/skills"
CONTAINER_JSON="$AGENT_DIR/container.json"

_t0=$(date +%s%3N)
_profile() {
  local now elapsed
  now=$(date +%s%3N)
  elapsed=$((now - _t0))
  echo "[init +${elapsed}ms] $1" >&2
}

_profile "worker-init start"

if [ ! -f "$CONTAINER_JSON" ]; then
  _profile "no container.json — skipping init"
  exit 0
fi

# Pull the fleet profile out of container.json. Fallback to empty so the
# container still boots when no profile is configured.
PROFILE_JSON=$(bun -e "const raw = require('$CONTAINER_JSON'); process.stdout.write(JSON.stringify(raw.fleetProfile ?? {}));" 2>/dev/null || echo "{}")

# ── Symlink /workspace/extra/* mounts into ~/.config/<name> ─────────────
# This preserves the v1 convention where profile.mounts[].containerPath
# maps to ~/.config/<name> inside the container.
if [ -d "/workspace/extra" ]; then
  mkdir -p ~/.config
  for dir in /workspace/extra/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    ln -sfn "$dir" ~/.config/"$name" 2>/dev/null || true
  done
  _profile "configs symlinked"
fi

# ── SSH key setup ────────────────────────────────────────────────────────
if [ ! -f ~/.ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  HOST_SSH="/workspace/extra/host-ssh"
  if [ -f "$HOST_SSH/id_ed25519" ]; then
    cp "$HOST_SSH/id_ed25519" ~/.ssh/ && chmod 600 ~/.ssh/id_ed25519
    cp "$HOST_SSH/id_ed25519.pub" ~/.ssh/ 2>/dev/null || true
    [ -f "$HOST_SSH/known_hosts" ] && cp "$HOST_SSH/known_hosts" ~/.ssh/ 2>/dev/null || true
    _profile "using host SSH key"
  fi
fi

# ── Clone repos ──────────────────────────────────────────────────────────
# Iterate profile.repos[] = [{url, postClone}, ...]. Clone into /workspace
# which is the worker's workspace root (bind-mounted to the host). SSH
# URLs are rewritten to HTTPS if NANOCLAW_GITHUB_TOKEN_PATH is set.
REPO_COUNT=$(bun -e "const p=$PROFILE_JSON; process.stdout.write(String((p.repos??[]).length));" 2>/dev/null || echo "0")
if [ "$REPO_COUNT" -gt 0 ] 2>/dev/null; then
  # Accept both forms: NANOCLAW_GITHUB_TOKEN (literal, preferred —
  # container-runner reads the file host-side and passes the value) or
  # NANOCLAW_GITHUB_TOKEN_PATH (file inside the container).
  GITHUB_TOKEN="${NANOCLAW_GITHUB_TOKEN:-}"
  if [ -z "$GITHUB_TOKEN" ] && [ -n "$NANOCLAW_GITHUB_TOKEN_PATH" ] && [ -f "$NANOCLAW_GITHUB_TOKEN_PATH" ]; then
    GITHUB_TOKEN=$(cat "$NANOCLAW_GITHUB_TOKEN_PATH")
  fi

  # Trust OneCLI's CA when its proxy is intercepting our HTTPS clones.
  # OneCLI mounts a combined bundle (system CAs + its self-signed cert) at
  # SSL_CERT_FILE for node/deno, but git uses its own bundle and ignores
  # SSL_CERT_FILE — point GIT_SSL_CAINFO at the same file so HTTPS clones
  # to github.com (and anywhere else proxied through OneCLI) verify
  # cleanly. No-op when OneCLI isn't applied (SSL_CERT_FILE unset).
  if [ -n "$SSL_CERT_FILE" ] && [ -f "$SSL_CERT_FILE" ]; then
    export GIT_SSL_CAINFO="$SSL_CERT_FILE"
  fi

  cloned=0
  skipped=0
  for i in $(seq 0 $((REPO_COUNT - 1))); do
    URL=$(bun -e "const p=$PROFILE_JSON; process.stdout.write(p.repos[$i].url);" 2>/dev/null)
    POST=$(bun -e "const p=$PROFILE_JSON; process.stdout.write(p.repos[$i].postClone ?? '');" 2>/dev/null)
    [ -z "$URL" ] && continue

    # Derive the directory name from the URL.
    NAME=$(basename "$URL" .git)
    TARGET="$WORKSPACE/$NAME"

    if [ -d "$TARGET/.git" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    # Prefer SSH when an SSH key is available (set up earlier from
    # /workspace/extra/host-ssh). Only rewrite git@github.com:org/repo.git
    # → https://<token>@github.com/org/repo.git when SSH ISN'T usable
    # (no key, or fallback environment).
    #
    # Why: under OneCLI the container has HTTPS_PROXY pointing at the
    # OneCLI gateway, which terminates HTTPS connections (so it can
    # inject vault credentials). But the URL-embedded basic-auth token
    # (`https://<token>@github.com/...`) doesn't survive the proxy
    # gracefully — git ends up prompting for a password. SSH on port 22
    # bypasses HTTPS_PROXY entirely. Falls back to the HTTPS rewrite
    # only when SSH is genuinely unavailable.
    CLONE_URL="$URL"
    if [ ! -f ~/.ssh/id_ed25519 ] && [ -n "$GITHUB_TOKEN" ] && [[ "$URL" == git@github.com:* ]]; then
      REPO_PATH="${URL#git@github.com:}"
      REPO_PATH="${REPO_PATH%.git}"
      CLONE_URL="https://${GITHUB_TOKEN}@github.com/${REPO_PATH}.git"
    fi

    echo "[init] cloning $NAME" >&2
    if git clone --quiet "$CLONE_URL" "$TARGET" 2>&1; then
      cloned=$((cloned + 1))
      if [ -n "$POST" ]; then
        (cd "$TARGET" && eval "$POST") 2>&1 || echo "[init] WARNING postClone failed: $POST" >&2
      fi
    else
      echo "[init] WARNING: clone failed: $URL" >&2
    fi
  done
  _profile "repos (cloned=$cloned skipped=$skipped)"
fi

# ── Install skills from skills_repo ─────────────────────────────────────
# Two layouts are supported:
#   1. <repo>/.claude/skills/<name>/SKILL.md  — the "Claude Code conventional"
#      layout where a repo packages skills under a `.claude/skills/` subtree
#   2. <repo>/<name>/SKILL.md                 — repo where each top-level
#      directory IS a skill (e.g. neuralwatt-claude-skills). Detection: a
#      subdir contains a SKILL.md file.
# Broken symlinks (a symlink whose target isn't visible inside the
# container — happens when the host has `~/.claude/skills/<x>` symlinked
# at a path the container can't see) are skipped silently.
SKILLS_REPO=$(bun -e "const p=$PROFILE_JSON; process.stdout.write(p.skills_repo ?? '');" 2>/dev/null)
if [ -n "$SKILLS_REPO" ] && [ -d "$WORKSPACE/$SKILLS_REPO" ]; then
  mkdir -p "$SKILLS_DIR"
  if [ -d "$WORKSPACE/$SKILLS_REPO/.claude/skills" ]; then
    SKILLS_SRC="$WORKSPACE/$SKILLS_REPO/.claude/skills"
  else
    SKILLS_SRC="$WORKSPACE/$SKILLS_REPO"
  fi
  count=0
  for sd in "$SKILLS_SRC"/*/; do
    [ -d "$sd" ] || continue                       # skip broken symlinks
    [ -f "$sd/SKILL.md" ] || continue              # skill-shaped only
    sname=$(basename "$sd")
    [[ "$sname" == .* ]] && continue
    if [ ! -e "$SKILLS_DIR/$sname" ]; then
      ln -sfn "$sd" "$SKILLS_DIR/$sname"
      count=$((count + 1))
    fi
  done
  _profile "skills: linked $count from $SKILLS_REPO"
fi

# ── Host-skills mount (optional) ────────────────────────────────────────
# Same broken-symlink guard as above — host-skills mounts `~/.claude/skills/`
# from the host, but if any of those entries are themselves symlinks
# pointing OUTSIDE the mount (a common pattern: `~/.claude/skills/foo`
# is a symlink into `~/git/team-skills/foo/`), they appear as broken
# symlinks inside the container. The `[ -d "$sd" ]` test fails for
# broken symlinks, so they're skipped.
if [ -d "/workspace/extra/host-skills" ]; then
  mkdir -p "$SKILLS_DIR"
  count=0
  for sd in /workspace/extra/host-skills/*/; do
    [ -d "$sd" ] || continue                       # skip broken symlinks
    sname=$(basename "$sd")
    [[ "$sname" == .* ]] && continue
    if [ ! -e "$SKILLS_DIR/$sname" ]; then
      ln -sfn "$sd" "$SKILLS_DIR/$sname"
      count=$((count + 1))
    fi
  done
  [ $count -gt 0 ] && _profile "skills: linked $count from host-skills"
fi

# ── Run profile tools ────────────────────────────────────────────────────
TOOL_COUNT=$(bun -e "const p=$PROFILE_JSON; process.stdout.write(String((p.tools??[]).length));" 2>/dev/null || echo "0")
if [ "$TOOL_COUNT" -gt 0 ] 2>/dev/null; then
  for i in $(seq 0 $((TOOL_COUNT - 1))); do
    CMD=$(bun -e "const p=$PROFILE_JSON; process.stdout.write(p.tools[$i]);" 2>/dev/null)
    [ -z "$CMD" ] && continue
    echo "[init] tool: $CMD" >&2
    eval "$CMD" 2>&1 || echo "[init] WARNING tool failed: $CMD" >&2
  done
  _profile "tools installed"
fi

_profile "worker-init complete"
exit 0
