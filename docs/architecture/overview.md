# Architecture Overview

NanoClaw Fleet extends [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) into a fleet manager. The base repo isolates one Claude Agent SDK process inside a container, attached to a messaging channel. The fleet adds a master/worker topology: one master agent orchestrates dynamic workers, each in its own Discord channel and container, each with its own filesystem and inference backend.

This doc is the spine. Read it first, then follow links into the component docs.

## Goals

1. **On-demand containerized agents.** Spin up a coding agent with its own repos and tools at will, from Discord or a phone. Tear it down when done.

2. **Dual inference backends.** Anthropic (OAuth via Claude Code or API key) for Claude models, Neuralwatt for OpenAI-compatible open-source models such as Kimi, Qwen, and GLM. Backend is chosen at create time and fixed for the container's lifetime.

3. **Runtime model switching.** Within a Neuralwatt worker, the model can change mid-conversation. The shim re-reads `data/worker-backends.json` per request, so a master can say "switch foo to qwen 3.5" and the next call uses the new model.

4. **Fuzzy model discovery.** The shim's `/models/resolve/<query>` lets the master accept "kimi fast" and turn it into a real Neuralwatt model id without anyone memorising provider strings.

5. **Dumb master, smart workers.** The master does orchestration only: call MCP tools (create, destroy, switch, list), report results. Workers do the engineering. This keeps master turns short, predictable, and cheap.

6. **Loud failures.** Errors propagate with context. If a container crashes, the master hears about it; if the API returns 400, the user sees the message. No silent fallbacks, no swallowed exceptions.

7. **Self-testable by agents.** An agent working on this codebase can exercise every behavior end-to-end: create workers, message them via the debug bot, switch backends, destroy and resume, read logs, exec into containers. See [guides/testing.md](../guides/testing.md).

8. **Resume on restart.** When NanoClaw restarts, workers come back automatically. Discord channels, SQLite registrations, repos, and session ids all survive. Only the container is ephemeral; it respawns on the next message.

9. **Code survives container death.** Repos and uncommitted edits live on the host via bind mounts (`groups/<folder>/`). Containers run with `--rm`. A fresh container picks up the same workspace.

10. **Streaming inference.** The translation shim streams SSE for Neuralwatt requests, including tool-call accumulation and reasoning blocks, so the SDK gets real-time output instead of buffered responses.

## Topology

```
Discord Server
  #master          ←→  NanoClaw host  ←→  Master agent (lifecycle only)
  #worker-alpha    ←→       │         ←→  Container A (Anthropic or Neuralwatt)
  #worker-beta     ←→       │         ←→  Container B (Anthropic or Neuralwatt)
```

One Discord bot owns the gateway. The host process routes messages by channel id to the right worker, spawns the container if it isn't running, and processes lifecycle commands from the master.

## Components

The **host process** (`src/index.ts`, `src/container-runner.ts`) runs the gateway listener, polls IPC tasks, manages the container pool, and drives the per-worker status pins. It also runs the **resource monitor** (`src/resource-monitor.ts`), which alerts the master channel when memory, disk, or container slots cross thresholds.

The **IPC handler** (`src/ipc.ts`) processes lifecycle commands: `create_worker`, `destroy_worker`, `switch_backend`, `cleanup_workers`, plus task scheduling. Containers write JSON files into `data/ipc/<group>/tasks/`; the host consumes them and writes responses back.

Two outbound proxies handle credentials and inference routing:

- **Credential proxy** (`src/credential-proxy.ts`, port 3001) injects OAuth tokens or API keys for Anthropic workers. Real credentials never enter the container.
- **Translation shim** (`tools/anthropic-shim.ts`, port 3003) translates Anthropic Messages requests into OpenAI `chat/completions` for Neuralwatt workers, handles streaming SSE, and records per-worker usage.

Inside each container, the **agent runner** (`container/agent-runner/src/`) wraps the Claude Agent SDK, runs `init.sh` from the worker profile, and registers MCP tools (`send_message`, `schedule_task`, `worker_history`, `get_usage`, etc.). Lifecycle operations (create, destroy, switch) live on the host and are driven from the master via the `ncf` CLI. **Worker profiles** (`worker-profiles/default.json`) declare what each worker boots with: repos to clone, tools to install, mounts to expose, the CLAUDE.md to use.

## Inference routing

Workers don't know which backend they use. The Claude Agent SDK always sends Anthropic-format requests. Routing happens at the network boundary:

