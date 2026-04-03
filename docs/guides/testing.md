# Testing Guide

How to exercise every NanoClaw behavior end-to-end. This guide is for coding agents working on this codebase and for humans verifying changes.

## Prerequisites

Check that the system is running before testing:

```bash
systemctl --user status nanoclaw        # Host process (must be active)
systemctl --user status nanoclaw-shim   # Neuralwatt proxy (needed for NW tests only)
docker ps                               # Docker daemon running
```

If NanoClaw isn't running: `systemctl --user start nanoclaw`. If you need to rebuild first: `npm run build && systemctl --user restart nanoclaw`.

Host-side test tools live in `tools/`.

## What Changed → What to Test

| I changed... | Test by... |
|-|-|
| `src/ipc.ts` (worker lifecycle) | Create, message, destroy, recreate with resume (scenarios 1-4, 10-11) |
| `src/container-runner.ts` (mounts, env) | Create a worker, exec in, check mounts and env vars (scenarios 1, 12) |
| `container/` or `worker-profiles/` | Rebuild image, restart, message a worker (see "After Container-Side Changes" below) |
| `tools/anthropic-shim.ts` | Restart shim, curl test, message a NW worker (see "After Shim Changes" below) |
| `container/agent-runner/src/` (MCP tools) | Restart, message a worker, verify the tool works (auto-syncs by mtime) |
| Inference routing or model config | Create NW worker, switch model, verify (scenarios 5-8) |

## Host-Side Tools

Two shell scripts let you interact with NanoClaw without Discord:

**nc-inject.sh** — Send a message to any channel as if a user typed it:
```bash
./tools/nc-inject.sh master "list all workers"
./tools/nc-inject.sh --wait test-worker "what model are you?"
./tools/nc-inject.sh dc:YOUR_CHANNEL_ID "hi"
```
The `--wait` flag polls docker logs until the agent responds and prints the output.

**nc-ipc.sh** — Send IPC commands directly (bypasses the master agent):
```bash
./tools/nc-ipc.sh discord_main '{"type":"create_worker","guild_id":"YOUR_GUILD_ID","channel_name":"test","folder":"discord_test","trigger":"@YourBot"}'
./tools/nc-ipc.sh discord_main '{"type":"destroy_worker","jid":"dc:123456"}'
./tools/nc-ipc.sh discord_main '{"type":"list_workers"}'
```
Note: `create_worker` via IPC requires `guild_id`, `channel_name`, `folder`, and `trigger`. The MCP tool fills in defaults from env vars, but IPC commands need all four.

## Test Scenarios

### 1. Create a Worker

```bash
# Via master agent (natural language)
./tools/nc-inject.sh master "create a worker called test-e2e"

# Via IPC (direct — requires all four fields)
./tools/nc-ipc.sh discord_main '{"type":"create_worker","guild_id":"YOUR_GUILD_ID","channel_name":"test-e2e","folder":"discord_test-e2e","trigger":"@YourBot"}'
```

**Verify:**
- Discord channel `#test-e2e` created
- `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE folder='discord_test-e2e';"` shows a row
- `ls groups/discord_test-e2e/` exists (workspace created)

### 2. Message a Worker

```bash
./tools/nc-inject.sh --wait test-e2e "say hello"
```

**Verify:**
- Container spawned: `docker ps | grep test-e2e`
- Agent responded (check `--wait` output or logs)
- `tail -20 logs/nanoclaw.log` shows no errors

### 3. Worker Session Resume

```bash
# Send a message to establish a session
./tools/nc-inject.sh --wait test-e2e "remember the word 'pineapple'"

# Kill the container (simulates crash)
docker kill $(docker ps -q --filter name=test-e2e)

# Send another message (should spawn fresh container, resume session)
./tools/nc-inject.sh --wait test-e2e "what word did I ask you to remember?"
```

**Verify:**
- New container spawned
- Session ID preserved in SQLite: `sqlite3 store/messages.db "SELECT session_id FROM sessions WHERE group_folder='discord_test-e2e';"`
- Agent has conversation context (may lose some due to compaction, but should have the gist)

### 4. NanoClaw Restart Recovery

