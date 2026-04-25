# Fleet v2 — Parity with nanoclaw-fleet (v1 fork)

> Companion docs: [architecture/overview.md](architecture/overview.md), [DESIGN.md](DESIGN.md), [RUNBOOK.md](RUNBOOK.md).

Tracks every feature the v1 nanoclaw-fleet fork added on top of upstream
NanoClaw v1, against its current state in NanoClaw v2. "Done" means
ported + verified (unit test, live Discord run, or both).

| Feature                                         | Status   | Notes |
|-|-|-|
| Per-worker Discord channel (create / delete)    | done     | `src/modules/fleet/discord-channel.ts` + provision.ts. Channel id encoded as `discord:<guild>:<channel>` in messaging_groups.platform_id |
| create_worker MCP tool                          | done     | Delivery-action handler. Dedup: archived groups with same name resume instead of error |
| destroy_worker MCP tool                         | done     | Stops container, archives agent_group, optionally deletes channel. Workspace + sessions preserved |
| switch_backend MCP tool                         | done     | Accepts `master` / `self` as aliases so master can switch its own provider (added 36a3b76) |
| list_workers MCP tool                           | done     | Host writes list as a chat message into master's inbound.db |
| Destroy → recreate resume                       | done     | Lifecycle E2E step 1 recreates destroyed workers with same name and sees prior session preserved |
| Runtime backend switching                       | done     | Session (.claude/) preserved across provider flip |
| Neuralwatt shim provider                        | done     | `src/providers/neuralwatt.ts` defaults `ANTHROPIC_BASE_URL` to `http://host.docker.internal:3003/w/<folder>` so v1 shim's worker-folder routing picks per-folder model from `worker-backends.json` |
| Dual-backend: Anthropic (OAuth) + Neuralwatt    | done     | OAuth path via `readLiveClaudeOauthToken()`; NW path via shim |
| Master CLAUDE.local.md (instructions)           | done     | `composeGroupClaudeMd()` explicitly `@import`s it because Claude Code's auto-memory misses first-turn cached system prompts |
| CLAUDE.md composition (shared base + skills)    | done     | `src/claude-md-compose.ts`; runs on every spawn, deterministic |
| ncf status                                      | done     | Master + workers, container state, backend, wired channels |
| ncf create / destroy / switch                   | done     | Writes system action into master outbound.db |
| ncf logs                                        | done     | docker logs wrapper |
| ncf session                                     | done     | Last 10 inbound + outbound rows from session DBs |
| ncf inject `<name> <msg>` (`--wait` supported)  | done     | Writes chat row to worker's inbound.db, POSTs wake-inbound for immediate pickup, optional poll for reply. |
| ncf restart [--fresh]                           | done     | Kills container; `--fresh` clears session_state.stored_session_id for SDK reset |
| ncf debug                                       | done     | Paths, agent groups, docker state, shim + wake health |
| ncf reap-orphans                                | done     | Deletes Discord channels named worker-*/lc-* whose id isn't in messaging_groups |
| ncf history                                     | done     | Reads `logs/worker-events.jsonl` emitted by create / resume / switch / destroy handlers |
| (row merged below — see "ncf rebuild" near turns.jsonl) | done | |
| Trace IDs (host → container → SDK → outbound)   | done     | inbound msg id becomes the traceId; host + container both log it on critical-path events (see e697f16) |
| Event-driven outbound delivery                  | done     | Container POSTs `http://host.docker.internal:3100/wake/<sess>` after each writeMessageOut. Saves ~500ms–1s per turn (9a37f69). Host 1s poll stays on as fallback |
| Reaction throbber on incoming msg               | done     | `src/modules/throbber/`. fs.watchFile on `.heartbeat` → emoji cycles per Claude SDK event; freezes when inference hangs |
| Pinned status messages                          | done     | `src/modules/status-pin/`. Master pin + per-worker pin, edit-in-place every 30s, id persisted in `chat_sdk_kv` |
| Worker lifecycle event log (JSONL)              | done     | `src/modules/fleet/events.ts`. `logs/worker-events.jsonl`. `ncf history` reads it |
| smoke test (single command)                     | done     | `scripts/smoke.sh`: ncf health + inject --wait + pinned-status check + Discord lifecycle |
| Discord-driven lifecycle E2E                    | done     | `scripts/test-fleet-lifecycle.ts` (465 lines) — 8 steps, codeword marker, reaps orphans at start |
| Debug bot allowlist (DISCORD_ALLOWED_BOT_IDS)   | done     | Patch to `@chat-adapter/discord` (patches/). Debug bot posts real Discord messages during smoke |
| Sender allowlist (user-level access control)    | done (mapping) | v2 covers every v1 allowlist case via unknown_sender_policy + sender_scope + messaging_groups.denied_at + user_roles. Exception: per-user ban within an otherwise-allowed chat — no direct equivalent; workaround documented. See [SENDER-ACCESS.md](SENDER-ACCESS.md) |
| Per-worker usage audit (tokens / latency / stop) | done    | Container writes per-turn JSON to `data/v2-sessions/<ag>/<sess>/turns.jsonl`. `ncf turns <name> [--limit N] [--slow <ms>]` reads it. Tokens + stop_reason populate from SDK usage (7ac5ea7) |
| `ncf rebuild`                                    | done    | Wraps `container/build.sh` (7ac5ea7) |
| Model discovery / fuzzy match                   | done (docs) | Shim at nanoclaw-fleet/ already exposes `/models` + `/models/resolve/<q>`. Master CLAUDE.md documents the curl pattern (f4298bd) |
| Streaming SSE (Anthropic ↔ OpenAI)              | done     | Same v1 shim handles both. Nothing for v2 to port |
| Master auto-destroy guard                       | done     | Master CLAUDE.local.md "Discipline" section forbids unsolicited destroy (4ddfb43) |
| Credit-balance leak-through (ANTHROPIC_API_KEY) | done     | `preferOauth` path in container-runner skips API key when CLAUDE_CODE_OAUTH_TOKEN set (29d053b) |
| Container crash-loop guard                      | done     | MIN_RESPAWN_INTERVAL_MS=5s in container-runner prevents spawn storms |
| Seq-race retry on inbound insert                | done     | UNIQUE(seq) loop retries up to 32 times (db/session-db.ts insertMessage) |
| Chat SDK double-delivery dedupe                 | done     | UNIQUE on messages_in.id absorbed by routeInbound as no-op |

