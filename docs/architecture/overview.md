# Architecture Overview

[NanoClaw](https://github.com/qwibitai/nanoclaw) is a lightweight personal assistant that runs Claude agents in containers, connected to messaging channels. This fork extends it for **dynamic coding agents**: a master agent orchestrates isolated workers from Discord, each with its own channel, container, filesystem, and inference backend.

## Goals

1. **On-demand containerized agents.** Spin up a coding agent in its own isolated environment at will, from Discord (or a phone). Tear it down when done.

2. **Dual inference backends.** Workers can use either Anthropic (via OAuth / Claude Code Max subscription) or Neuralwatt's OpenAI-compatible endpoints (open-source models like Kimi, Qwen, DeepSeek). The backend is chosen at worker creation time.

3. **Runtime model switching.** Change a worker's model without destroying it. The master can say "switch worker foo to kimi-k2.5-fast" and it takes effect on the next request. The shim re-reads config per-request.

4. **Model discovery.** The master agent can query available Neuralwatt models and fuzzy-match natural language ("kimi fast") to model IDs (`moonshotai/Kimi-K2.5-fast`). You say "create agent foo using neuralwatt kimi fast" without memorizing model identifiers.

5. **Dumb master, smart workers.** The master channel should do minimal thinking. Its job is to call MCP tools with the right arguments (create, destroy, list, switch). It does not reason about code, debug issues, or make architectural decisions. Workers handle all the real work. This keeps master interactions fast and predictable.

6. **Loud failures.** Errors and failures must be visible, not masked. If a container crashes, the master hears about it. If an API call fails, the error propagates with context. No silent fallbacks, no swallowed exceptions. We fix root causes, not symptoms.

7. **Self-testable by coding agents.** An agent working on this codebase must be able to exercise every behavior on its own: create workers, message them, test model switching, test resume, read logs, exec into containers. See [guides/testing.md](../guides/testing.md).

8. **Session resume on crash/restart.** When NanoClaw restarts (crash, reboot, deployment), workers resume automatically. Discord channels, SQLite registrations, workspace files, and session IDs all survive. Only the running containers are lost — they respawn on next message.

9. **Code survives container death.** Cloned repos and uncommitted changes live on the host via bind mounts (`groups/{worker}/`). Containers are ephemeral (`--rm`). When a container dies, repos and code are still there. A fresh container picks up where the old one left off.

10. **Streaming inference.** The translation shim supports streaming SSE for Neuralwatt backends. The SDK gets real-time token output instead of waiting for buffered responses.

## Architecture

```
Discord Server
  #master          ←→  NanoClaw host  ←→  Master agent (lifecycle only)
  #worker-alpha    ←→       │         ←→  Container A (Anthropic or Neuralwatt)
  #worker-beta     ←→       │         ←→  Container B (Anthropic or Neuralwatt)
```

One Discord bot token. The host process owns the gateway and routes messages by channel ID. Each worker is a Docker container running the Claude Agent SDK.

### Key Components

The **host process** runs the message loop, polls for new messages, spawns containers, and processes IPC commands. The **container runner** builds the correct Docker invocation for each worker (mounts, env vars, backend routing). The **IPC handler** processes lifecycle commands from the master (create, destroy, transfer, cleanup).

Two proxies handle credentials and API translation. The **credential proxy** (port 3001) injects OAuth tokens for Anthropic workers. The **translation shim** (port 3003) converts between Anthropic and OpenAI API formats for Neuralwatt workers, including streaming SSE.

Inside each container, the **agent runner** wraps the Claude Agent SDK and exposes MCP tools (send_message, schedule_task, etc.). Worker management (create, destroy, switch) uses the `ncf` CLI. **Worker profiles** define what each worker gets at boot: repos to clone, tools to install, credentials to mount.

### Inference Routing

Workers don't know which backend they use. The SDK always sends Anthropic-format requests. Routing happens at the infrastructure level:

- **Anthropic workers** → credential proxy (`:3001`) → `api.anthropic.com`
- **Neuralwatt workers** → translation shim (`:3003/w/{folder}/`) → `api.neuralwatt.com`

The shim translates request/response format (Anthropic ↔ OpenAI) and handles streaming SSE translation. See [inference-routing.md](inference-routing.md) for details.

### Model Discovery

The shim exposes:

- `GET /models` — lists all available Neuralwatt models
- `GET /models/resolve/<query>` — fuzzy-matches a natural language query to a model ID

The master agent uses these to resolve "kimi fast" → `moonshotai/Kimi-K2.5-fast` before passing the model to `ncf create`. See [model-discovery.md](model-discovery.md) for details.

### Storage and Persistence

Worker state is spread across SQLite, session directories, and the workspace. Destroying a worker removes its registration but preserves the session ID, SDK state, and workspace, so recreating with `reuse: "resume"` can continue the previous conversation. See [container-lifecycle.md](container-lifecycle.md) for the full storage layers breakdown.

### The Resume vs. Update Tension

Session resume is valuable, but it's in tension with container updates. When you change `init.sh`, rebuild the container image, or update worker-profile tools, existing workers keep running on stale containers. New containers get the updates, but `init.sh` skips already-cloned repos.

Current approach:

- **Container image updates** take effect on next container spawn (restart or destroy/recreate)
- **init.sh changes** take effect on next spawn, but skip already-completed steps (e.g. repos already cloned)
- **Agent-runner source** is auto-synced by mtime on each container spawn. Changes take effect automatically.
- **Worker profile changes** are synced to SQLite on startup, but don't trigger container restarts

When you need a clean slate: destroy the worker, delete its session cache, and recreate. The workspace (repos, code) is preserved unless you explicitly choose "fresh" on recreate.

There is no automatic "rolling update" mechanism. This is an open design area.

### Observability

A single user message crosses six layers (Discord → host → container → agent SDK → API → back). Every message gets a **trace ID** (`t-<ts>-<hex>`) at the host that propagates through container input and agent-runner stderr, so you can grep one ID to follow a request end-to-end. Container stderr is archived to `logs/workers/<folder>/stderr-<ts>.log` on exit. The host writes structured JSONL with trace IDs on all message-path events. See [design/observability.md](../../design/observability.md) for the full design.

## Upstream

This fork tracks [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). The upstream project provides the core channel system, container isolation, and skill architecture. This fork adds dynamic workers, dual-backend inference, model discovery, streaming, and energy tracking.

## Further Reading

- [Inference routing](inference-routing.md) — how API traffic flows between backends
- [Model discovery](model-discovery.md) — fuzzy model matching
- [Container lifecycle](container-lifecycle.md) — create, run, destroy, resume in detail
- [Streaming shim](streaming-shim.md) — SSE translation for Neuralwatt
- [Energy tracking](energy-tracking.md) — per-worker usage metrics
- [Setup guide](../guides/setup.md) — getting started
- [Testing guide](../guides/testing.md) — exercising the system end-to-end
