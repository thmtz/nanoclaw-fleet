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
| Base image: openssh-client + uv | done | Needed for SSH clones and `uv tool install` in profiles (8d7723c). Run `./container/build.sh` or `ncf rebuild` to pick up. |
| Personal instructions layering (global/master/worker.md) | done | `src/claude-md-compose.ts` inlines `~/.config/nanoclaw/instructions/{global,master,worker}.md` as composed CLAUDE.md fragments at every spawn. Role-gated (master.md for masters, worker.md for workers, global.md for both). (8d7723c) |
| Mount allowlist SSH override | done | Allowlist wins over default blocklist when user explicitly allowlists `~/.ssh` etc. (c5472cf) |
| Worker MCP tools: get_backend, get_usage, get_models | done | `container/agent-runner/src/mcp-tools/introspect.ts` — worker can answer "what am I / how much have I used / which models exist?" questions without shelling out. (current) |
| Shim config auto-sync | done | create_worker / switch_backend now write per-folder entries to the shim's `worker-backends.json` when `NW_SHIM_CONFIG_PATH` is configured. Previously new neuralwatt workers failed in an API retry loop because the shim defaulted to anthropic. (8740879) |
| Outbound routing cross-channel fix | done | Replies use session_routing (host-authoritative, current per wake) instead of stale batch-local routing captured at query start. Fixed master-silent-on-Discord after prior CLI inject. (2d566c2) |
| Test-side real Discord leak | done | fleet.test.ts hard-mocks discord-channel.js so `pnpm test` never hits real Discord REST. (d6e0750) |

## Open (not yet ported)

All high-value v1 features are ported or covered by substitute v2 models.
Two narrow gaps remain:

- Per-user deny within an otherwise-allowed chat. Both v1 and v2 have
  chat-wide deny and unknown-sender controls; neither previously made
  this specific case easy. See [SENDER-ACCESS.md](SENDER-ACCESS.md) for
  the documented workaround.
- Personal `~/.config/nanoclaw/Dockerfile` overlay for the base image.
  v2's `install_packages` MCP tool covers most practical cases (runtime
  apt/npm additions per worker); a user-global Dockerfile layer would
  be a nice-to-have for build-time-only customization.
- Energy tracking (`data/worker-usage.json`, shim SSE `: energy {...}`
  parse). The shim is v1-owned; v2 workers currently can see their own
  turn latency + tokens via `get_usage` but not the kWh / joules
  attribution. If/when this matters, extend the shim to write a
  host-side usage file and have v2 read it for the status pin.

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
