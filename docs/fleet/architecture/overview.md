# Fleet Architecture Overview

NanoClaw v2 isolates one Claude Agent SDK process per session, attached to a messaging channel. The fleet sits on top of that and adds a master/worker topology: one master agent orchestrates dynamic workers, each in its own Discord channel and container, each with its own filesystem and inference backend. Workers are full v2 `agent_groups`, just with `fleet_role='worker'` and bidirectional agent-to-agent destinations wired to the master.

Read this first, then follow links into the component docs.

## Goals

1. **On-demand workers** with their own repos and tools, created and destroyed from Discord. Workspaces persist; only containers are ephemeral.
2. **Dual inference backends.** Claude (OneCLI vault, default) and Neuralwatt (OpenAI-compat shim). Backend persists per worker; runtime switching swaps it without losing the session.
3. **Dumb master, smart workers.** Master orchestrates lifecycle (create, destroy, switch, list). Workers do the work. Master turns stay short.
4. **Loud failures.** Errors propagate; container crashes notify the master; nothing silently falls back.
5. **Resume on recreate.** Destroying a worker archives the agent_group. Recreating with the same name reactivates it with workspace and SDK session intact.
6. **Self-testable.** `scripts/smoke.sh` and `scripts/test-fleet-lifecycle.ts` exercise the whole path end-to-end through real Discord using the debug bot.

## Topology

```
Discord
  #master          ←→  NanoClaw host  ←→  Master agent (lifecycle only)
  #worker-alpha    ←→       │         ←→  Container A (Claude or Neuralwatt)
  #worker-beta     ←→       │         ←→  Container B (Claude or Neuralwatt)
```

The Chat SDK adapter owns the gateway. The host routes inbound messages by `messaging_group.platform_id` to the right session's `inbound.db`. The agent runner inside the container polls inbound, calls the SDK, writes to `outbound.db`. The host polls outbound (and gets a wake POST on every write) and delivers via the same adapter.

Master and workers are both v2 `agent_groups`. The fleet contributes:

- A `fleet_role` column (`master` | `worker` | NULL).
- Master-only MCP tools (`create_worker`, `destroy_worker`, `switch_backend`, `list_workers`).
- Bidirectional `agent_destinations` so master and worker can address each other by local name.
- A small set of host modules under `src/modules/fleet/` that handle the system-action side of those tools.

## What the fleet adds

The fleet is a thin layer on top of v2. Most of the surface is reusable:

| Concern | Owner |
|-|-|
| Entity model (users, agent_groups, messaging_groups) | v2 |
| Two-DB session split (inbound.db / outbound.db) | v2 |
| Channel adapters (Discord, Slack, Telegram via skills) | v2 |
| Container runner, OneCLI credential vault | v2 |
| Provider abstraction (`AgentProvider`) | v2 |
| Master/worker model + lifecycle MCP tools | fleet |
| Discord channel-per-worker provisioning | fleet |
| Per-backend persistent config (`container.json::providers`) | fleet |
| Neuralwatt provider (host + container side) | fleet |
| `ncf` CLI | fleet |
| Worker profile (repos, tools, mounts, skills_repo) | fleet |
| Personal instructions layering (`global/master/worker.md`) | fleet |
| Pinned status messages + heartbeat throbber | fleet |
| Mount allowlist + default blocklist | fleet (extended) |
| Per-worker turn audit + worker-events JSONL | fleet |
| Energy read-through from Neuralwatt shim usage | fleet |

Specific files:

- `src/modules/fleet/` — host-side handlers (`create-worker.ts`, `destroy-worker.ts`, `switch-backend.ts`, `list-workers.ts`, `discord-channel.ts`, `provision.ts`, `worker-profile.ts`, `events.ts`, `lib.ts`).
- `src/modules/status-pin/`, `src/modules/throbber/`, `src/modules/mount-security/`.
- `src/providers/{claude,neuralwatt}.ts` — host-side provider container-config registration.
- `container/agent-runner/src/mcp-tools/fleet.ts` — container-side MCP tool definitions (master-only).
- `container/agent-runner/src/providers/{claude,neuralwatt}.ts` — runtime provider registration.
- `container/agent-runner/src/mcp-tools/introspect.ts` — `get_backend`, `get_usage`, `get_models` (all workers).
- `container/worker-init.sh` — boots the worker (clones repos, runs tools, links skills).
- `scripts/ncf.ts` — the CLI.

## Inference routing

