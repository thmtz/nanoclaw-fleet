#!/bin/bash
# End-to-end smoke test for NanoClaw.
# Run after making changes to verify nothing major is broken.
#
# Usage: ./tools/e2e-test.sh
#
# Prerequisites:
#   - nanoclaw service running (systemctl --user start nanoclaw)
#   - nanoclaw-shim service running (for Neuralwatt tests; skipped if not)
#   - Docker running
#   - .env configured with DISCORD_GUILD_ID
#
# What it tests (22 checks):
#   1. Preflight — services running, config present
#   2. Worker creation — DB registration, workspace dir, assembled CLAUDE.md
#   3. First boot — container spawns, Anthropic agent responds, no errors
#   4. Session resume — kill container, respawn, agent recalls a secret code
#   5. Neuralwatt backend — create NW worker, shim returns valid Anthropic-format
#      response (non-streaming and streaming SSE)
#   6. Backend switching — NW → Anthropic config update
#   7. Credential proxy — reachable on :3001
#   8. Destroy — DB cleanup, container stopped, workspace + session preserved
#   9. Startup timing — reports last host startup duration
#
# What it does NOT test:
#   - Master agent natural language understanding (uses IPC, not Discord messages)
#   - Personal config (instructions, Dockerfile, init.sh)
#   - Anthropic → NW backend switch (only tests NW → Anthropic)
#   - Worker resume after destroy+recreate (only tests resume after container kill)
#   - Full model switching within Neuralwatt
#   - Content correctness of agent responses (checks structure, not semantics,
#     except for secret code recall which is best-effort)
#
# Creates and destroys temporary workers. Cleans up on exit.
# Takes ~65s. Exit code = number of failed checks (0 = all pass).

set -uo pipefail
# No set -e: we want to continue past failures and report all results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

GUILD_ID=$(grep DISCORD_GUILD_ID .env | cut -d= -f2)
WORKER_NAME="e2e-test-$$"
WORKER_FOLDER="discord_${WORKER_NAME}"
PASS=0
FAIL=0
TOTAL_START=$(date +%s%3N)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL + 1)); }
info() { echo -e "${YELLOW}▸${NC} $1"; }

