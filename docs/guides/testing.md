# Testing Guide

How to exercise every NanoClaw Fleet behavior end-to-end. Written for both humans verifying changes and agents working on this codebase.

## Prerequisites

```bash
systemctl --user status nanoclaw         # host process, must be active
systemctl --user status nanoclaw-shim    # only needed for Neuralwatt tests
docker ps                                 # docker daemon up
```

If the host isn't running: `systemctl --user start nanoclaw`. After source changes: `npm run build && systemctl --user restart nanoclaw`.

## What changed → what to test

| You touched | Run |
|-|-|
| `src/ipc.ts` (lifecycle) | Scenarios 1–4, 10, 11 |
| `src/container-runner.ts` (mounts, env) | Scenario 1, then 12 (exec in, check env). Look for trace ids in `logs/nanoclaw.jsonl`. |
| `container/` or `worker-profiles/` | Rebuild image, restart, message a worker. See "After container-side changes". |
| `tools/anthropic-shim.ts` | Restart shim, scenarios 5–9, then "After shim changes". |
| `container/agent-runner/src/` (MCP tools) | Restart, message a worker. Auto-syncs by mtime. |
| Inference routing or model config | Scenarios 5–8. |

## Quick smoke

`tools/e2e-test.ts` creates temporary workers, exercises them, and cleans up on exit. Runs from the host or inside the master container.

```bash
npx tsx tools/e2e-test.ts                                # ~65s
npx tsx tools/e2e-test.ts --skip-nw                      # ~45s, no Neuralwatt
cd /workspace/project && npx tsx tools/e2e-test.ts       # from master
```

## Host-side tools

```bash
ncf status [--json]                              # all workers, containers, backends
ncf logs <worker> [--cache | --slow | --follow]  # per-worker turn audit
ncf inject [--wait] <channel> <msg>              # write a message into IPC
ncf switch <worker> <backend> [model]            # change backend or model
ncf create <name> [--backend ...] [--model ...]  # create
ncf destroy <worker>                             # destroy (workspace preserved)
ncf restart <worker> [--fresh]                   # restart container
ncf session <worker> [n] [--live | --json]       # transcript
ncf history [worker] [--since DATE] [--limit N]  # lifecycle events
ncf debug                                         # paths, DB, containers, proxies
ncf rebuild                                       # rebuild image
ncf test [--skip-nw]                              # the smoke test above
```

`ncf inject --wait` polls docker logs until the agent responds, then prints the output.

## Scenarios

### 1. Create a worker

```bash
ncf inject master "create a worker called test-e2e"   # via master
ncf create test-e2e                                    # direct (bypasses master)
```

Verify: `#test-e2e` channel appears, `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE folder='discord_test-e2e';"` returns a row, `ls groups/discord_test-e2e/` exists.

### 2. Message a worker

```bash
ncf inject --wait test-e2e "say hello"
```

Verify: container appears in `docker ps`, agent replies, no errors in `logs/nanoclaw.log`.

### 3. Session resume after container kill

```bash
ncf inject --wait test-e2e "remember the word pineapple"
ncf restart test-e2e
ncf inject --wait test-e2e "what word did I ask you to remember?"
```

Verify: new container spawned, session id preserved (`sqlite3 store/messages.db "SELECT session_id FROM sessions WHERE group_folder='discord_test-e2e';"`), agent has context.

### 4. NanoClaw restart recovery

```bash
sqlite3 store/messages.db "SELECT folder FROM registered_groups WHERE is_main=0;"
systemctl --user restart nanoclaw
sqlite3 store/messages.db "SELECT folder FROM registered_groups WHERE is_main=0;"
ncf inject --wait test-e2e "are you alive?"
```

Verify: registrations survive, workers respond after the restart, workspace files intact at `groups/discord_test-e2e/`.

### 5. Neuralwatt backend

```bash
ncf create nw-test --backend neuralwatt
ncf inject --wait nw-test "what model are you running?"
```

Verify: `data/worker-backends.json` has the entry, shim logs show requests (`tail logs/shim.error.log`), agent responds via the open-source model.

### 6. Model discovery

```bash
curl -s http://localhost:3003/models | head -20
curl -s http://localhost:3003/models/resolve/kimi-fast
curl -s http://localhost:3003/models/resolve/qwen-coder
curl -s http://localhost:3003/models/resolve/deepseek
```

Verify: `/models` returns the catalog, `/models/resolve/<query>` returns one matching id.

### 7. Model switching

```bash
ncf switch nw-test neuralwatt qwen-coder
ncf status --json | jq '.workers[] | select(.folder=="discord_nw-test")'
ncf inject --wait nw-test "what model are you now?"
```

### 8. Streaming (Neuralwatt)

```bash
# non-streaming
curl -s http://localhost:3003/w/discord_nw-test/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: placeholder" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":50,"messages":[{"role":"user","content":"Hi"}]}'

# streaming
curl -s http://localhost:3003/w/discord_nw-test/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: placeholder" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"Hi"}]}'
```