| Worker profiles (repos / tools / mounts / skills_repo) | done | `src/modules/fleet/worker-profile.ts` loads `~/.config/nanoclaw/worker-profiles/default.json`; `applyProfileToContainerConfig` merges into new worker's container.json; `container/worker-init.sh` runs on every worker boot to clone repos, link skills, install tools (c5472cf). GitHub token propagation via `NANOCLAW_GITHUB_TOKEN_PATH` (.env → literal token in container env) for HTTPS clone rewrite (4902959). |
| `include_files` in `~/.config/nanoclaw/config.json` | done | CLAUDE.md compose inlines each listed file per spawn; survives SDK compaction. (4305682) |
| Personal Dockerfile overlay | done | `container/build.sh` stacks `~/.config/nanoclaw/Dockerfile` on top of base via `--build-arg BASE=<slug>:base`. Single deterministic image tag either way. (aecee20) |
| Energy tracking (read-through) | done | Opt-in via `NW_SHIM_USAGE_PATH`. Status pin shows per-worker `req · tok · kWh` + fleet total. `get_usage` MCP tool merges shim's `/usage/<folder>` energy data with local turn latency. (e1a16cd) |
| `master-profiles/` reference template | done | Shipped under `examples/master-profiles/` + `examples/worker-profiles/`. Personal instructions layering (8d7723c) loads user's `~/.config/nanoclaw/instructions/master.md`. |
| resumeSessionAt / streaming input | done (structural) | v2 always uses streaming input (MessageStream async iterable) for `sdkQuery`; resume uses `resume: continuation` by session id. The specific `resumeSessionAt` UUID anchor is not needed because v2's agent-to-agent module routes whole messages rather than spawning SDK subagent teams (the shape that triggered the v1 bug). |
| IDLE_TIMEOUT != CONTAINER_TIMEOUT | done | v2's `host-sweep.ts` uses a single `ABSOLUTE_CEILING_MS = 30min` heartbeat-age check. The legacy `IDLE_TIMEOUT` / `CONTAINER_TIMEOUT` constants in `config.ts` are unused — no double-timer race possible. |
| Lifecycle cleanup robustness | done | Cleanup marks any master inbound row mentioning this run's worker name/marker as completed so a rate-limit-deferred "create <name>" instruction can't revive hours later when the user sends an unrelated message. (9873420) |
| Base image: openssh-client + uv | done | Needed for SSH clones and `uv tool install` in profiles (8d7723c). Run `./container/build.sh` or `ncf rebuild` to pick up. |
| Personal instructions layering (global/master/worker.md) | done | `src/claude-md-compose.ts` inlines `~/.config/nanoclaw/instructions/{global,master,worker}.md` as composed CLAUDE.md fragments at every spawn. Role-gated (master.md for masters, worker.md for workers, global.md for both). (8d7723c) |
| Mount allowlist SSH override | done | Allowlist wins over default blocklist when user explicitly allowlists `~/.ssh` etc. (c5472cf) |
| Worker MCP tools: get_backend, get_usage, get_models | done | `container/agent-runner/src/mcp-tools/introspect.ts` — worker can answer "what am I / how much have I used / which models exist?" questions without shelling out. (current) |
| Shim config auto-sync | done | create_worker / switch_backend now write per-folder entries to the shim's `worker-backends.json` when `NW_SHIM_CONFIG_PATH` is configured. Previously new neuralwatt workers failed in an API retry loop because the shim defaulted to anthropic. (8740879) |
| Outbound routing cross-channel fix | done | Replies use session_routing (host-authoritative, current per wake) instead of stale batch-local routing captured at query start. Fixed master-silent-on-Discord after prior CLI inject. (2d566c2) |
| Test-side real Discord leak | done | fleet.test.ts hard-mocks discord-channel.js so `pnpm test` never hits real Discord REST. (d6e0750) |