```bash
# Note current workers
sqlite3 store/messages.db "SELECT folder FROM registered_groups WHERE is_main=0;"

# Restart
systemctl --user restart nanoclaw

# Workers should still be registered
sqlite3 store/messages.db "SELECT folder FROM registered_groups WHERE is_main=0;"

# Message a worker — should spawn and respond
./tools/nc-inject.sh --wait test-e2e "are you alive?"
```

**Verify:**
- All workers still registered after restart
- Workers respond to messages (fresh container spawns)
- Workspace files intact: `ls groups/discord_test-e2e/`

### 5. Neuralwatt Backend

```bash
# Create a Neuralwatt worker
./tools/nc-inject.sh master "create a worker called nw-test with backend neuralwatt"

# Or via IPC
./tools/nc-ipc.sh discord_main '{"type":"create_worker","guild_id":"YOUR_GUILD_ID","channel_name":"nw-test","folder":"discord_nw-test","trigger":"@YourBot","backend":"neuralwatt"}'

# Message it
./tools/nc-inject.sh --wait nw-test "what model are you running?"
```

**Verify:**
- Worker routes through shim: `cat data/worker-backends.json | grep nw-test`
- Shim logs show requests: check `logs/shim.error.log`
- Agent responds using an open-source model

### 6. Model Discovery

```bash
# List available models
curl -s http://localhost:3003/models | head -20

# Fuzzy match
curl -s http://localhost:3003/models/resolve/kimi%20fast
curl -s http://localhost:3003/models/resolve/qwen%20coder
curl -s http://localhost:3003/models/resolve/deepseek
```

**Verify:**
- `/models` returns a list from Neuralwatt's API
- `/models/resolve/<query>` returns a single model ID that matches the query

### 7. Model Switching

```bash
# Switch an existing Neuralwatt worker's model
./tools/nc-inject.sh master "switch nw-test to qwen coder"

# Verify the config changed
cat data/worker-backends.json | python3 -m json.tool

# Message the worker to use the new model
./tools/nc-inject.sh --wait nw-test "what model are you now?"
```

### 8. Streaming (Neuralwatt)

```bash
# Non-streaming test
curl -s http://localhost:3003/w/discord_nw-test/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-api03-placeholder" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":50,"messages":[{"role":"user","content":"Hi"}]}'

# Streaming test
curl -s http://localhost:3003/w/discord_nw-test/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-api03-placeholder" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"Hi"}]}'
```

**Verify:**
- Non-streaming returns a complete JSON response in Anthropic format
- Streaming returns SSE events (`event: message_start`, `event: content_block_delta`, etc.)

### 9. Usage Tracking

```bash
# Check usage for all workers
curl -s http://localhost:3003/usage

# Check per-worker usage
curl -s http://localhost:3003/usage/discord_nw-test
```

### 10. Destroy a Worker

```bash
./tools/nc-inject.sh master "destroy test-e2e"

# Or via IPC
./tools/nc-ipc.sh discord_main '{"type":"destroy_worker","jid":"dc:<channel-id>"}'
```

**Verify:**
- Discord channel deleted
- Registration removed: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE folder='discord_test-e2e';"` returns nothing
- Session ID preserved: `sqlite3 store/messages.db "SELECT * FROM sessions WHERE group_folder='discord_test-e2e';"` still has a row (for resume)
- Session dir preserved: `ls data/sessions/discord_test-e2e/.claude/` still exists (conversation history kept for resume)
- Agent-runner cache cleared: `ls data/sessions/discord_test-e2e/agent-runner-src/` gone
- Workspace preserved: `ls groups/discord_test-e2e/` — repos still there

### 11. Recreate with Resume

After destroying a worker, its workspace and session state are preserved on disk. Recreating with the same name triggers a collision prompt.

```bash
# First, destroy a worker that has done some work
./tools/nc-inject.sh master "destroy test-e2e"

# Recreate with the same name
./tools/nc-inject.sh master "create a worker called test-e2e"
# Master detects existing workspace → asks "resume" or "fresh"
# Answer "resume"
```

**What "resume" preserves:**
- Workspace (`groups/discord_test-e2e/`): repos, code changes, CLAUDE.md
- Session ID in SQLite: the SDK resumes the previous conversation
- SDK state (`.claude/`): conversation history, compacted context

**What "resume" rebuilds:**
- Fresh container (new image, re-runs `init.sh`)
- `init.sh` skips already-cloned repos but reinstalls tools/packages

