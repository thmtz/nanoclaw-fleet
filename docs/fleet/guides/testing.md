# Testing Guide

How to exercise every fleet behavior end-to-end. Written for both humans verifying changes and agents working on this codebase.

## Prereqs

```bash
pnpm run dev               # host running with hot reload, or
systemctl --user status nanoclaw

docker ps                  # docker daemon up
curl -s http://localhost:3003/models | head    # shim up (only if testing Neuralwatt)
ncf debug                  # one-shot health check
```

If anything is red, see [troubleshooting.md](troubleshooting.md).

## What changed → what to test

| You touched | Run |
|-|-|
| `src/modules/fleet/create-worker.ts` | Smoke + lifecycle script (creates, messages, destroys) |
| `src/modules/fleet/destroy-worker.ts` | Lifecycle script step "destroy then resume" |
| `src/modules/fleet/switch-backend.ts` | Lifecycle script "switch to neuralwatt" |
| `src/modules/fleet/discord-channel.ts` or `provision.ts` | Lifecycle script "channel created" assertion |
| `src/providers/{claude,neuralwatt}.ts` | Smoke + `ncf debug` (verify env injection) |
| `src/modules/status-pin/` | Smoke (verifies pin landed and edits) |
| `src/modules/throbber/` | Manual: send message, watch reaction emoji cycle |
| `container/agent-runner/src/mcp-tools/fleet.ts` | Lifecycle script (master tool calls) |
| `container/worker-init.sh` | Create a worker with repos/tools, exec in, verify |
| `scripts/ncf.ts` | Manual `ncf <command>` checks |

## Smoke test

`scripts/smoke.sh` runs in ~90s and exercises the path that breaks most often:

```bash
./scripts/smoke.sh
```

Coverage:

- `ncf status` health
- `ncf inject --wait` to the master, verify reply
- Status-pin landed in `#master`
- Discord lifecycle: create worker, message it, switch backend, destroy, recreate (resume)
- Reaps any orphan worker channels left behind by previous failed runs

The smoke uses the **debug bot** so the path is real Discord, not just IPC. See "Real Discord" below.

## Lifecycle test

`scripts/test-fleet-lifecycle.ts` is the deeper script (8 steps, ~465 lines, real Discord, real containers). It's what the smoke wraps.

```bash
pnpm exec tsx scripts/test-fleet-lifecycle.ts
```

Steps:

1. **Recreate (resume).** Reaps orphans, then creates a worker named after the test marker. If the agent_group already exists archived, resumes it.
2. **First message.** Send "what's your model?" via debug bot, expect a reply.
3. **Switch backend.** Master swaps Claude ↔ Neuralwatt.
4. **Verify switch.** Send another message, parse the reply for the new model name.
5. **Switch model within Neuralwatt.** No container restart expected.
6. **Verify model switch.** Same as step 4.
7. **Destroy.** Worker channel goes away.
8. **Recreate again.** Workspace and SDK session resume.

Each step times out independently; failures print the trace ids so you can grep host logs.

## `ncf` checks

```bash
ncf status                                         # master + workers
ncf list --json | jq                                # JSON for scripts
ncf logs <worker> --follow                          # docker logs
ncf logs <worker> --slow 5000                       # turns slower than 5s
ncf session <worker> --limit 20                     # last 20 inbound/outbound rows
ncf history --since 2026-04-01T00:00:00Z --limit 50 # lifecycle audit
ncf turns <worker> --slow 3000                      # per-turn audit
ncf inject --wait <worker> "ping"                   # write to inbound + poll for reply
ncf debug                                           # dump everything diagnostic
```

`ncf inject` writes straight into the worker's `inbound.db` and POSTs `wake/<sess>`. With `--wait`, it polls `messages_out` until a reply lands.

For the full CLI surface, see [reference/cli.md](../reference/cli.md).

## Real Discord with the debug bot

`ncf inject` skips Discord entirely. To test the actual path (Discord gateway → adapter → router → session DB → container → outbound → adapter → Discord), use a second bot:

1. Create another Discord bot in the Developer Portal ("NanoClaw Debug" or similar).
2. Invite it to the same guild with `Send Messages`, `Read Message History`, `Add Reactions`, `View Channels`.
3. Enable **Message Content Intent** in the bot settings.
4. Save the token at `~/.config/nanoclaw/debug_bot_token`.
5. Add the bot's user id to `.env`:

   ```env
   DISCORD_ALLOWED_BOT_IDS=<bot-user-id>
   ```

   The fork patches `@chat-adapter/discord` to treat allowlisted bot ids as if they were human users (otherwise the adapter ignores all bot messages).

6. Restart the host.

Send messages as the debug bot:

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

Prefer the debug bot when verifying reaction throbber, status pin edits, or message formatting. `ncf inject` won't exercise those.

## Reading logs

```bash
tail -f logs/host.log
jq 'select(.level >= 50)' logs/host.jsonl | tail
docker logs $(docker ps -q --filter name=<worker>) 2>&1 | tail -50
tail -f logs/shim.error.log    # Neuralwatt only
```

### Tracing one request

```bash
# 1. Find the inbound id
sqlite3 data/v2-sessions/<ag>/<sess>/inbound.db \
  "SELECT id, ts, payload FROM messages_in ORDER BY ts DESC LIMIT 5;"

# 2. Grep host + container logs
grep "<inbound-id>" logs/host.jsonl
docker logs <container> 2>&1 | grep "<inbound-id>"
```

## After code changes

```bash
# host source (src/)
pnpm run build
pnpm test
systemctl --user restart nanoclaw
ncf inject --wait <worker> "ping"

# agent-runner source (container/agent-runner/src/)
# auto-syncs by mtime on next spawn — just kill and respawn the container
ncf restart <worker>

# container image (container/Dockerfile or personal Dockerfile)
./container/build.sh
ncf restart <worker>
```

## Common failures

| Symptom | Likely cause | Fix |
|-|-|-|
| Worker channel created, no agent reply | Master never wrote to inbound | Check `ncf debug` for sessions; tail host.log |
| `ncf create` returns "channel already exists" | Orphan from a prior failed run | `ncf reap-orphans` |
| Neuralwatt worker 401s on first turn | Shim's `worker-backends.json` missing the entry | Set `NW_SHIM_CONFIG_PATH` and rerun `ncf switch <worker> neuralwatt <model>` |
| Status pin appears multiple times | Stale pins from a prior bot identity | Restart the host; the sweep runs on startup |
| Container builds don't pick up changes | Docker layer cache | `./container/build.sh` rebuilds the agent layer |
| Master doesn't see fleet MCP tools | `fleet_role` not set on master agent_group | Re-run `init-fleet-master-discord.ts` |

## Files

| File | Role |
|-|-|
| `scripts/smoke.sh` | Quick end-to-end smoke |
| `scripts/test-fleet-lifecycle.ts` | Deeper 8-step lifecycle |
| `scripts/init-fleet-master-discord.ts` | Master seeding |
| `scripts/ncf.ts` | The CLI itself |
| `~/.config/nanoclaw/debug_bot_token` | Debug bot token |