cleanup() {
  info "Cleaning up worker ${WORKER_NAME}..."
  local jid
  jid=$(sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder='${WORKER_FOLDER}';" 2>/dev/null | head -1)
  if [ -n "$jid" ]; then
    tools/nc-ipc.sh discord_main "{\"type\":\"destroy_worker\",\"jid\":\"${jid}\"}" >/dev/null 2>&1 || true
  fi
  sleep 3
  rm -rf "groups/${WORKER_FOLDER}" "data/sessions/${WORKER_FOLDER}" 2>/dev/null || true
  sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='${WORKER_FOLDER}';" 2>/dev/null || true
}
trap cleanup EXIT

# ── Preflight ──────────────────────────────────────────────────

info "Preflight checks"

if systemctl --user is-active nanoclaw >/dev/null 2>&1; then
  pass "nanoclaw service running"
else
  fail "nanoclaw service not running"
  echo "Run: systemctl --user start nanoclaw"
  exit 1
fi

if docker info >/dev/null 2>&1; then
  pass "Docker running"
else
  fail "Docker not running"
  exit 1
fi

if [ -z "$GUILD_ID" ]; then
  fail "DISCORD_GUILD_ID not set in .env"
  exit 1
fi
pass "DISCORD_GUILD_ID found"

# ── 1. Create worker ──────────────────────────────────────────

info "Creating worker: ${WORKER_NAME}"
T0=$(date +%s%3N)

tools/nc-ipc.sh discord_main "{\"type\":\"create_worker\",\"guild_id\":\"${GUILD_ID}\",\"channel_name\":\"${WORKER_NAME}\",\"folder\":\"${WORKER_FOLDER}\",\"trigger\":\"@Andy\"}" >/dev/null

sleep 3

# Check registration
if sqlite3 store/messages.db "SELECT folder FROM registered_groups WHERE folder='${WORKER_FOLDER}';" 2>/dev/null | grep -q "$WORKER_FOLDER"; then
  pass "Worker registered in DB"
else
  fail "Worker not registered in DB"
fi

# Check workspace
if [ -d "groups/${WORKER_FOLDER}" ]; then
  pass "Workspace directory created"
else
  fail "Workspace directory not created"
fi

# Check assembled CLAUDE.md
if [ -f "groups/${WORKER_FOLDER}/CLAUDE.md" ]; then
  pass "CLAUDE.md assembled"
else
  fail "CLAUDE.md not assembled"
fi

# ── 2. Message worker ─────────────────────────────────────────

info "Messaging worker (first boot)..."
tools/nc-inject.sh "$WORKER_NAME" "Remember this secret code: bravo-tango-42. Reply with just 'got it'." >/dev/null

# Wait for container to spawn and respond
TIMEOUT=60
ELAPSED=0
CONTAINER_UP=false
while [ $ELAPSED -lt $TIMEOUT ]; do
  # Container names use hyphens (sanitizeFolderName replaces underscores)
  SAFE_NAME=$(echo "$WORKER_FOLDER" | tr '_' '-')
  if docker ps --format '{{.Names}}' | grep -q "nanoclaw-${SAFE_NAME}"; then
    CONTAINER_UP=true
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if $CONTAINER_UP; then
  pass "Container spawned (${ELAPSED}s)"
else
  fail "Container did not spawn within ${TIMEOUT}s"
fi

# Wait for first output in JSONL
ELAPSED=0
RESPONSE_ARRIVED=false
while [ $ELAPSED -lt $TIMEOUT ]; do
  if jq -e "select(type == \"object\") | select(.group == \"${WORKER_NAME}\" and .msg == \"Container first output\")" logs/nanoclaw.jsonl >/dev/null 2>&1; then
    STARTUP_MS=$(jq -r "select(type == \"object\") | select(.group == \"${WORKER_NAME}\" and .msg == \"Container first output\") | .startupMs" logs/nanoclaw.jsonl 2>/dev/null | tail -1)
    RESPONSE_ARRIVED=true
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if $RESPONSE_ARRIVED; then
  pass "Agent responded (startupMs: ${STARTUP_MS}ms)"
else
  fail "Agent did not respond within ${TIMEOUT}s"
fi

# Check for errors in logs
ERROR_COUNT=$(jq -r "select(type == \"object\") | select(.group == \"${WORKER_NAME}\" and .level >= 50)" logs/nanoclaw.jsonl 2>/dev/null | wc -l)
if [ "$ERROR_COUNT" -eq 0 ]; then
  pass "No errors in logs"
else
  fail "Found ${ERROR_COUNT} error(s) in logs for this worker"
fi

T1=$(date +%s%3N)
info "First boot: $((T1 - T0))ms total"

# ── 3. Session resume ─────────────────────────────────────────

info "Testing session resume..."

# Kill the container
docker kill $(docker ps -q --filter "name=nanoclaw-${SAFE_NAME}") >/dev/null 2>&1 || true
sleep 2

# Check session ID was preserved
SESSION_ID=$(sqlite3 store/messages.db "SELECT session_id FROM sessions WHERE group_folder='${WORKER_FOLDER}';" 2>/dev/null)
if [ -n "$SESSION_ID" ]; then
  pass "Session ID preserved: ${SESSION_ID:0:8}..."
else
  fail "Session ID not preserved"
fi

# Message again — should respawn
T2=$(date +%s%3N)
tools/nc-inject.sh "$WORKER_NAME" "What was the secret code I told you?" >/dev/null

ELAPSED=0
RESPAWN_OK=false
while [ $ELAPSED -lt $TIMEOUT ]; do
  # Look for a second "Container first output" after T2
  SECOND_OUTPUT=$(jq -r "select(type == \"object\") | select(.group == \"${WORKER_NAME}\" and .msg == \"Container first output\" and .time > ${T2})" logs/nanoclaw.jsonl 2>/dev/null | head -1)
  if [ -n "$SECOND_OUTPUT" ]; then
    RESPAWN_OK=true
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if $RESPAWN_OK; then
  T3=$(date +%s%3N)
  pass "Container respawned ($((T3 - T2))ms)"
else
  fail "Container did not respawn within ${TIMEOUT}s"
fi

# Check if agent remembered the code (best-effort content check)
sleep 5
AGENT_OUTPUT=$(jq -r "select(type == \"object\") | select(.group == \"${WORKER_NAME}\" and .msg != null and (.msg | test(\"bravo|tango|42\"; \"i\")) and .time > ${T2})" logs/nanoclaw.jsonl 2>/dev/null | head -1)
if [ -n "$AGENT_OUTPUT" ]; then
  pass "Agent remembered secret code (session resume works)"
else
  # Check the session transcript instead
  TRANSCRIPT_FILE=$(ls -t data/sessions/${WORKER_FOLDER}/.claude/projects/-workspace-group/*.jsonl 2>/dev/null | head -1)
  if [ -n "$TRANSCRIPT_FILE" ]; then
    if jq -r 'select(.message.role == "assistant") | .message.content[]? | select(.type == "text") | .text' "$TRANSCRIPT_FILE" 2>/dev/null | grep -qi "bravo\|tango\|42"; then
      pass "Agent remembered secret code (found in transcript)"
    else
      fail "Agent did not recall secret code (session resume may not work)"
    fi
  else
    fail "No transcript file found"
  fi
fi

# ── 4. Neuralwatt backend ─────────────────────────────────────

NW_AVAILABLE=false
if systemctl --user is-active nanoclaw-shim >/dev/null 2>&1; then
  NW_MODEL=$(curl -s http://localhost:3003/models 2>/dev/null | jq -r '.models[0] // empty' 2>/dev/null)
  if [ -n "$NW_MODEL" ]; then
    NW_AVAILABLE=true
  fi
fi

if $NW_AVAILABLE; then
  info "Testing Neuralwatt backend (model: ${NW_MODEL})..."

  # Create a NW worker
  NW_WORKER="e2e-nw-$$"
  NW_FOLDER="discord_${NW_WORKER}"
  tools/nc-ipc.sh discord_main "{\"type\":\"create_worker\",\"guild_id\":\"${GUILD_ID}\",\"channel_name\":\"${NW_WORKER}\",\"folder\":\"${NW_FOLDER}\",\"trigger\":\"@Andy\",\"backend\":\"neuralwatt\",\"model\":\"${NW_MODEL}\"}" >/dev/null
  sleep 3

  # Verify backend config
  if jq -e ".\"${NW_FOLDER}\"" data/worker-backends.json >/dev/null 2>&1; then
    pass "NW worker backend configured"
  else
    fail "NW worker backend not in worker-backends.json"
  fi

  # Message it via shim (direct curl, bypasses SDK boot time)
  NW_RESPONSE=$(curl -s http://localhost:3003/w/${NW_FOLDER}/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: sk-ant-api03-placeholder" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"claude-opus-4-6\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"Say the word hello\"}]}" 2>/dev/null)

  if echo "$NW_RESPONSE" | jq -e '.content[0].text' >/dev/null 2>&1; then
    pass "NW shim returned valid Anthropic-format response"
  else
    fail "NW shim response invalid: $(echo "$NW_RESPONSE" | head -c 200)"
  fi

  # Test streaming
  NW_STREAM=$(curl -s http://localhost:3003/w/${NW_FOLDER}/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: sk-ant-api03-placeholder" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"claude-opus-4-6\",\"max_tokens\":50,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Say hi\"}]}" 2>/dev/null | head -5)

  if echo "$NW_STREAM" | grep -q "event: message_start"; then
    pass "NW streaming works (SSE events)"
  else
    fail "NW streaming broken: $(echo "$NW_STREAM" | head -c 200)"
  fi

  # Test backend switching: NW → Anthropic
  info "Testing backend switch (NW → Anthropic)..."
  tools/nc-ipc.sh discord_main "{\"type\":\"switch_backend\",\"worker_name\":\"${NW_WORKER}\",\"backend\":\"anthropic\"}" >/dev/null
  sleep 2

  NW_CONFIG_AFTER=$(jq -r ".\"${NW_FOLDER}\".backend // \"anthropic\"" data/worker-backends.json 2>/dev/null)
  if [ "$NW_CONFIG_AFTER" = "anthropic" ]; then
    pass "Backend switched to Anthropic"
  else
    fail "Backend switch failed (still: ${NW_CONFIG_AFTER})"
  fi

  # Cleanup NW worker
  NW_JID=$(sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder='${NW_FOLDER}';" 2>/dev/null | head -1)
  if [ -n "$NW_JID" ]; then
    tools/nc-ipc.sh discord_main "{\"type\":\"destroy_worker\",\"jid\":\"${NW_JID}\"}" >/dev/null
  fi
  sleep 3
  rm -rf "groups/${NW_FOLDER}" "data/sessions/${NW_FOLDER}"
  sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='${NW_FOLDER}';" 2>/dev/null || true
else
  info "Skipping Neuralwatt tests (shim not running or no models available)"
fi

# ── 5. Anthropic auth check ───────────────────────────────────

info "Checking Anthropic credential proxy..."
# Verify the proxy is listening. Full auth is tested implicitly when the
# Anthropic worker responds above (the SDK does OAuth exchange through the proxy).
if curl -s -o /dev/null -w "" http://172.17.0.1:3001/ 2>/dev/null; then
  pass "Credential proxy reachable on :3001"
else
  fail "Credential proxy not reachable on :3001"
fi

# ── 6. Destroy Anthropic worker ───────────────────────────────

info "Destroying worker..."

# Remove the EXIT trap cleanup since we're doing it here
trap - EXIT

# Look up JID from DB (destroy_worker IPC requires jid, not name)
WORKER_JID=$(sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder='${WORKER_FOLDER}';" 2>/dev/null | head -1)
if [ -n "$WORKER_JID" ]; then
  tools/nc-ipc.sh discord_main "{\"type\":\"destroy_worker\",\"jid\":\"${WORKER_JID}\"}" >/dev/null
fi
sleep 5

# Check registration removed
REG_COUNT=$(sqlite3 store/messages.db "SELECT count(*) FROM registered_groups WHERE folder='${WORKER_FOLDER}';" 2>/dev/null)
if [ "$REG_COUNT" -eq 0 ]; then
  pass "Registration removed from DB"
else
  fail "Registration still in DB"
fi

# Check container stopped
if ! docker ps --format '{{.Names}}' | grep -q "nanoclaw-${SAFE_NAME}"; then
  pass "Container stopped"
else
  fail "Container still running"
fi

# Check workspace preserved
if [ -d "groups/${WORKER_FOLDER}" ]; then
  pass "Workspace preserved after destroy"
else
  fail "Workspace deleted (should be preserved)"
fi

# Check session preserved for resume
SESSION_AFTER=$(sqlite3 store/messages.db "SELECT session_id FROM sessions WHERE group_folder='${WORKER_FOLDER}';" 2>/dev/null)
if [ -n "$SESSION_AFTER" ]; then
  pass "Session preserved for resume"
else
  fail "Session not preserved"
fi

# ── 7. Host startup timing ────────────────────────────────────

info "Checking host startup timing..."
LAST_STARTUP=$(jq -r 'select(type == "object") | select(.msg | startswith("Startup: startup complete")) | .elapsed' logs/nanoclaw.jsonl 2>/dev/null | tail -1)
if [ -n "$LAST_STARTUP" ]; then
  pass "Last startup: ${LAST_STARTUP}ms"
else
  pass "No startup timing found (JSONL may be from before this feature)"
fi

# ── Final cleanup ─────────────────────────────────────────────

# Clean up workspace and session
rm -rf "groups/${WORKER_FOLDER}"
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='${WORKER_FOLDER}';" 2>/dev/null || true
rm -rf "data/sessions/${WORKER_FOLDER}"

# ── Summary ───────────────────────────────────────────────────

TOTAL_END=$(date +%s%3N)
TOTAL_MS=$((TOTAL_END - TOTAL_START))
echo ""
echo "════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}All ${PASS} checks passed${NC} (${TOTAL_MS}ms)"
else
  echo -e "${RED}${FAIL} failed${NC}, ${GREEN}${PASS} passed${NC} (${TOTAL_MS}ms)"
fi
echo "════════════════════════════════════════"

exit $FAIL
