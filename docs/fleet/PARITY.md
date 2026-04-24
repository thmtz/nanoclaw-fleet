# Fleet v2 — Parity with nanoclaw-fleet (v1 fork)

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
| ncf rebuild                                     | gap      | v1 rebuilt the container image. v2 has `scripts/` but no ncf command yet. Workaround: `./container/build.sh` |
| Trace IDs (host → container → SDK → outbound)   | done     | inbound msg id becomes the traceId; host + container both log it on critical-path events (see e697f16) |
| Event-driven outbound delivery                  | done     | Container POSTs `http://host.docker.internal:3100/wake/<sess>` after each writeMessageOut. Saves ~500ms–1s per turn (9a37f69). Host 1s poll stays on as fallback |
| Reaction throbber on incoming msg               | done     | `src/modules/throbber/`. fs.watchFile on `.heartbeat` → emoji cycles per Claude SDK event; freezes when inference hangs |
| Pinned status messages                          | done     | `src/modules/status-pin/`. Master pin + per-worker pin, edit-in-place every 30s, id persisted in `chat_sdk_kv` |
| Worker lifecycle event log (JSONL)              | done     | `src/modules/fleet/events.ts`. `logs/worker-events.jsonl`. `ncf history` reads it |
| smoke test (single command)                     | done     | `scripts/smoke.sh`: ncf health + inject --wait + pinned-status check + Discord lifecycle |
| Discord-driven lifecycle E2E                    | done     | `scripts/test-fleet-lifecycle.ts` (465 lines) — 8 steps, codeword marker, reaps orphans at start |
| Debug bot allowlist (DISCORD_ALLOWED_BOT_IDS)   | done     | Patch to `@chat-adapter/discord` (patches/). Debug bot posts real Discord messages during smoke |
| Sender allowlist (user-level access control)    | gap      | v1 had `src/sender-allowlist.ts`. v2 uses unknown_sender_policy + user_roles; close but not a direct port. Not required for parity. |
| Per-worker usage audit (latency / text length)  | done (partial) | Container writes per-turn JSON to `data/v2-sessions/<ag>/<sess>/turns.jsonl`. `ncf turns <name> [--limit N] [--slow <ms>]` reads it. Token / stop_reason fields null until ProviderEvent result type surfaces usage (see open list) |
| Model discovery / fuzzy match                   | done (docs) | Shim at nanoclaw-fleet/ already exposes `/models` + `/models/resolve/<q>`. Master CLAUDE.md documents the curl pattern (f4298bd) |
| Streaming SSE (Anthropic ↔ OpenAI)              | done     | Same v1 shim handles both. Nothing for v2 to port |
| Master auto-destroy guard                       | done     | Master CLAUDE.local.md "Discipline" section forbids unsolicited destroy (4ddfb43) |
| Credit-balance leak-through (ANTHROPIC_API_KEY) | done     | `preferOauth` path in container-runner skips API key when CLAUDE_CODE_OAUTH_TOKEN set (29d053b) |
| Container crash-loop guard                      | done     | MIN_RESPAWN_INTERVAL_MS=5s in container-runner prevents spawn storms |
| Seq-race retry on inbound insert                | done     | UNIQUE(seq) loop retries up to 32 times (db/session-db.ts insertMessage) |
| Chat SDK double-delivery dedupe                 | done     | UNIQUE on messages_in.id absorbed by routeInbound as no-op |

## Open (not yet ported)

- `ncf rebuild` — thin wrapper over `container/build.sh`, worth 10 lines if asked.
- turns.jsonl token/stop_reason fields — needs `ProviderEvent.result` shape extended to carry `usage` + `stop_reason`, then both Claude and Neuralwatt provider impls populate. Without this the status pin can't show per-worker token counts.
- Sender allowlist — v1 had a user-level deny mode. v2 relies on unknown_sender_policy + user_roles which covers most cases but isn't identical.

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