## Open (not yet ported)

All features from the v1 fork's docs (SPEC.md + architecture + guides +
DEBUG_CHECKLIST + reference/cli.md) are ported or covered by a v2
equivalent. One narrow behavioural gap remains:

- Per-user deny within an otherwise-allowed chat. Both v1 and v2 have
  chat-wide deny and unknown-sender controls; neither previously made
  this specific case easy. See [SENDER-ACCESS.md](SENDER-ACCESS.md) for
  the documented workaround.

## How to verify

```bash
pnpm run dev &
./scripts/smoke.sh
```

End-to-end: 8 ncf checks + 8 Discord lifecycle steps. Runs ~90s total,
uses the debug bot, reaps orphan channels, exercises create / message /
switch / resume / destroy.

## Design deltas (v2 did this differently than v1)

| Concern                 | v1 nanoclaw-fleet                      | v2 fleet                                            |
|-|-|-|
| Message storage         | single `messages.db` with `registered_groups` | `agent_groups` + `messaging_groups` + per-session inbound.db/outbound.db |
| Session state           | `sessions` table + `.claude/` filesystem   | Session id in container's `session_state` table + `.claude/` mount |
| IPC                     | `src/ipc.ts` shared file-queue         | Direct DB writes + `deliverSessionMessages` polling/wake |
| Inbound wake            | `messageWake` EventEmitter             | Already event-driven in v2 (router → wakeContainer HTTP IPC) |
| Outbound delivery       | poll-driven (1-2s)                     | 1s poll + `http://host:3100/wake/<sess>` event path |
| Container instructions  | `profile-sync.ts` merges repo + personal | `composeGroupClaudeMd` assembles from shared base + skills + MCP fragments + per-group CLAUDE.local.md |
| Trace IDs               | generated on inbound                   | Use inbound message id directly (no new column) |
