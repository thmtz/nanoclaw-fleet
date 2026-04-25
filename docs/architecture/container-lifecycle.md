# Container Lifecycle

How workers are created, run, destroyed, and resumed.

## Driving the lifecycle

Worker lifecycle is driven from the master via the `ncf` CLI, which writes IPC tasks the host consumes. The master's MCP toolbelt also exposes the same commands as native tools.

| Command | What it does |
|-|-|
| `ncf create <name>` | Create a Discord channel, register the group, prepare the workspace |
| `ncf destroy <name>` | Kill the container, delete the channel, remove the registration. Workspace preserved. |
| `ncf status` | Snapshot of all workers (channels, backends, models, container state, usage) |
| `ncf switch <name> <backend> [model]` | Change a worker's backend or model. Cross-backend switches restart the container. |
| `ncf history [name]` | Read `logs/worker-events.jsonl`, filter by worker, event type, since-date |
| `ncf restart <name> [--fresh]` | Restart the container. `--fresh` clears `.claude/` first. |
| `ncf session <name> [n] [--live\|--json]` | Show the session transcript |

For per-channel actions inside a worker, the agent runner registers MCP tools every container has access to:

| Tool | What it does |
|-|-|
| `send_message` | Send a message to the channel mid-turn |
| `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task` | Manage scheduled tasks |
| `register_group` | Register a new channel-to-container mapping (master-only in practice) |
| `worker_history` | Query `logs/worker-events.jsonl` |
| `get_usage`, `get_models`, `get_backend` | Introspect the inference layer |

## Create

When the master runs `ncf create`:

1. **Name collision check.** If `groups/<folder>/` already exists, the master is prompted to pick `resume` (keep repos, fresh session) or `fresh` (wipe everything).
2. **Discord channel created** in the configured guild.
3. **Group registered** in SQLite (`is_main=0`, `requires_trigger=0`).
4. **Backend config seeded** in `data/worker-backends.json`. Defaults come from `.env` (`NANOCLAW_DEFAULT_WORKER_{BACKEND,MODEL}`); explicit `--backend` and `--model` flags override.
5. **Stale session state cleared.** `agent-runner-src/` is always deleted. `.claude/` is only deleted when `reuse` is not `resume`.

The container does not start yet. It spawns on the first message to the worker's channel.

## First message (container spawn)

When a message lands in the worker's channel:

