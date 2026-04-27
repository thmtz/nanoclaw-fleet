#!/usr/bin/env bash
# Smoke test — exercises host-side ncf commands + the Discord-driven
# lifecycle test.  Designed to be run by an agent working on this codebase
# (or a human verifying a change) without any manual Discord clicks.
#
# Must have the host running (pnpm run dev) and the master seeded + bound
# to a Discord channel. Master channel id is read from data/v2.db; no env
# vars required beyond what's already in .env.
set -euo pipefail

cd "$(dirname "$0")/.."

# Always reap orphan Discord channels on exit — even when the smoke run
# aborts partway through. test-fleet-lifecycle.ts creates workers via
# master; if any step fails before the destroy step, the channel leaks.
# This trap is the safety net for the recurring "why is there a stale
# worker-* channel?" complaint.
cleanup_orphans() {
  echo
  echo "== cleanup: reap stale Discord channels =="
  ./bin/ncf reap-orphans 2>&1 | head -5 || true
}
trap cleanup_orphans EXIT

FAILED=()

ok()   { echo -e "  ✓ $1"; }
fail() { echo -e "  ✗ $1"; FAILED+=("$1"); }
section() { echo; echo "== $1 =="; }

# ---- prerequisites --------------------------------------------------------
section "prerequisites"

if ! ps -ef | grep -qE "[t]sx src/index\.ts|[n]ode .*/dist/index\.js"; then
  fail "host is not running (neither pnpm run dev nor node dist/index.js)"
  echo
  echo "SMOKE ABORTED — start the host first:"
  echo "  pnpm run dev &           # or"
  echo "  systemctl --user start nanoclaw"
  exit 1
fi
ok "host is running"

if ! curl -fs -o /dev/null -m 2 http://127.0.0.1:3100/wake/ping -X POST; then
  fail "outbound-wake endpoint not responding"
else
  ok "outbound-wake endpoint reachable"
fi

MASTER_CH=$(sqlite3 "$PWD/data/v2.db" \
  "SELECT platform_id FROM messaging_groups mg
     JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
     JOIN agent_groups ag ON ag.id = mga.agent_group_id
    WHERE ag.fleet_role = 'master' AND mg.channel_type = 'discord'
    LIMIT 1" | awk -F: '{print $3}')
if [ -z "$MASTER_CH" ]; then
  fail "no Discord master channel in v2.db — run scripts/init-fleet-master-discord.ts first"
  exit 1
fi
ok "master Discord channel: $MASTER_CH"

# ---- ncf commands ---------------------------------------------------------
section "ncf commands"

./bin/ncf status >/dev/null 2>&1  && ok "ncf status"           || fail "ncf status"
./bin/ncf debug  >/dev/null 2>&1  && ok "ncf debug"            || fail "ncf debug"
./bin/ncf history --limit 5 >/dev/null 2>&1 && ok "ncf history" || fail "ncf history"
./bin/ncf reap-orphans --dry-run >/dev/null 2>&1 && ok "ncf reap-orphans --dry-run" \
                                                || fail "ncf reap-orphans --dry-run"

# ---- inject --wait (round-trip via master) --------------------------------
section "ncf inject --wait"

REPLY=$(./bin/ncf inject master "what is 12*3?" --wait --timeout 30 2>&1 || true)
echo "$REPLY" | tail -5
if echo "$REPLY" | grep -qE "^\[.*\]"; then
  ok "master replied to injected message"
else
  fail "ncf inject --wait master: no reply within 30s"
fi

# ---- real Discord round-trip ---------------------------------------------
# ncf inject bypasses Discord entirely. The actual user path is
# Debug bot → Discord Gateway → host router → container → Discord REST.
# If the CLI path works but this one doesn't, an outbound-routing bug is
# silently eating replies.
section "Discord round-trip (debug bot → master → Discord)"

DEBUG_BOT_TOKEN_FILE="${HOME}/.config/nanoclaw/debug_bot_token"
if [ ! -f "$DEBUG_BOT_TOKEN_FILE" ]; then
  echo "  (skipped — no debug bot token at $DEBUG_BOT_TOKEN_FILE)"
else
  DEBUG_TOKEN=$(cat "$DEBUG_BOT_TOKEN_FILE")
  POST_RESP=$(curl -fs -X POST -H "Authorization: Bot $DEBUG_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"content":"smoke discord round-trip — say one word"}' \
    "https://discord.com/api/v10/channels/$MASTER_CH/messages") || POST_RESP=""
  POST_ID=$(echo "$POST_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
  if [ -z "$POST_ID" ]; then
    fail "debug bot could not post to master channel"
  else
    DEADLINE=$((SECONDS + 60))
    REPLIED=""
    while [ $SECONDS -lt $DEADLINE ]; do
      LAST_USER=$(curl -fs -H "Authorization: Bot $DEBUG_TOKEN" \
        "https://discord.com/api/v10/channels/$MASTER_CH/messages?limit=1" 2>/dev/null \
        | python3 -c "import sys,json; m=json.load(sys.stdin)[0]; print(m['author'].get('username',''))" 2>/dev/null || echo "")
      case "$LAST_USER" in
        NanoClaw*) REPLIED=1; break ;;
      esac
      sleep 2
    done
    if [ -n "$REPLIED" ]; then
      ok "master replied on Discord within 60s"
    else
      fail "master did not reply on Discord within 60s"
    fi
  fi
fi

# ---- pinned status --------------------------------------------------------
section "pinned status"

TOKEN=$(grep '^DISCORD_BOT_TOKEN=' .env | cut -d= -f2)
PINS=$(curl -fs -H "Authorization: Bot $TOKEN" \
  "https://discord.com/api/v10/channels/$MASTER_CH/messages/pins" || true)
if echo "$PINS" | grep -qE 'Workers.*active'; then
  ok "master channel has a fleet pinned status message"
else
  fail "master channel pinned status message missing (check FLEET_STATUS_PIN_INTERVAL_MS)"
fi

# ---- lifecycle test (Discord-driven) --------------------------------------
section "Discord-driven lifecycle test"

DISCORD_MASTER_CHANNEL_ID=$MASTER_CH pnpm exec tsx scripts/test-fleet-lifecycle.ts
if [ $? -eq 0 ]; then
  ok "test-fleet-lifecycle.ts passed"
else
  fail "test-fleet-lifecycle.ts failed"
fi

# ---- summary --------------------------------------------------------------
section "summary"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "  all green"
  exit 0
fi
echo "  ${#FAILED[@]} failure(s):"
for f in "${FAILED[@]}"; do echo "    - $f"; done
exit 1
