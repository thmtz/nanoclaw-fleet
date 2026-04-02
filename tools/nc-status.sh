#!/usr/bin/env bash
# nc-status.sh — NanoClaw status dashboard
# Shows workers, containers, orphans, and system info.
# Designed to be called by the master agent and output formatted for Discord.

set -euo pipefail

NC_ROOT="${NANOCLAW_ROOT:-/workspace/project}"
DATA_DIR="$NC_ROOT/data"
BACKENDS_FILE="$DATA_DIR/worker-backends.json"
USAGE_FILE="$DATA_DIR/worker-usage.json"
GROUPS_FILE="$DATA_DIR/ipc/discord_main/available_groups.json"

MAIN_FOLDER="discord_main"
CONTAINER_PREFIX="nanoclaw-"
# Read from env, then fall back to .env file (try NC_ROOT and host path), then default to 5
if [ -n "${MAX_CONCURRENT_CONTAINERS:-}" ]; then
  MAX_CONTAINER_SLOTS="$MAX_CONCURRENT_CONTAINERS"
else
  MAX_CONTAINER_SLOTS=5
  for envfile in "$NC_ROOT/.env"; do
    if [ -f "$envfile" ]; then
      val=$(grep -oP 'MAX_CONCURRENT_CONTAINERS=\K\d+' "$envfile" 2>/dev/null || true)
      [ -n "$val" ] && MAX_CONTAINER_SLOTS="$val" && break
    fi
  done
fi

# ── Helpers ───────────────────────────────────────────────────

_human_duration() {
  local secs=$1
  if (( secs < 60 )); then echo "${secs}s"
  elif (( secs < 3600 )); then echo "$(( secs / 60 ))m"
  elif (( secs < 86400 )); then echo "$(( secs / 3600 ))h $(( (secs % 3600) / 60 ))m"
  else echo "$(( secs / 86400 ))d $(( (secs % 86400) / 3600 ))h"
  fi
}

now_epoch=$(date +%s)

# ── Gather docker state (single call) ────────────────────────

declare -A container_names container_created container_uptime
total_containers=0
if docker_output=$(docker ps --filter "name=${CONTAINER_PREFIX}" --format '{{.Names}}\t{{.CreatedAt}}\t{{.RunningFor}}' 2>/dev/null); then
  while IFS=$'\t' read -r cname ccreated cuptime; do
    [ -z "$cname" ] && continue
    # nanoclaw-discord-foo-1234567890 -> discord-foo -> discord_foo
    folder=$(echo "$cname" | sed "s/^${CONTAINER_PREFIX}//; s/-[0-9]*$//" | sed 's/^discord-/discord_/')
    container_names["$folder"]="$cname"
    container_created["$folder"]="$ccreated"
    container_uptime["$folder"]="$cuptime"
    total_containers=$((total_containers + 1))
  done <<< "$docker_output"
else
  echo "⚠️ Docker unavailable — container status unknown" >&2
fi

# ── Gather all JSON data (single python3 call) ───────────────
# Reads all three data files at once, outputs tab-separated lines.

json_data=$(python3 -c "
import json, sys, os

def fmt_tokens(n):
    if n > 1_000_000: return f'{n/1_000_000:.1f}M'
    if n > 1_000: return f'{n/1_000:.1f}k'
    return str(n)

backends_file = sys.argv[1]
usage_file = sys.argv[2]
groups_file = sys.argv[3]
default_model = sys.argv[4]

backends = {}
usage = {}
groups = []

for path, target in [(backends_file, 'backends'), (usage_file, 'usage'), (groups_file, 'groups')]:
    if not os.path.isfile(path):
        continue
    try:
        with open(path) as f:
            data = json.load(f)
        if target == 'backends':
            backends = data
        elif target == 'usage':
            usage = data
        elif target == 'groups':
            groups = data.get('groups', [])
    except (json.JSONDecodeError, KeyError) as e:
        print(f'WARN\tFailed to parse {path}: {e}', file=sys.stderr)

# Output registered folders (non-main)
registered = [g for g in groups if g.get('isRegistered') and g.get('folder') and g.get('folder') != '${MAIN_FOLDER}']
for g in registered:
    folder = g['folder']
    b = backends.get(folder, {})
    backend = b.get('backend', 'anthropic')
    model = b.get('model', '')
    if backend == 'anthropic' and not model:
        model = default_model
    if not model:
        model = 'unknown'

    u = usage.get(folder, {})
    reqs = u.get('requests', 0)
    tok = u.get('total_tokens', 0)
    kwh = u.get('energy_kwh', 0)
    usage_str = ''
    if reqs > 0:
        parts = [f'{reqs} reqs', f'{fmt_tokens(tok)} tokens']
        if kwh > 0:
            parts.append(f'{kwh*1000:.1f} Wh')
        usage_str = ' · '.join(parts)

    print(f'WORKER\t{folder}\t{backend}\t{model}\t{usage_str}')

# Output NW totals
nw_wh = nw_reqs = nw_tokens = 0
for folder, u in usage.items():
    b = backends.get(folder, {})
    if b.get('backend') == 'neuralwatt':
        nw_wh += u.get('energy_kwh', 0) * 1000
        nw_reqs += u.get('requests', 0)
        nw_tokens += u.get('total_tokens', 0)
if nw_reqs > 0:
    print(f'NW_TOTAL\t{nw_reqs} reqs · {fmt_tokens(nw_tokens)} tokens · {nw_wh:.1f} Wh')

# Output stale cache count
stale = sum(1 for g in groups if not g.get('isRegistered') and g.get('jid', '').startswith('dc:'))
if stale > 0:
    print(f'STALE\t{stale}')
" "$BACKENDS_FILE" "$USAGE_FILE" "$GROUPS_FILE" "${NANOCLAW_MODEL:-claude}" 2>&1) || true

# Parse python output into structured data
declare -A worker_backend worker_model worker_usage
registered_folders=()
nw_total=""
stale_count=0

while IFS=$'\t' read -r tag rest; do
  case "$tag" in
    WORKER)
      IFS=$'\t' read -r folder backend model usage_str <<< "$rest"
      registered_folders+=("$folder")
      worker_backend["$folder"]="$backend"
      worker_model["$folder"]="$model"
      worker_usage["$folder"]="$usage_str"
      ;;
    NW_TOTAL)
      nw_total="$rest"
      ;;
    STALE)
      stale_count="$rest"
      ;;
  esac