Verify: non-streaming returns Anthropic JSON; streaming returns `event: message_start`, `event: content_block_delta`, `event: message_stop`.

### 9. Usage tracking

```bash
curl -s http://localhost:3003/usage
curl -s http://localhost:3003/usage/discord_nw-test
```

### 10. Destroy a worker

```bash
ncf destroy test-e2e
```

Verify: Discord channel deleted, registration gone, session id still present in `sessions` (for resume), `data/sessions/discord_test-e2e/.claude/` preserved, `agent-runner-src/` cleared, `groups/discord_test-e2e/` preserved.

### 11. Recreate with `resume`

```bash
ncf inject master "create a worker called test-e2e"
# master detects the leftover workspace and asks resume vs fresh
# answer: resume
ncf inject --wait test-e2e "what were we working on?"
```

Resume preserves the workspace, the SDK session, and `.claude/`. It rebuilds the container and re-runs `init.sh` (idempotent). Choose `fresh` instead if you want a clean slate.

### 12. Exec into a container

```bash
docker ps --filter name=test-e2e
docker exec -it $(docker ps -q --filter name=test-e2e) bash
# inside:
ls /workspace/group/
cat /workspace/group/CLAUDE.md
echo $ANTHROPIC_BASE_URL
env | grep NANOCLAW
```

## After host changes

```bash
npm run build
npx vitest run
systemctl --user restart nanoclaw
ncf inject --wait test-e2e "ping" && tail -10 logs/nanoclaw.log
```

## After container-side changes

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw
# agent-runner source auto-syncs by mtime; the next message picks it up
ncf inject --wait test-e2e "ping"
```

## After shim changes

```bash
systemctl --user restart nanoclaw-shim

curl -s http://localhost:3003/w/discord_nw-test/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: placeholder" -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-6","max_tokens":50,"messages":[{"role":"user","content":"Hi"}]}'

tail logs/shim.error.log
```

## Real Discord with the debug bot

`ncf inject` writes straight to IPC, bypassing Discord. To verify the actual gateway path (Discord → host → container → Discord), use a second bot.

1. Create another Discord bot (e.g. "NanoClaw Debug") in the Developer Portal.
2. Invite it with `Send Messages`, `Read Message History`, `Add Reactions`, `View Channels`.
3. Enable **Message Content Intent** in the bot settings.
4. Save the token at `~/.config/nanoclaw/debug_bot_token`.
5. Add `DISCORD_ALLOWED_BOT_IDS=<bot-user-id>` to `.env`. NanoClaw normally ignores all bot messages; this allowlists the debug bot as a "user".
6. `systemctl --user restart nanoclaw`.

```bash
DEBUG_TOKEN=$(cat ~/.config/nanoclaw/debug_bot_token)

# send
curl -s -X POST -H "Authorization: Bot $DEBUG_TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"hi from debug bot"}' \
  "https://discord.com/api/v10/channels/<channel-id>/messages"

# read
curl -s -H "Authorization: Bot $DEBUG_TOKEN" \
  "https://discord.com/api/v10/channels/<channel-id>/messages?limit=5"
```

Prefer the debug bot when you're testing message delivery, reactions, or formatting. `ncf inject` doesn't exercise those.

## Reading logs

```bash
tail -f logs/nanoclaw.log                                # pretty
jq 'select(.level >= 50)' logs/nanoclaw.jsonl | tail     # errors as JSON
tail -f logs/shim.error.log                              # shim
docker logs $(docker ps -q --filter name=test-e2e) 2>&1 | tail -50
```

### Trace ids end-to-end

Every user message gets a trace id (`t-<ts>-<hex>`) at the host. The id propagates through container input and agent-runner stderr, so one grep follows a request across layers.

```bash
jq 'select(.msg == "Processing messages") | .traceId' logs/nanoclaw.jsonl | tail -3
grep "t-1775854357638-9475" logs/nanoclaw.*.jsonl logs/workers/*/stderr-*.log
```

Container stderr is archived per spawn at `logs/workers/<folder>/stderr-<ts>.log` (last 20), so trace ids remain searchable after the container exits.

For shim payload inspection, set `SHIM_DUMP=1` and the shim writes full request bodies to `/tmp/shim-dump-<folder>-<ts>.json`. Useful for verifying the system prompt and tools that actually reach the provider.

## Common failures

| Symptom | Likely cause | Fix |
|-|-|-|
| Worker channel exists, no response | `requires_trigger=1` | Set to 0 in `registered_groups` |
| "ncf create: missing required fields" | `DISCORD_GUILD_ID` not exported | Confirm in `.env`; restart |
| Agent doesn't see new MCP tools | Stale agent-runner cache | `ncf restart <worker>` |
| Container build doesn't pick up changes | Docker layer cache | `./container/build.sh` |
| Worker stuck in crash loop | Stale `.claude/` | Destroy and recreate with `fresh` |
| Shim returns 500 | Bad Neuralwatt key or unknown model | Check key file; curl the model directly |