1. **Container runner** (`src/container-runner.ts`) reads the worker's config from SQLite and `worker.env`.
2. **Docker container starts** with:
   - Bind mount: `groups/<folder>/` → `/workspace/group/` (workspace)
   - Bind mount: `data/sessions/<folder>/` → SDK session state
   - Env: `ANTHROPIC_BASE_URL` set to the credential proxy (`:3001`) for Anthropic, or to the shim path (`:3003/w/<folder>/`) for Neuralwatt
   - Env: `NANOCLAW_BACKEND`, `NANOCLAW_MODEL`, `NANOCLAW_IS_MAIN=0`, `DISCORD_GUILD_ID`, plus inference provider keys (`FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, `SYNTHETIC_API_KEY`) when present
   - Port mappings declared in the worker profile
3. **`init.sh` runs** from the worker profile. It clones repos, installs profile tools, symlinks skills and credentials. It is idempotent and runs every spawn.
4. **Agent runner starts** with the Claude Agent SDK. If a session id exists in SQLite, the SDK resumes it.

### Image layers: public vs personal

The container image is built in two layers.

| Layer | Location | What goes here |
|-|-|-|
| Public base | `container/Dockerfile` | Packages every NanoClaw user needs (Node, git, chromium, claude-code, rust, python) |
| Personal | `~/.config/nanoclaw/Dockerfile` | Your additions (databases, test frameworks, CLI tools). Optional. |

`container/build.sh` builds the base, then layers the personal Dockerfile on top if it exists. The personal layer should start with `FROM nanoclaw-agent:base`.

### Dockerfile vs init.sh vs profile tools

| Where | What goes here | When it runs |
|-|-|-|
| Dockerfile | Packages that are the same for every worker and slow to install | Image build (once) |
| `init.sh` | Setup that needs host context (cloning, symlinking host credentials, configuring service connections). Idempotent. | Every container spawn |
| Profile tools | Installs that depend on workspace content (e.g. `uv tool install /workspace/group/myproject`) | Every container spawn, after init.sh |

If an install takes more than a few seconds and is the same across all workers, move it to the Dockerfile.

## Running

The container stays alive until the master destroys it, NanoClaw restarts (containers run with `--rm`), the container crashes, or Docker is restarted. Workers have no idle timeout (`disableIdleTimeout: true` in the SDK options); they stay up indefinitely.

## Destroy

When the master runs `ncf destroy`:

1. Container killed if running.
2. Discord channel deleted.
3. Registration removed from `registered_groups`.
4. Session id preserved in the `sessions` table so a future `ncf create` with `reuse: "resume"` can hand it to the SDK.
5. Session dir preserved at `data/sessions/<folder>/.claude/` with conversation history.
6. Agent-runner cache deleted at `data/sessions/<folder>/agent-runner-src/`.
7. Workspace preserved at `groups/<folder>/`. Repos, edits, and CLAUDE.md stay on disk.

For Neuralwatt workers, the master reports lifetime usage stats before cleanup.

## Worker event log

Every lifecycle change is appended to `logs/worker-events.jsonl`:

```jsonl
{"timestamp":"2026-04-06T23:49:36.997Z","event":"created","worker":"ci-fail","folder":"discord_ci-fail","details":{"backend":"anthropic"}}
{"timestamp":"2026-04-07T03:34:58.449Z","event":"backend_switched","worker":"baba","folder":"discord_baba","details":{"from":"anthropic","to":"neuralwatt","model":"kimi-k2.5-fast"}}
{"timestamp":"2026-04-06T23:58:35.362Z","event":"destroyed","worker":"baba","folder":"discord_baba"}
```

Event types: `created`, `destroyed`, `backend_switched`, `resumed`. Fields: `timestamp` (ISO 8601), `event`, `worker` (display name), `folder` (e.g. `discord_baba`), and optional `details`. Source: `src/worker-events.ts`.

The log is queryable from the master via `ncf history` and from inside any container via the `worker_history` MCP tool. Both support filtering by worker name, event type, since-date, and limit.

## Restart recovery

When NanoClaw restarts:

1. Running containers are gone (the `--rm` flag autoremoves them).
2. The host loads worker registrations from SQLite.
3. Worker profiles are re-synced to SQLite. Profile changes take effect.
4. `available_groups.json` is regenerated.
5. On the next message to any worker, a fresh container spawns and the SDK session resumes.

Session ids live in SQLite, so conversation context survives restarts.

## Directory layout

`groups/` is gitignored and holds per-agent workspaces.

| Directory | Purpose | Created by |
|-|-|-|
| `groups/discord_main/` | Master workspace (assembled CLAUDE.md, repos, logs) | Startup sync |
| `groups/discord_<name>/` | Worker workspace (repos, edits, assembled CLAUDE.md) | `ncf create` |

Agent instructions are assembled from four fragments and written to `groups/<folder>/CLAUDE.md`:

1. `instructions/global.md` (repo) — shared base
2. `instructions/master.md` or `instructions/worker.md` (repo) — role
3. `~/.config/nanoclaw/instructions/global.md` (personal) — user
4. `~/.config/nanoclaw/instructions/master.md` or `worker.md` (personal) — user role

Assembly happens at host startup for the master and at create-time for workers. Source: `src/profile-sync.ts`.

## Storage layers (survival matrix)

| Layer | Location | Survives container death? | Survives `destroy`? | Survives `fresh` recreate? |
|-|-|-|-|-|
| Registration | SQLite `registered_groups` | Yes | No | No |
| Session id | SQLite `sessions` | Yes | Yes (for resume) | No |
| SDK state | `data/sessions/<folder>/.claude/` | Yes | Yes (for resume) | No |
| Agent-runner cache | `data/sessions/<folder>/agent-runner-src/` | Yes | No | No |
| Workspace | `groups/<folder>/` | Yes | Yes | No |
| Backend config | `data/worker-backends.json` | Yes | Removed entry | Removed entry |

## Updating workers

Existing workers do not automatically pick up changes you make to the image, scripts, or profiles. Each kind of change has its own propagation rule.

| Change | Effect | How to roll out |
|-|-|-|
| Container image | New images apply on next spawn | `container/build.sh`, then `ncf restart <worker>` or message the worker after a kill |
| `init.sh` | Runs every spawn, idempotent. Force tool upgrades by clearing the install first. | Restart the container |
| Agent-runner source | Auto-synced by mtime on each spawn | None — next message picks it up |
| Worker profile | Synced to SQLite at host startup | Restart NanoClaw, then message the worker |
| Instructions (`instructions/` or `~/.config/nanoclaw/instructions/`) | Assembled CLAUDE.md regenerates at host startup for master and all workers | Restart NanoClaw, then message the worker |
| Personal Dockerfile | Needs image rebuild | `container/build.sh`, then restart NanoClaw |

For a full clean slate, `ncf destroy` then `ncf create` with `reuse: "fresh"`. To keep repos but reset the session, recreate with `reuse: "resume"`.
