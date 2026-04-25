# Fleet Documentation

Fleet-specific docs for NanoClaw v2. Covers everything the fleet adds on top of the upstream baseline. For the v2 baseline (entity model, session DBs, channel adapters, container runner, providers, isolation), read upstream docs in [`../`](../).

Start with [architecture/overview.md](architecture/overview.md), then dive in where the work is.

## Architecture

How the fleet works on top of v2.

- [Overview](architecture/overview.md) — what the fleet adds, topology, where each piece lives
- [Master and workers](architecture/master-workers.md) — lifecycle MCP tools, fire-and-forget delivery, agent-to-agent destinations, resume-on-recreate
- [Inference routing](architecture/inference-routing.md) — Claude vs Neuralwatt, `container.json::providers`, shim auto-sync
- [Worker profile](architecture/worker-profile.md) — repos, tools, mounts, `worker-init.sh`
- [Instructions composition](architecture/instructions.md) — how `composeGroupClaudeMd` weaves shared base, skills, MCP fragments, personal layers, and `CLAUDE.local.md`
- [Status pin and throbber](architecture/status-pin-throbber.md) — pinned summary, heartbeat-driven reactions, self-heal
- [Observability](architecture/observability.md) — worker events, per-turn audit, trace ids, energy read-through

## Guides

How to do something.

- [Setup](guides/setup.md) — first-time fleet install on top of v2
- [Personal config](guides/personal-config.md) — `~/.config/nanoclaw/` layout
- [Testing](guides/testing.md) — `scripts/smoke.sh`, the lifecycle script, debug bot
- [Troubleshooting](guides/troubleshooting.md) — common failures with concrete fixes

## Reference

- [`ncf` CLI](reference/cli.md) — every command, flag, and example

## Design and operations

These already exist and stay separate from the architecture/guides/reference set. They cover decision rationale, parity tracking, and operational procedures.

- [DESIGN.md](DESIGN.md) — fleet layer model, why fire-and-forget, what's reused from v2
- [PARITY.md](PARITY.md) — feature-by-feature comparison with v1 fleet, what's done, what's open
- [RUNBOOK.md](RUNBOOK.md) — operational procedures and recovery
- [SENDER-ACCESS.md](SENDER-ACCESS.md) — mapping the v1 sender allowlist onto v2's permission system