done <<< "$json_data"

# ── Master info ───────────────────────────────────────────────

master_container="${container_names[$MAIN_FOLDER]:-}"
if [ -n "$master_container" ]; then
  master_created=$(docker inspect "$master_container" --format '{{.Created}}' 2>/dev/null || echo "")
  if [ -n "$master_created" ]; then
    master_epoch=$(date -d "$master_created" +%s 2>/dev/null || echo "0")
    master_uptime=$(_human_duration $(( now_epoch - master_epoch )))
  else
    master_uptime="unknown"
  fi
else
  master_uptime="down"
fi
master_model="${NANOCLAW_MODEL:-claude}"
if [ "$master_uptime" = "down" ] || [ "$master_uptime" = "unknown" ]; then
  echo "**Master** · \`$master_model\` · $master_uptime"
else
  echo "**Master** · \`$master_model\` · up $master_uptime"
fi
echo ""

# ── Workers ───────────────────────────────────────────────────

echo "## 🤖 Workers"

if [ ${#registered_folders[@]} -eq 0 ]; then
  echo "_No workers registered._"
else
  for folder in "${registered_folders[@]}"; do
    short_name="${folder#discord_}"
    backend="${worker_backend[$folder]}"
    model="${worker_model[$folder]}"
    usage_str="${worker_usage[$folder]}"

    if [ -n "${container_names[$folder]:-}" ]; then
      icon="🟢"
      age="${container_uptime[$folder]% ago}"
    else
      icon="⚫"
      age="stopped"
    fi

    line="${icon} **${short_name}** · \`${model}\`"
    [ "$age" != "stopped" ] && line="${line} · up ${age}"
    [ "$age" = "stopped" ] && line="${line} · stopped"
    [ -n "$usage_str" ] && line="${line} · ${usage_str}"
    echo "- ${line}"
  done
  echo ""
fi

# ── Orphaned containers ──────────────────────────────────────

echo "## 🗑️ Orphaned Containers"
orphaned=0
for folder in "${!container_names[@]}"; do
  [ "$folder" = "$MAIN_FOLDER" ] && continue
  is_registered=false
  for rf in "${registered_folders[@]}"; do
    [ "$rf" = "$folder" ] && is_registered=true && break
  done
  if ! $is_registered; then
    echo "- ⚠️ \`${container_names[$folder]}\` (folder: $folder) — running but not registered"
    orphaned=$((orphaned + 1))
  fi
done
[ $orphaned -eq 0 ] && echo "_None._"
echo ""

# ── Summary ───────────────────────────────────────────────────

echo "## 📊 Summary"
echo "- Containers: **${total_containers}/${MAX_CONTAINER_SLOTS}** slots used"
echo "- Workers: **${#registered_folders[@]}** registered"
[ -n "$nw_total" ] && echo "- Neuralwatt total: $nw_total"
[ $orphaned -gt 0 ] && echo "- ⚠️ **$orphaned** orphaned container(s)"
[ "$stale_count" -gt 0 ] 2>/dev/null && echo "- ${stale_count} stale channel cache entries"
