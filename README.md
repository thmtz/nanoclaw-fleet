# NanoClaw Fleet

[![GitHub Release](https://img.shields.io/github/v/release/thmtz/nanoclaw-fleet)](https://github.com/thmtz/nanoclaw-fleet/releases)
[![CI](https://github.com/thmtz/nanoclaw-fleet/actions/workflows/ci.yml/badge.svg)](https://github.com/thmtz/nanoclaw-fleet/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/thmtz/nanoclaw-fleet)](LICENSE)

A fleet manager for isolated coding agents, built on [NanoClaw](https://github.com/qwibitai/nanoclaw). Each agent gets a Discord channel and a Docker container with its own filesystem, repos, and tools. You drive the fleet from a master channel: spin up workers, hand them tasks, switch models, tear them down. Workspaces and conversation history persist; only the running container is ephemeral.

The point: run many coding agents in parallel without juggling shell sessions and worktrees, and pick the work back up from your phone if you walk away from your desk.

<img src="assets/screenshot-status.png" alt="Status dashboard showing master and five workers" width="700">

## What a session looks like

In `#master`:

```
create a worker named fix-auth
create a worker named refactor-api
create a worker named update-docs
```

Each worker gets a channel, a container, and your repos cloned. Switch between channels to give tasks, check progress, follow up. Destroy a worker when you're done. Recreate it later by name and the workspace and chat come back.

## Quick Start

```bash
git clone https://github.com/thmtz/nanoclaw-fleet.git
cd nanoclaw-fleet
claude     # or your coding agent of choice
# then: /setup
```

The `/setup` skill installs dependencies, configures Docker, walks you through the Discord bot, and starts the service. It pauses only for inputs it can't generate (bot tokens, guild IDs).

For a manual setup, follow [docs/guides/setup.md](docs/guides/setup.md).

## Documentation

| Section | What's in it |
|-|-|
| [docs/architecture/](docs/architecture/) | How the fleet works: master and workers, lifecycle, inference routing, streaming, energy tracking |
| [docs/guides/](docs/guides/) | Setup, personal config, testing, troubleshooting, branch maintenance |
| [docs/reference/](docs/reference/) | `ncf` CLI reference, Claude Agent SDK internals |
| [docs/upstream/](docs/upstream/) | Original NanoClaw documentation, kept for reference |

Index: [docs/README.md](docs/README.md).

## Development

```bash
npm run dev            # host with hot reload
npm run build          # compile TypeScript
./container/build.sh   # rebuild the agent container image
npm test               # unit + container-runtime tests
./ncf test             # end-to-end smoke (creates and destroys workers)

# service (Linux)
systemctl --user restart nanoclaw

# service (macOS)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Pre-push hooks run prettier, tsc, and tests. Enable on a fresh clone with `git config core.hooksPath .githooks`.

## Upstream

This fork tracks [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). The base repo provides container isolation, the channel skill system, and the Claude Agent SDK wiring. The fork adds the master/worker fleet model, dual inference backends (Anthropic plus Neuralwatt), runtime model switching, energy reporting, and the `ncf` CLI. See [docs/architecture/overview.md](docs/architecture/overview.md) for the full picture, and [docs/guides/branch-fork-maintenance.md](docs/guides/branch-fork-maintenance.md) for how upgrades work.