Workers don't know which backend they use. The SDK always sends Anthropic-format requests; routing happens at the network boundary.

- **Claude workers** — `ANTHROPIC_BASE_URL` defaults to `api.anthropic.com`; OneCLI's vault attaches credentials.
- **Neuralwatt workers** — `ANTHROPIC_BASE_URL` is set to `http://host.docker.internal:3003/w/<folder>`. The Neuralwatt shim translates Anthropic Messages requests into OpenAI `chat/completions`, attaches the real API key, and returns Anthropic-format SSE.

Per-backend model and base_url persist in `groups/<folder>/container.json::providers.<backend>`. Switching backends updates `provider` in the same file and kills the container; the next spawn picks up the new env. Within Neuralwatt, model switches edit `data/worker-backends.json` (synced from `container.json` when `NW_SHIM_CONFIG_PATH` is configured) and take effect on the next request.

See [inference-routing.md](inference-routing.md) for the full request flow.

## Lifecycle in one diagram

```
                          ┌──────────────────────┐
ncf create / master MCP ──┤   master outbound.db │── system action: create_worker
                          └──────────┬───────────┘
                                     ↓
                         src/modules/fleet/create-worker.ts
                                     ↓
   ┌─── messaging_groups + messaging_group_agents ──── DB
   ├─── Discord REST: create channel ─────────────── Discord
   ├─── agent_destinations (master ↔ worker) ─────── DB
   ├─── container.json (providers, fleetProfile) ── filesystem
   ├─── composeGroupClaudeMd (CLAUDE.md) ─────────── filesystem
   └─── chat msg into master inbound.db ─────────── master gets ack
```

For the parallel destroy and switch flows, see [master-workers.md](master-workers.md).

## Storage layout

Worker state spans a few stores. The shape on disk is the v2 baseline; fleet just adds a few entries.

| Layer | Location | Purpose |
|-|-|-|
| Agent group registration | central `agent_groups` table | name, folder, fleet_role, status, agent_provider |
| Session id | `session_state.stored_session_id` | SDK session for resume |
| SDK state | `data/v2-sessions/<ag>/<sess>/.claude/` | transcript, scratchpad |
| Workspace | `groups/<folder>/` | cloned repos, edits, CLAUDE.md |
| Worker config | `groups/<folder>/container.json` | provider, providers map, fleetProfile, additionalMounts |
| Per-worker usage | `data/v2-sessions/<ag>/<sess>/turns.jsonl` | tokens, latency, stop reason |
| Worker events | `logs/worker-events.jsonl` | created, destroyed, switched, resumed |
| Status pin ids | central `chat_sdk_kv` | per-channel pinned message ids |

Destroying a worker archives the agent group (`status='archived'`) and stops the container. Workspace, session id, and SDK state stay on disk so a future `create_worker` with the same name reactivates the existing record.

## Observability

A user message becomes the trace id. The host logs it on routing, delivery, wake, and outbound write. The container logs the same id per turn in `turns.jsonl`. Lifecycle events land in `logs/worker-events.jsonl`. The `ncf history`, `ncf turns`, `ncf logs`, and `ncf session` commands surface those streams; the master and workers can query them via `worker_history`, `get_usage`, and `get_models` MCP tools. Energy data flows through when `NW_SHIM_USAGE_PATH` points at the shim's accumulator.

See [observability.md](observability.md).

## Upstream relationship

The fork tracks [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). v2 is a ground-up rewrite of v1 (entity model, two-DB session split, OneCLI vault, provider abstraction); the fleet is a port of v1's `nanoclaw-fleet` features onto v2's foundation. Every fleet module reuses v2 primitives where it can. The diff against `origin/main` is concentrated in `src/modules/fleet/`, `src/modules/status-pin/`, `src/modules/throbber/`, `src/providers/`, `container/agent-runner/src/mcp-tools/fleet.ts`, and `scripts/ncf.ts`. Most of upstream is untouched.

For the parity matrix and what survived the port, see [PARITY.md](../PARITY.md). For design rationale, see [DESIGN.md](../DESIGN.md).

## Further reading

- [Master and workers](master-workers.md)
- [Inference routing](inference-routing.md)
- [Worker profile](worker-profile.md)
- [Instructions composition](instructions.md)
- [Status pin and throbber](status-pin-throbber.md)
- [Observability](observability.md)
- [Setup guide](../guides/setup.md)
- [Testing guide](../guides/testing.md)
- [`ncf` CLI](../reference/cli.md)