**Verify:**
```bash
# Workspace intact
ls groups/discord_test-e2e/

# Session ID carried over
sqlite3 store/messages.db "SELECT session_id FROM sessions WHERE group_folder='discord_test-e2e';"

# Message the worker — it should have conversation context
./tools/nc-inject.sh --wait test-e2e "what were we working on?"
```

**What "fresh" does differently:** Wipes everything (workspace, session, SDK state). The worker starts completely clean as if it never existed.

### 12. Exec into a Container

```bash
# Find container
docker ps --filter name=test-e2e

# Shell in
docker exec -it $(docker ps -q --filter name=test-e2e) bash

# Inside the container, check:
ls /workspace/group/          # Repos and code
cat /workspace/group/CLAUDE.md  # Worker instructions
echo $ANTHROPIC_BASE_URL      # Which backend
env | grep NANOCLAW            # Model config
```

## After Host-Side Changes

When you modify `src/`, `tools/`, or other host code:

```bash
npm run build
npx vitest run
systemctl --user restart nanoclaw nanoclaw-shim
./tools/nc-inject.sh --wait test-e2e "say hi" && tail -10 logs/nanoclaw.log
```

**From inside a container** (e.g., master agent), trigger via the restart watchdog:
```bash
echo "reason" > /home/host/.nanoclaw-restart
```
The watchdog runs `npm run build` then `systemctl --user restart nanoclaw nanoclaw-shim`.

**Note:** `tsc` uses incremental compilation. If the build appears to no-op after
a git merge/rebase, delete `.tsbuildinfo` and rebuild:
```bash
rm -f tsconfig.tsbuildinfo && npm run build
```

## After Container-Side Changes

When you modify `container/`, `worker-profiles/`, or agent-runner source:

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw nanoclaw-shim
# Agent-runner source auto-syncs by mtime; containers respawn on next message
./tools/nc-inject.sh --wait test-e2e "say hi"
```

## After Shim Changes

When you modify `tools/anthropic-shim.ts`:

```bash
# Restart just the shim (doesn't kill worker containers)
systemctl --user restart nanoclaw-shim
# Test non-streaming
curl -s http://localhost:3003/w/discord_nw-test/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-api03-placeholder" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":50,"messages":[{"role":"user","content":"Hi"}]}'
# Test streaming (add "stream":true)
# Check logs
tail logs/shim.error.log
```

**Note:** The shim runs as a separate systemd service (`nanoclaw-shim`). Restarting
nanoclaw alone does NOT restart the shim. The restart watchdog now restarts both.

## Reading Logs

```bash
# Main NanoClaw logs
tail -f logs/nanoclaw.log

# Shim logs (Neuralwatt requests)
tail -f logs/shim.error.log

# Container logs (specific worker)
docker logs $(docker ps -q --filter name=test-e2e) 2>&1 | tail -50

# Enable shim debug logging (verbose request/response)
# Set SHIM_DEBUG=1 in the shim's environment, then restart
```

## Common Failures

| Symptom | Likely cause | Fix |
|-|-|-|
| Worker channel created, no response | `requires_trigger` is 1 | Check SQLite, should be 0 for workers |
| "create_worker: missing required fields" | `DISCORD_GUILD_ID` not in container env | Check `.env` and container-runner.ts |
| Agent doesn't know about MCP tools | Agent-runner auto-sync failed or container hasn't restarted | Kill container, message worker again (auto-syncs by mtime) |
| Container builds don't pick up changes | Docker layer caching | `./container/build.sh` (uses `--no-cache`) |
| Host code changes not taking effect | tsc incremental cache stale | `rm -f tsconfig.tsbuildinfo && npm run build` |
| Shim still running old code after restart | Only nanoclaw was restarted, not the shim | `systemctl --user restart nanoclaw-shim` (or use watchdog which restarts both) |
| Worker stuck in crash loop | Stale session state | Delete `.claude/` for that worker, restart |
| Shim returns 500 | Neuralwatt API key invalid or model not found | Check your Neuralwatt API key file, test with curl |
| Multiple workers crash with "port already allocated" | Hardcoded port mappings in worker profile | Remove `ports` from default.json, use per-worker profiles for ports |
