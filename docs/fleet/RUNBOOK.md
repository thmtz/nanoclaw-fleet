# Fleet Runbook

How to stand up a fleet-on-v2 install and drive workers.

## Prereqs

- Node 22+, pnpm 10+, Docker
- Discord bot (Manage Channels perm) in your guild
- Anthropic credentials — OneCLI set up, **or** `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in `.env` (the env-fallback path)

## Install

```bash
git clone <your-fork> fleet-v2
cd fleet-v2
pnpm install
./container/build.sh            # builds nanoclaw-agent-v2-<slug>:latest
```

## Configure `.env`

```bash
ASSISTANT_NAME=fleet-master
TZ=America/Denver

# Discord channel adapter (Chat SDK bridge)
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_PUBLIC_KEY=...

# Fleet channel provisioning
DISCORD_GUILD_ID=...                       # guild where worker channels get created
DISCORD_FLEET_CATEGORY_ID=...              # optional category parent

# Credentials — one of:
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # subscription token
# or
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Bot needs `Manage Channels` to provision per-worker channels. Get `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY` from `GET /oauth2/applications/@me`:

```bash
curl -s https://discord.com/api/v10/oauth2/applications/@me \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" | jq '.id, .verify_key'
```

## Seed the master

Create a `#master` channel in your guild, grab its ID, then:

```bash
DISCORD_MASTER_CHANNEL_ID=<master-channel-id> \
OWNER_DISCORD_USER_ID=<your-discord-user-id> \
pnpm exec tsx scripts/init-fleet-master-discord.ts
```

This creates the `master` agent_group with `fleet_role='master'`, wires it to the Discord channel, and promotes your Discord user to `owner`. Idempotent.

## Start the host

```bash
pnpm run dev
```

Or as a systemd service — point `ExecStart` at `node dist/index.js` after `pnpm run build`.

## Drive from Discord

Post in `#master`:

```
create a worker named refactor-auth
create a worker named triage-pr1234 based on neuralwatt kimi-k2.5
list workers
destroy refactor-auth
switch triage-pr1234 to claude
```

Each worker gets its own Discord channel under `DISCORD_FLEET_CATEGORY_ID`. Hop over, talk to the worker, come back to `#master` to manage.

## Drive from the host — `ncf`

```bash
./bin/ncf status [--json]
./bin/ncf create <name> [--backend <b>] [--model <m>]
./bin/ncf destroy <name> [--keep-channel]
./bin/ncf switch <name> <backend> [model]
./bin/ncf logs <name> [--follow]
./bin/ncf session <name>
```

Mutations queue a `kind: 'system'` row in master's `outbound.db`; the running host picks it up through normal delivery. Same code path as Discord / CLI triggers — no divergence.

## Verify end-to-end

```bash
# Fast host-side E2E (no containers):
pnpm exec tsx scripts/test-fleet-e2e.ts

# Full live E2E via CLI channel (needs pnpm run dev in another terminal):
pnpm exec tsx scripts/test-fleet-live.ts

# Discord REST proof (real guild + bot, creates + deletes a throwaway channel):
pnpm exec tsx scripts/test-fleet-discord-rest.ts
```

## Backends

| Backend | How |
|-|-|
| `claude` | Default. Claude Agent SDK → `api.anthropic.com` (or OneCLI-gated). |
| `neuralwatt` | Claude Agent SDK → shim at `http://host.docker.internal:3003`. Shim runs separately (existing `nanoclaw-shim.service` or any OpenAI-compat ↔ Anthropic translator). Set `NW_SHIM_URL` on the host to override. |
| `opencode`, `codex`, `ollama` | Install via upstream skills on the `providers` branch. |

Switch preserves per-provider settings — flipping back to a previous backend restores its model.

## Resume semantics

`destroy_worker` archives the agent_group (`status='archived'`), stops the container, deletes the Discord channel, drops destinations. Workspace (`groups/<folder>/`) and session state (`data/v2-sessions/<agent_group_id>/`) stay on disk.

