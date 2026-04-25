# Master and Workers

How fleet workers are created, destroyed, switched, and resumed on top of v2.

## Vocabulary

A **worker** is a v2 `agent_group` with `fleet_role='worker'`. The **master** is a v2 `agent_group` with `fleet_role='master'`. Both are full agents in their own right: each has a folder under `groups/`, its own `container.json`, its own per-session inbound/outbound DBs, and its own messaging groups. The fleet adds a couple of columns and a small set of MCP tools that only the master can see.

```sql
agent_groups (
  ...,
  fleet_role     TEXT,                 -- 'master' | 'worker' | NULL
  status         TEXT DEFAULT 'active',-- 'active' | 'archived'
  fleet_backend  TEXT,                 -- mirrors agent_provider for filtering
  fleet_model    TEXT
)
```

`fleet_role=NULL` agents are regular v2 agents and don't see fleet tools.

## MCP tools (master-only)

Defined in `container/agent-runner/src/mcp-tools/fleet.ts`. Each tool emits a system action via the outbound DB rather than calling the host directly; the host's delivery handler does the real work. This keeps the agent runner unaware of host internals and matches v2's existing pattern for `create_agent` and `install_packages`.

| Tool | Args | What happens |
|-|-|-|
| `create_worker` | `name`, `backend?`, `model?`, `instructions?` | Provisions a new worker (agent_group + folder + container.json + Discord channel + bidirectional destinations). Master is notified via inbound chat when ready. |
| `destroy_worker` | `name`, `delete_channel?` | Stops the container, archives the agent_group, optionally deletes the Discord channel. Workspace and SDK session preserved. |
| `switch_backend` | `name` (or `master`/`self`), `backend`, `model?` | Updates `agent_provider` and `container.json::providers.<backend>`, kills the container; next message uses the new provider. |
| `list_workers` | none | Host writes a formatted list as a chat message into the master's inbound DB. |

The container side returns immediately with a status string; the actual work happens on the host. The master is told "you'll be notified when done" so it doesn't sit and poll.

Tool exposure is gated on `fleet_role === 'master'` in `mcp-tools/index.ts`. The host re-checks this on the delivery side (`src/delivery.ts`) as defense in depth, the same way `create_agent` is gated.

## Host-side action handlers

Each MCP tool has a matching delivery handler in `src/modules/fleet/`:

- `create-worker.ts` — `handleCreateWorker`
- `destroy-worker.ts` — `handleDestroyWorker`
- `switch-backend.ts` — `handleSwitchBackend`
- `list-workers.ts` — `handleListWorkersRequest`

The router in `src/delivery.ts` matches `kind='system'` messages by `action` field and dispatches.

## Create flow

When the master calls `create_worker`:

1. **Name resolution.** If an archived agent_group with this name exists, take the resume path (see below). Otherwise insert a new `agent_groups` row with `fleet_role='worker'`, `status='active'`, `agent_provider=<backend>`.
2. **Folder scaffolding.** `groups/<folder>/` gets a fresh `container.json` (with `providers` map, `fleetProfile` block, `additionalMounts` from the worker profile), an empty `CLAUDE.local.md`, and skill directory symlinks. `composeGroupClaudeMd` writes the assembled `CLAUDE.md`.
3. **Discord channel.** `provisionDiscordChannel(agentGroupId, folder, name, now)` POSTs to `/guilds/<guild>/channels`, captures the channel id, creates a `messaging_groups` row with `platform_id="discord:<guild>:<channel>"`, and joins it to the worker's agent_group via `messaging_group_agents`. If `DISCORD_BOT_TOKEN` or `DISCORD_GUILD_ID` is missing, channel provisioning is skipped (fleet still works on whatever channels you wire by hand).
4. **Bidirectional destinations.** The fleet inserts two `agent_destinations` rows so the master and worker can address each other by local name in `<message to="...">` blocks. The master's destination for the worker is the worker's folder slug; the worker's destination for the master is the master's folder slug, with a numeric suffix on collision.
5. **Worker profile.** `loadWorkerProfile()` reads `~/.config/nanoclaw/worker-profiles/default.json` and `applyProfileToContainerConfig()` merges the result into the new worker's `container.json`. `mounts` go through `validateAdditionalMounts()` against the user's allowlist.
6. **Shim sync.** When `NW_SHIM_CONFIG_PATH` is set, `syncShimBackendConfig()` writes the worker's `{backend, model}` into the v1 shim's `worker-backends.json` so a fresh Neuralwatt worker doesn't 401 on its first request.
7. **Worker event** logged to `logs/worker-events.jsonl`.
8. **Master ack.** A chat message ("Worker `<name>` is ready.") is written into the master's inbound DB.

The container does not start yet. It boots the first time a message lands in the worker's channel.

## First message (container spawn)

The first message in a worker's channel routes through the v2 router:

