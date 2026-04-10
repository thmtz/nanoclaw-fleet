# NanoClaw

Personal Claude assistant with dynamic worker agents. See [README.md](README.md) for overview and [docs/architecture/overview.md](docs/architecture/overview.md) for goals and design principles.

## Documentation Routing

**New here?** Read [docs/architecture/overview.md](docs/architecture/overview.md) first for goals and architecture. Then [docs/guides/testing.md](docs/guides/testing.md) to understand how to verify changes.

Before working on a subsystem, read the relevant doc:

- **Architecture and goals:** [docs/architecture/overview.md](docs/architecture/overview.md)
- **Worker create/destroy/resume:** [docs/architecture/container-lifecycle.md](docs/architecture/container-lifecycle.md)
- **Inference routing (Anthropic vs Neuralwatt):** [docs/architecture/inference-routing.md](docs/architecture/inference-routing.md)
- **Model discovery and fuzzy matching:** [docs/architecture/model-discovery.md](docs/architecture/model-discovery.md)
- **Streaming SSE translation:** [docs/architecture/streaming-shim.md](docs/architecture/streaming-shim.md)
- **E2E testing procedures:** [docs/guides/testing.md](docs/guides/testing.md)
- **Setup from scratch:** [docs/guides/setup.md](docs/guides/setup.md)
- **Personal config (instructions, profiles, Dockerfile):** [docs/guides/personal-config.md](docs/guides/personal-config.md)
- **Full doc index:** [docs/README.md](docs/README.md)

## Communication (Discord)

When receiving messages via Discord, **always reply with an immediate ack before doing any work.** Describe what you're about to do, then do it. The user is often on mobile and needs to know you're responsive.

## Workflow

This repository uses **trunk-based development**:

1. **Create feature branches** from `main` for all changes
2. **Push changes as Pull Requests** targeting `main`
3. **Rebase merge** PRs into `main` (no merge commits, no squash)
4. Keep PRs focused and small when possible

### Branch Naming

Use conventional prefixes:

- `feat/` — New features
- `fix/` — Bug fixes
- `docs/` — Documentation changes
- `refactor/` — Code refactoring

Example: `feat/dynamic-workers`, `fix/ipc-feedback`

### Critical Rules

- **NEVER push to any branch without explicit user request AND confirmation.**
- **NEVER push directly to `main`.** Always use a feature branch + PR.
- **NEVER force push** under any circumstances.

### Git Hooks

Enable on every fresh clone:

```bash
git config core.hooksPath .githooks
```

This is a per-clone setting and must be re-run after cloning to a new machine.

**Pre-push hook** — blocks direct pushes to `main`. There is no exception for "small fixes." Always use a feature branch + PR, no matter how trivial the change seems.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Skills

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration    |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install         |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Debugging

Logs are written to two destinations: pretty-printed to stdout (captured by systemd to `logs/nanoclaw.log`) and structured JSONL to `logs/nanoclaw.jsonl` for programmatic querying.

```bash
# Startup/shutdown timing
jq 'select(.msg | startswith("Startup:") or startswith("Shutdown:"))' logs/nanoclaw.jsonl

# Container startups slower than 10s
jq 'select(.msg == "Container first output" and .startupMs > 10000)' logs/nanoclaw.jsonl

# All errors
jq 'select(.level >= 50)' logs/nanoclaw.jsonl
```

**Trace IDs**: Every user message gets a trace ID (`t-<timestamp>-<hex>`) that propagates from host → container → agent-runner logs. Use it to follow a single request across all layers:

```bash
# Find all host events for a trace
jq 'select(.traceId == "t-1775854357638-9475")' logs/nanoclaw.5.jsonl

# Search across host logs AND container stderr
grep "t-1775854357638-9475" logs/nanoclaw.*.jsonl logs/workers/*/stderr-*.log

# Find the trace ID for a recent message (look for "Processing messages")
jq 'select(.msg == "Processing messages") | {traceId, group, messageCount}' logs/nanoclaw.5.jsonl | tail -5
```

**Container startup timing**: `Container first output` log entries include `startupMs` (spawn to first SDK output). The entrypoint's detailed `_profile` steps (init.sh, tsc, etc.) are logged at DEBUG level on stderr. View with `docker logs <container-name>`.

**Container stderr archives** at `logs/workers/<folder>/stderr-<ts>.log` preserve agent-runner output (`[msg #N]` entries, SDK debug output, MessageStream counters) after containers exit. Last 20 files per worker are retained. These are the same logs you'd see with `docker logs` but survive container removal.

**Worker event log** at `logs/worker-events.jsonl` tracks lifecycle events (created, destroyed, backend_switched, resumed). The master can query this via the `worker_history` MCP tool, or you can grep/jq it directly.

