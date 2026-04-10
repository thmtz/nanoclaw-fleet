# NanoClaw Fleet Migration Guide

Generated: 2026-04-10
Base: 479ca166cafc4e19e36e68cc5381c22b0a3584be
HEAD at generation: a7786c5 (main)
Upstream: 934f063 (upstream/main, v1.2.52)
Fork version: 1.2.12

## Migration Plan

This is a Tier 3 (complex) migration. 350 custom commits, 199 changed files, 38k insertions. The fork is essentially a different product built on the NanoClaw foundation: "NanoClaw Fleet" — a multi-worker orchestration system with Discord as primary channel, dual-backend inference routing (Anthropic + Neuralwatt), and a host-side CLI (`ncf`).

### Order of Operations

1. **Checkout clean upstream/main in worktree**
2. **Dependencies & build config** — package.json, tsconfig, vitest, prettier, .env.example
3. **Infrastructure files** — systemd, launchd, .githooks, GitHub workflows, CODEOWNERS
4. **Documentation** — docs/, CLAUDE.md, README.md, AGENTS.md, instructions/
5. **Core source (src/)** — the bulk of the work; apply in dependency order:
   a. Foundation: config.ts, types.ts, env.ts, logger.ts, utils.ts, timezone.ts
   b. Database: db.ts
   c. Security: credential-proxy.ts, mount-security.ts, sender-allowlist.ts
   d. IPC & messaging: ipc.ts, router.ts, group-folder.ts, group-queue.ts
   e. Channels: channels/registry.ts, channels/index.ts, channels/discord.ts, channels/whatsapp.ts
   f. Container lifecycle: container-runner.ts, container-runtime.ts, profile-sync.ts
   g. Worker management: worker-events.ts, audit-log.ts, session-commands.ts, task-scheduler.ts
   h. Status & monitoring: status-pin.ts, worker-status-pin.ts, resource-monitor.ts
   i. Main entry: index.ts
   j. CLI: cli.ts
6. **Container image** — Dockerfile, entrypoint.sh, build.sh, agent-runner
7. **Tools** — anthropic-shim.ts, e2e-test.ts, restart-watchdog.sh
8. **Worker/master profiles & examples**
9. **Tests** — all .test.ts files
10. **Validate** — npm run build && npm test

### Risk Areas

- **src/index.ts** — grew from ~400 to ~928 lines. Upstream has also refactored this. Most likely to need manual adaptation.
- **src/container-runner.ts** — heavy changes on both sides (worker lifecycle, backend switching, resume logic).
- **container/agent-runner/src/index.ts** — major rewrite (MessageStream, IPC polling, compaction hooks). Upstream may have different patterns for the same problems.
- **package.json** — dependency changes on both sides. Need manual merge of deps.

### Key Dependencies Between Customizations

- Discord channel (`channels/discord.ts`) requires `discord.js` in package.json
- Status pins (`status-pin.ts`, `worker-status-pin.ts`) require Discord channel
- Worker events (`worker-events.ts`) requires logger (`logger.ts`)
- Credential proxy (`credential-proxy.ts`) requires config constants (`config.ts`)
- ncf CLI (`cli.ts`) reads from `logs/worker-events.jsonl` and `logs/workers/*/turns.jsonl`
- Anthropic shim (`tools/anthropic-shim.ts`) reads `data/worker-backends.json`
- Container agent-runner reads env vars set by `container-runner.ts`

## Section Files

- [01-dependencies.md](01-dependencies.md) — package.json, build config, .env
- [02-infrastructure.md](02-infrastructure.md) — systemd, launchd, githooks, GitHub, CODEOWNERS
- [03-documentation.md](03-documentation.md) — docs/, instructions/, CLAUDE.md, README
- [04-source-foundation.md](04-source-foundation.md) — config, types, env, logger, utils, timezone
- [05-source-core.md](05-source-core.md) — db, security, IPC, channels, container lifecycle, worker mgmt
- [06-source-ui.md](06-source-ui.md) — status pins, resource monitor, main entry, CLI
- [07-container.md](07-container.md) — Dockerfile, entrypoint, build.sh, agent-runner
- [08-tools.md](08-tools.md) — anthropic shim, e2e tests, watchdog
- [09-profiles-and-examples.md](09-profiles-and-examples.md) — worker/master profiles, examples
- [10-tests.md](10-tests.md) — all test files

## Applied Skills

These skills exist in our fork. Most came from the upstream base we forked from (not via skill branch merges). During upgrade, re-merge the upstream skill branches where available:

| Skill | Upstream Branch | Notes |
|-|-|-|
| add-compact | skill/compact | |
| add-discord | (none — custom) | We wrote this; copy from main tree |
| add-gmail | (none) | Applied via commit |
| add-image-vision | (none) | Applied via commit |
| add-ollama-tool | skill/ollama-tool | |
| add-parallel | (none) | Applied via commit |
| add-pdf-reader | (none) | Applied via commit |
| add-reactions | (none) | Applied via commit |
| add-slack | (none) | Applied via commit |
| add-telegram | (none) | Applied via commit |
| add-telegram-swarm | (none) | Applied via commit |
| add-voice-transcription | (none) | Applied via commit |
| add-whatsapp | (none) | Applied via commit |
| convert-to-apple-container | skill/apple-container | |
| customize | (none) | Core skill, modified |
| debug | (none) | Enhanced debugging |
| get-qodo-rules | (none) | Applied via commit |
| migrate-nanoclaw | skill/migrate-nanoclaw | |
| qodo-pr-resolver | (none) | Applied via commit |
| setup | (none) | Modified for our setup flow |
| update-nanoclaw | (none) | Applied via commit |
| update-skills | (none) | Custom |
| use-local-whisper | (none) | Applied via commit |
| x-integration | (none) | Custom |

Custom skills (not from upstream): `add-discord`, `update-skills`, `x-integration`, `debug` (enhanced), `customize` (modified), `setup` (modified).

## Skill Interactions

Most skills are independent channel integrations. Known interactions:
- **add-discord + add-slack**: Both register as channels via `channels/registry.ts`. The registry handles coexistence.
- **add-compact + agent-runner**: The `/compact` slash command in `session-commands.ts` talks to the agent-runner's `PreCompact` hook.
- **setup skill**: Modified to handle our systemd/launchd service files and Discord bot token setup.
