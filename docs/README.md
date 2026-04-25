# Documentation

Start with the [architecture overview](architecture/overview.md) for the 1000ft view, then dive into whichever section matches the work.

## Architecture

How the fleet works in its current state.

- [Overview](architecture/overview.md) — goals, topology, components, where state lives
- [Container lifecycle](architecture/container-lifecycle.md) — create, run, destroy, resume, restart recovery
- [Inference routing](architecture/inference-routing.md) — request flow per backend, defaults, the seeding rule
- [Model discovery](architecture/model-discovery.md) — fuzzy matching, the `/models/resolve` endpoint
- [Streaming shim](architecture/streaming-shim.md) — Anthropic ↔ OpenAI SSE translation
- [Energy tracking](architecture/energy-tracking.md) — per-worker joules, watt-hours, attribution

## Guides

How to do something.

- [Setup](guides/setup.md) — first-time install, Discord wiring, master registration
- [Personal config](guides/personal-config.md) — `~/.config/nanoclaw/` layout
- [Testing](guides/testing.md) — end-to-end scenarios, the debug bot, trace ids
- [Troubleshooting](guides/troubleshooting.md) — common failures and fixes
- [Debug checklist](guides/debug-checklist.md) — triage runbook for unknown failures
- [Branch and fork maintenance](guides/branch-fork-maintenance.md) — staying in sync with upstream

## Reference

Lookup-oriented.

- [`ncf` CLI](reference/cli.md) — every command, flag, and example
- [SDK internals](reference/sdk-internals.md) — Claude Agent SDK reverse-engineering notes

## Upstream

Original [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) documentation, kept verbatim for reference and for resolving merge conflicts.

- [Spec](upstream/SPEC.md)
- [Requirements](upstream/REQUIREMENTS.md)
- [Security](upstream/SECURITY.md)
- [Skills as branches](upstream/skills-as-branches.md)
- [Docker sandboxes](upstream/docker-sandboxes.md)
- [Apple Container networking](upstream/APPLE-CONTAINER-NETWORKING.md)
- Plus the older [DESIGN-shared-beads](upstream/DESIGN-shared-beads.md), [nanoclaw-architecture-final](upstream/nanoclaw-architecture-final.md), and [nanorepo-architecture](upstream/nanorepo-architecture.md) notes.

## Design

Proposals and design history live in [`/design/`](../design/), separate from docs so current state and aspirational state don't blur together.