**Per-worker audit logs** track every API call at `logs/workers/<folder>/turns.jsonl`. Each entry has: model, backend, tokens (in/out/cached), latency, energy, and stop reason. Use `ncf logs` to query:

```bash
ncf logs <worker>              # last 20 turns
ncf logs <worker> --cache      # show only cache hits
ncf logs <worker> --slow       # show only slow requests (>5s)
ncf logs <worker> --follow     # follow container logs in real-time
```

**Host-side tools** for testing and debugging:

| Tool                                                | Purpose                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `ncf status [--json]`                               | Show all workers, containers, backends, usage                  |
| `ncf logs <worker> [n] [--cache\|--slow\|--follow]` | Per-worker audit logs; `--follow` tails live container output  |
| `ncf inject <channel> <msg> [--wait]`               | Inject a message; `--wait` polls for and prints the response   |
| `ncf switch <worker> <backend> [model]`             | Switch inference backend/model                                 |
| `ncf create <name> [--backend] [--model] [--trigger]` | Create new worker                                            |
| `ncf destroy <worker>`                              | Destroy worker (keeps workspace)                               |
| `ncf restart <worker> [--fresh]`                    | Restart container (optionally clear session)                   |
| `ncf session <worker> [n]`                          | Show session transcript (default 80 lines)                     |
| `ncf history [worker] [--since <date>] [--limit n]` | Worker lifecycle events (created, destroyed, backend switches) |
| `ncf debug`                                         | System state dump (paths, DB, containers, proxies)             |
| `ncf rebuild [worker]`                              | Rebuild container image                                        |

Most commands accept `--json` for machine-readable output. Worker names can be specified with or without the `discord_` prefix. `ncf inject --wait` is the fastest way to verify end-to-end responsiveness.

**Debug bot for E2E testing:** A separate Discord bot (`~/.config/nanoclaw/debug_bot_token`) is allowlisted via `DISCORD_ALLOWED_BOT_IDS` in `.env`. Use it to send messages as a "user" through Discord and verify the full path (Discord → NanoClaw → agent → Discord response). **Prefer the debug bot over `ncf inject`** for testing — inject bypasses Discord entirely, so it can't verify message delivery, reactions, or formatting. The debug bot tests the real path.

```bash
# Read messages from a channel
DEBUG_TOKEN=$(cat ~/.config/nanoclaw/debug_bot_token)
curl -s -H "Authorization: Bot $DEBUG_TOKEN" \
  "https://discord.com/api/v10/channels/<channel-id>/messages?limit=5"

# Send a message as the debug bot
curl -s -X POST -H "Authorization: Bot $DEBUG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"your message"}' \
  "https://discord.com/api/v10/channels/<channel-id>/messages"
```

See `docs/guides/testing.md` for full setup instructions.

## Gotchas

- **Agent-runner source auto-syncs by mtime.** Changes to MCP tools or agent-runner code take effect on next container spawn. No manual cache clearing needed. However, if the image is stale, the entrypoint recompiles TypeScript on every spawn (~2-3s). Rebuild the image (`container/build.sh`) after agent-runner changes to avoid this.
- **Docker build cache is aggressive.** `--no-cache` alone doesn't invalidate COPY steps. Prune the builder for a truly clean rebuild.
- **WhatsApp is a separate channel fork.** Run `/add-whatsapp` to install it after upgrading.

## After Making Changes

After implementing a feature or fix, check whether documentation needs updating:

- **`docs/architecture/`** if system behavior changed
- **`docs/guides/testing.md`** if new testable behaviors were added
- **`.env.example`** if new env vars were added
- **`instructions/`** if agent capabilities or behavior changed (global, master, or worker)

**You must personally exercise your changes before declaring done.** Compiling and passing unit tests is not enough. Use `ncf inject` and `ncf switch`/`ncf create`/`ncf destroy` to send real messages, create/destroy workers, and confirm the system behaves correctly. If you changed worker lifecycle code, create a worker, message it, destroy it, and recreate with resume. If you changed the shim, curl the endpoint and verify the response. If you changed the container image or init.sh, rebuild, restart, and message a worker to confirm it boots. Check `logs/nanoclaw.log` for errors after every test. See [docs/guides/testing.md](docs/guides/testing.md) for exact commands and scenarios.

## Issue Tracking

This repo supports [Beads](https://github.com/steveyegge/beads) (`bd` CLI) for issue tracking, but it's optional. If beads is configured in your worker profile (`BEADS_ENABLED=1`), use it:

- `bd ready` to find available work (no blockers)
- `bd create` before writing code, `bd close` when done
- `bd sync` at end of session to sync with git

If beads is not configured, use GitHub Issues instead.