1. **Routing.** `src/router.ts` resolves the messaging_group, finds the agent_group, opens the session.
2. **Inbound write.** Message goes into `data/v2-sessions/<ag>/<sess>/inbound.db`.
3. **Wake.** Host POSTs `http://host.docker.internal:3100/wake/<sess>`. If the container isn't running, `src/container-runner.ts` spawns one.
4. **Container spawn.** Bind mounts: `groups/<folder>/` at `/workspace/group/`, the session DBs at known paths, allowlist-validated additional mounts. Env: `ANTHROPIC_BASE_URL` set by the active provider's container-config function, `ANTHROPIC_MODEL` from `container.json::providers.<backend>.model`, `NANOCLAW_PROVIDER` from `agent_provider`, `NANOCLAW_FLEET_ROLE`, plus any worker profile env.
5. **`worker-init.sh`** runs: clones repos, runs `postClone`, links skills, runs profile tools.
6. **Agent runner starts.** The SDK opens the session (resuming `stored_session_id` if present) and begins polling the inbound DB.

## Running

The container stays alive until it's stopped, the host restarts (containers are spawned with `--rm`), the container crashes, or Docker is restarted. Fleet workers don't auto-idle; they sit waiting for the next message.

## Destroy flow

When the master calls `destroy_worker`:

1. **Container stop.** The host kills the running container if any. State already flushed by the agent runner's outbound write.
2. **Agent group archived.** `agent_groups.status = 'archived'`. The folder, session DBs, and `.claude/` state stay on disk.
3. **Destination cleanup.** The worker → master destination is removed. The master → worker destination is preserved for audit; resume reuses it.
4. **Discord channel.** Deleted unless `delete_channel: false` was passed. The `messaging_groups` row is removed either way.
5. **Worker event** logged.
6. **Ack to master.** Chat message into the master's inbound DB.

If the worker was Neuralwatt, the master reports lifetime usage stats (tokens, energy) before cleanup.

## Switch flow

`switch_backend` accepts the worker's name, `master`, or `self` (the master can switch its own provider with the same tool).

1. **Update DB.** `agent_groups.agent_provider` becomes the new backend.
2. **Update container config.** `container.json::providers.<backend>.model` is set; `provider` field becomes the active backend. Per-backend model and base_url persist, so you can flip back without re-specifying.
3. **Shim sync.** If `NW_SHIM_CONFIG_PATH` is set and the new backend is Neuralwatt, the shim's `worker-backends.json` is updated.
4. **Container kill.** The next message respawns the container with the new env.
5. **Worker event** logged with `from`/`to` backend and model.
6. **Ack.** Chat message into the master's inbound DB.

Within Neuralwatt, model-only switches don't kick the container — they just edit `data/worker-backends.json` (or `container.json` if not using the shim) and the next request uses the new model.

## Resume on recreate

`create_worker` with a name that matches an archived agent_group reactivates instead of erroring:

1. **Reactivate.** `status='active'`, update `agent_provider` if different, refresh `fleet_backend`/`fleet_model`.
2. **Re-apply profile.** The worker profile is re-read and `applyProfileToContainerConfig` overlays it on the existing `container.json` so profile changes (new repos, new tools) take effect.
3. **Re-provision channel.** If the old channel is gone, a fresh one is created; otherwise the existing `messaging_groups` row is reused.
4. **Re-wire destinations** if missing.
5. **`worker_event: 'resumed'`** logged.

Workspace and SDK session are untouched. Sending a message resumes the SDK's `stored_session_id` and continues the conversation.

## Crash-loop guard

`src/container-runner.ts` enforces `MIN_RESPAWN_INTERVAL_MS=5000`. If a container exits and the next inbound message arrives less than five seconds later, the host waits before respawning. Prevents runaway loops when init.sh or the SDK is failing fast.

## Files

| File | Role |
|-|-|
| `container/agent-runner/src/mcp-tools/fleet.ts` | MCP tool definitions (create/destroy/switch/list) |
| `src/modules/fleet/create-worker.ts` | Provision flow |
| `src/modules/fleet/destroy-worker.ts` | Archive + channel cleanup |
| `src/modules/fleet/switch-backend.ts` | Backend swap |
| `src/modules/fleet/list-workers.ts` | List → chat message |
| `src/modules/fleet/discord-channel.ts` | Discord REST wrapper |
| `src/modules/fleet/provision.ts` | messaging_groups wiring |
| `src/modules/fleet/lib.ts` | `setFleetBackend`, `syncShimBackendConfig`, helpers |
| `src/modules/fleet/events.ts` | `logs/worker-events.jsonl` writer |
| `src/db/migrations/module-fleet.ts` | Adds `fleet_role`, `status`, `fleet_backend`, `fleet_model` columns |
| `src/container-runner.ts` | Spawn, env, mounts, crash-loop guard |
