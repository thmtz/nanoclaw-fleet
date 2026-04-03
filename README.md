# NanoClaw (Agent Fleet Manager)

> Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) — a lightweight, secure personal assistant that runs Claude agents in containers, connected to messaging channels.

This fork turns NanoClaw into a **fleet manager for isolated coding agents**, all controlled from Discord. Send a message in a master channel to spin up a new agent. It gets its own Discord channel, Docker container, and pre-configured dev environment (cloned repos, tools, credentials). Tear it down when you're done. Workers are fully isolated from each other and can run on Claude or open-source models, with live model switching and per-worker usage tracking.

<img src="assets/screenshot-status.png" alt="Status dashboard showing master and five workers" width="700">

## Quick Start

```bash
git clone https://github.com/thmtz/nanoclaw-fleet.git && cd nanoclaw-fleet
claude   # or your coding agent of choice
```

Then run `/setup`. The setup skill walks you through everything: dependencies, Docker, Discord bot, worker profiles, and service configuration. It handles the work automatically and only pauses when it needs your input (creating a Discord bot, pasting tokens, etc.).

If you prefer to set things up manually, the [full setup guide](docs/guides/setup.md) has step-by-step instructions. The short version:

1. Fork and clone this repo
2. Create a Discord server + bot with Manage Channels permission
3. Configure `.env` (bot token, guild ID, model, GitHub PAT path)
4. Set up worker profiles in `~/.config/nanoclaw/worker-profiles/`
5. `npm run build && systemctl --user start nanoclaw`
6. In `#master`: "create a worker named my-task"

## Using Workers

All interaction happens in Discord. You talk to the **master agent** in `#master`, and it manages workers on your behalf.

### Creating Workers

By default, workers run on **Claude (Opus)** via the Anthropic API:

```
create a worker named my-task
```

To use an open-source model via [Neuralwatt](https://portal.neuralwatt.com), specify the backend and model:

```
create a worker named my-task based on neuralwatt kimi k2.5
```

The master resolves fuzzy model names automatically — "kimi fast", "qwen coder", etc. all work. You don't need to know exact model identifiers.

### Switching Models

For Neuralwatt workers, you can switch models live without losing your workspace or conversation:

```
switch my-task to qwen 3.5
```

Switching between Anthropic and Neuralwatt requires recreating the worker. The master handles this with `transfer_worker` — your workspace and chat history are preserved:

```
transfer my-task to neuralwatt kimi k2.5
```

### Viewing Energy & Usage Data

Neuralwatt workers track per-request energy metrics (tokens, joules, watt-hours). There are several ways to see this data:

**Status dashboard** — ask the master to run `/status`. This shows all workers with their backend, model, uptime, and cumulative energy usage:

```
show /status
```

Example output:
```
Master · claude · up 2h 15m

## Workers
- 🟢 my-task · moonshotai/Kimi-K2.5 · up 45m · 12 reqs · 8.3k tokens · 0.4 Wh
- 🟢 other-task · claude · up 1h
- ⚫ old-task · claude · stopped

## Summary
- Containers: 2/5 slots used
- Workers: 3 registered
- Neuralwatt total: 12 reqs · 8.3k tokens · 0.4 Wh
```

**On worker destruction** — when you destroy a Neuralwatt worker, lifetime usage is reported automatically.

**Direct query** — from inside a worker or via curl:
```bash
curl http://host.docker.internal:3003/usage           # all workers
curl http://host.docker.internal:3003/usage/discord_my-task  # single worker
```

Anthropic workers don't return energy data — only request counts and tokens are tracked for Neuralwatt workers.

### Listing and Destroying Workers

```
list workers
destroy my-task
```

## Architecture

```
Discord Server
  #master          <-->  NanoClaw host  <-->  Master agent (lifecycle only)
  #worker-alpha    <-->       |         <-->  Container A (Claude or Neuralwatt)
  #worker-beta     <-->       |         <-->  Container B (Claude or Neuralwatt)
```

One Discord bot. The host process routes messages by channel ID. Workers are isolated containers with their own filesystems and Claude sessions. The master does minimal thinking: it calls MCP tools (create, destroy, list, switch) with the right arguments. Workers handle all the real work.

For goals, design principles, and detailed architecture, see [docs/architecture/overview.md](docs/architecture/overview.md).

## Inference Backends

Under the hood, the system uses a **translation shim** (port 3003) that converts between Anthropic and OpenAI API formats. Workers always use the Claude Agent SDK — the shim handles the translation transparently for Neuralwatt workers. Anthropic workers talk directly to the credential proxy (port 3001).

For technical details: [inference routing](docs/architecture/inference-routing.md) · [model discovery](docs/architecture/model-discovery.md)

<img src="assets/screenshot-worker.png" alt="Worker investigating CI regression runs" width="700">

## Usage & Energy Tracking

The translation shim accumulates per-request energy data from Neuralwatt responses (tokens, joules, watt-hours) and exposes it via `/usage` endpoints. Usage persists across restarts in `data/worker-usage.json`. See [Using Workers](#viewing-energy--usage-data) above for how to access this data, and [docs/architecture/energy-tracking.md](docs/architecture/energy-tracking.md) for the technical design.

## Restart Behavior

Containers run with `--rm` and are destroyed on NanoClaw restart. Everything else persists: Discord channels, SQLite registrations, repos (bind-mounted workspace), and session IDs. On restart, workers respawn on next message with full context.

See [docs/architecture/container-lifecycle.md](docs/architecture/container-lifecycle.md).

## Documentation

| Section | What's in it |
|-|-|
| [docs/architecture/](docs/architecture/) | How the system works (overview, routing, lifecycle, streaming) |
| [docs/guides/](docs/guides/) | Setup, testing, troubleshooting |
| [docs/reference/](docs/reference/) | SDK internals |
| [design/](design/) | Design history and archived proposals |

Full index: [docs/README.md](docs/README.md)

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container image

# Service management (Linux)
systemctl --user start nanoclaw
systemctl --user restart nanoclaw
```

Pre-push hook runs prettier, tsc, and tests. Enable with `git config core.hooksPath .githooks`.

## Upstream

This fork tracks [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). Pull updates with `git fetch upstream main && git merge upstream/main`, or use the `/update-nanoclaw` skill for guided cherry-picking.
