# NanoClaw Fleet (v2)

A fleet manager for isolated coding agents, layered on top of [NanoClaw](https://github.com/qwibitai/nanoclaw) v2. One master agent in Discord drives many workers. Each worker gets its own Discord channel, its own container, its own filesystem, its own session, and an inference backend you can swap at runtime. Workspaces and conversation history persist; only the running container is ephemeral.

The point: run many coding agents in parallel without juggling shell sessions or worktrees, and pick the work back up from your phone.

<img src="assets/screenshot-status.png" alt="Master and worker status pins in Discord" width="700">

## What a session looks like

In `#master`:

```
create a worker named fix-auth
create a worker named refactor-api
create a worker named update-docs
```

The master spins up each worker, creates a Discord channel, clones your repos, and notifies you when ready. Switch between channels to give tasks, check progress, follow up. Destroy a worker when you're done. Recreate by name later and the workspace and chat resume.

## Quick Start

```bash
git clone https://github.com/qwibitai/nanoclaw.git nanoclaw-fleet
cd nanoclaw-fleet
git checkout feat/fleet
bash nanoclaw.sh
```

`nanoclaw.sh` walks you from a fresh machine to a running master agent. It installs Node, pnpm, and Docker if missing, registers your Anthropic credential with OneCLI, builds the agent container, and pairs Discord. Once the master is up, ask it to create your first worker.

For the manual path, see [docs/fleet/guides/setup.md](docs/fleet/guides/setup.md).

## Documentation

| Section | What's in it |
|-|-|
| [docs/](docs/) | Upstream NanoClaw v2 architecture: entity model, session DBs, channel adapters, providers, isolation, container lifecycle |
| [docs/fleet/](docs/fleet/) | Fleet additions: master/worker model, inference routing, worker profiles, status pins, `ncf` CLI |

Start with [docs/fleet/architecture/overview.md](docs/fleet/architecture/overview.md) for the fleet view. Read [docs/architecture.md](docs/architecture.md) and [CLAUDE.md](CLAUDE.md) for the v2 baseline.

## Development

```bash
pnpm run dev               # host with hot reload
pnpm run build             # compile TypeScript
./container/build.sh       # rebuild the agent container image
pnpm test                  # unit tests
./scripts/smoke.sh         # end-to-end smoke (creates and destroys workers)

ncf status                 # fleet snapshot from any shell
ncf debug                  # paths, agent groups, docker, shim, wake health
```

## Upstream

This fork tracks [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). The base provides the channel-skill system, the entity model (users, agent_groups, messaging_groups), the two-DB session split, the OneCLI credential vault, and the container runner. The fork adds the master/worker fleet model, dual inference backends (Anthropic + Neuralwatt), runtime model switching, status pins, the `ncf` CLI, and Discord channel-per-worker provisioning. Architecture lives in [docs/fleet/architecture/](docs/fleet/architecture/).