`create_worker` with the same name reuses the archived row — same `agent_group_id`, workspace preserved, a fresh Discord channel is provisioned. Conversation history inside the Claude SDK's `.claude-shared/` survives.

## Where things live

```
src/modules/fleet/               — host-side handlers + Discord provisioning
src/providers/neuralwatt.ts      — host-side provider env injection
container/agent-runner/src/
  mcp-tools/fleet.ts             — MCP tools the master calls
  providers/neuralwatt.ts        — container-side provider factory
src/db/migrations/module-fleet.ts — status + fleet_* columns on agent_groups
docs/fleet/DESIGN.md             — architecture + rationale
scripts/
  init-fleet-master-discord.ts   — seed via Discord
  init-fleet-master.ts           — seed via CLI (for devbox testing)
  ncf.ts + bin/ncf               — admin CLI
  test-fleet-e2e.ts              — host-only E2E
  test-fleet-live.ts             — live E2E through real containers (CLI channel)
  test-fleet-discord-rest.ts     — Discord REST integration (channel CRUD)
  test-fleet-discord-inbound.ts  — Discord → master via debug bot, one prompt
  test-fleet-discord-full.ts     — Discord → master → worker lifecycle end-to-end
```

## Troubleshooting

| Symptom | Try |
|-|-|
| Master doesn't reply in Discord | Check `tail -f /tmp/fleet-v2.log` and confirm `Discord Gateway connected`. Make sure the bot is invited to the guild and can see the channel. |
| "OneCLI gateway not applied" | Expected if you skipped OneCLI. Confirm env-credential fallback followed with `Env credential fallback applied`. If not, check `.env` has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. |
| "Credit balance is too low" from Claude | Host shell has an `ANTHROPIC_API_KEY` from another project (common: `~/.zshrc` exports one from opencode / aider / etc.). Claude Agent SDK prefers `ANTHROPIC_API_KEY` over `CLAUDE_CODE_OAUTH_TOKEN` when both are set, so an exhausted key from elsewhere takes over your Max subscription. Launch the host with `env -u ANTHROPIC_API_KEY pnpm run dev` — the container-runner also refuses to forward `ANTHROPIC_API_KEY` when `.env` has `CLAUDE_CODE_OAUTH_TOKEN` (preferOauth path), so the fix is permanent once `.env` is set. |
| `create_worker` fails with "only the master agent can create workers" | The calling session's agent_group doesn't have `fleet_role='master'`. Re-run the seed script. |
| Worker container spawned but no reply | `ncf logs <name> --follow`. Common: bad token, unreachable shim on neuralwatt backend. |
| `list_workers` reply never comes | `list_workers_request` writes to master inbound; if master container is idle the sweep picks it up within 60s. Send another message to nudge it. |
| Stale archived workers accumulating | Safe — they cost a row + a folder. Future `ncf purge` command could clean them; not built yet. |
| Container crash-loop / memory spike | `wakeContainer` refuses respawn within 5s of the last exit (`MIN_RESPAWN_INTERVAL_MS` in `container-runner.ts`). If you see a runaway spawn storm anyway, the session's `messages_in` has accumulated an unprocessable pending row (e.g. malformed content). Inspect with `sqlite3 data/v2-sessions/<ag>/<sess>/inbound.db 'SELECT id, status, tries FROM messages_in WHERE status != "completed"'`; a `DELETE` of the offender plus a fresh wake clears it. |
| `UNIQUE constraint failed: messages_in.seq` | Retry-loop in `insertMessage` absorbs up to 32 collisions — comes from the shared `nextEvenSeq()` SELECT-then-INSERT race when multiple writers hit the same inbound.db. If you see this more than occasionally, a single deterministic duplicate is making it past Chat SDK's in-process dedupe — file a bug with the full trace. |
| `UNIQUE constraint failed: messages_in.id` | Silently absorbed by `routeInbound` — comes from Chat SDK's Discord adapter forwarding MESSAGE_CREATE twice (legacy gateway + webhook paths in same-process mode). |