- **Anthropic workers** → credential proxy (`:3001`) → `api.anthropic.com`
- **Neuralwatt workers** → translation shim (`:3003/w/<folder>/`) → `api.neuralwatt.com`

The shim is the only piece that knows about format differences. See [inference-routing.md](inference-routing.md) for the full request flow and [streaming-shim.md](streaming-shim.md) for the SSE story.

## Model discovery

The shim exposes:

- `GET /models` — every Neuralwatt model the proxy has seen
- `GET /models/resolve/<query>` — fuzzy match a natural-language query to a real model id

The master uses `/models/resolve/` to turn "kimi fast" into `moonshotai/Kimi-K2.5-fast` before calling `ncf create`. See [model-discovery.md](model-discovery.md).

## Storage layout

Worker state spans SQLite, the workspace, and the SDK session directory.

| Layer | Location | Purpose |
|-|-|-|
| Registration | SQLite `registered_groups` | Channel id → folder, backend, model |
| Session id | SQLite `sessions` | SDK session for resume |
| SDK state | `data/sessions/<folder>/.claude/` | Agent transcript, scratchpad |
| Workspace | `groups/<folder>/` | Cloned repos, edits, CLAUDE.md |
| Worker config | `data/worker-backends.json` | Backend and model per folder |
| Usage | `data/worker-usage.json` | Per-worker requests, tokens, energy |

Destroying a worker removes the registration and the running container. Workspace, session id, and SDK state stick around so a future `ncf create` (or `create_worker` IPC) with `reuse: "resume"` can drop the agent back into the same conversation. See [container-lifecycle.md](container-lifecycle.md) for the full survival matrix.

## The resume vs. update tension

Resume is valuable, but it fights container updates. When you change `init.sh`, rebuild the container image, or update worker-profile tools, existing workers keep running on the stale container. New containers get the changes; `init.sh` is idempotent and skips already-cloned repos and already-installed tools.

The ground rules:

- Container image changes take effect on the next spawn (after `ncf restart` or destroy + recreate).
- `init.sh` runs every spawn but is idempotent. Force a tool upgrade by clearing the install first.
- Agent-runner source auto-syncs by mtime. Changes pick up on the next spawn with no manual step.
- Worker profile changes sync to SQLite at host startup but don't kick existing containers.
- For a clean slate: destroy and recreate with `fresh`. To keep repos but lose the session, recreate with `resume`.

There is no rolling-update mechanism. This is an open design area.

## Observability

A single user message crosses six layers: Discord, host, container, agent SDK, API, then back. Every message gets a trace id (`t-<ts>-<hex>`, generated by `src/trace.ts`) at the host. The id propagates through container input and agent-runner stderr, so you can grep one id to follow a request end-to-end.

The host writes pretty logs to stdout (captured by systemd into `logs/nanoclaw.log`) and structured JSONL to `logs/nanoclaw.jsonl` for programmatic queries. Container stderr is archived per spawn at `logs/workers/<folder>/stderr-<ts>.log`. Per-worker inference is logged at `logs/workers/<folder>/turns.jsonl` (model, tokens, latency, stop reason, energy). Lifecycle events (create, destroy, backend switch, resume) land in `logs/worker-events.jsonl`.

For deeper notes on the design, see [design/observability.md](../../design/observability.md).

## Upstream

The fork tracks [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). Upstream owns container isolation, channel skills, the Claude Agent SDK shim around `query()`, and the credential model. The fork adds the master/worker topology, dual-backend routing, runtime model switching, energy reporting, the `ncf` CLI, and IPC-driven lifecycle. For upgrade workflow, see [guides/branch-fork-maintenance.md](../guides/branch-fork-maintenance.md).

## Further reading

- [Inference routing](inference-routing.md) — request flow per backend
- [Model discovery](model-discovery.md) — fuzzy matching, resolve endpoint
- [Container lifecycle](container-lifecycle.md) — create, run, destroy, resume in detail
- [Streaming shim](streaming-shim.md) — SSE translation, tool-call accumulation
- [Energy tracking](energy-tracking.md) — per-worker joules, watt-hours, status pin
- [Setup guide](../guides/setup.md) — first-time install
- [Testing guide](../guides/testing.md) — exercising the system end-to-end
- [Personal config](../guides/personal-config.md) — `~/.config/nanoclaw/` layout
