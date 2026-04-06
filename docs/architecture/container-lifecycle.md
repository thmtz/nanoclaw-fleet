# Container Lifecycle

How workers are created, run, destroyed, and resumed.

## MCP Tools

The master agent has these lifecycle tools (master-only, enforced by `isMain` check):

| Tool | What it does |
|-|-|
| `create_worker` | Creates a Discord channel + registers the group + prepares the workspace |
| `destroy_worker` | Deletes the Discord channel, DB records, and session state. Workspace preserved. |
| `list_workers` | Returns all registered workers with their status |
| `cleanup_workers` | Destroys stale or errored workers in bulk |
| `switch_backend` | Changes a worker's inference backend or model. Cross-backend switches restart the container automatically. |

All agents (master and workers) also have:

| Tool | What it does |
|-|-|
| `send_message` | Send a message to the channel while still running |
| `schedule_task` | Create a scheduled/recurring task |
| `list_tasks` / `pause_task` / `resume_task` / `cancel_task` / `update_task` | Manage scheduled tasks |
| `register_group` | Register a new channel-to-container mapping (master-only in practice) |

## Create

When the master calls `create_worker`:

1. **Name collision check.** If a workspace already exists at `groups/{folder}/`, the master is prompted to choose "resume" (keep repos, fresh session) or "fresh" (wipe everything).
2. **Discord channel created** in the configured guild.
3. **Group registered** in SQLite with `is_main=0`, `requires_trigger=0`.
4. **Backend config written** to `data/worker-backends.json` if Neuralwatt.
5. **Stale session state cleared.** `agent-runner-src/` is always deleted. `.claude/` is only deleted if `reuse` is not "resume" (resume preserves SDK state for session continuation).

The container doesn't start yet. It spawns on the first message to the worker's channel.

## First Message (Container Spawn)

When the first message arrives in a worker channel:

1. **Container runner** reads the worker's config from SQLite and `worker.env`.
2. **Docker container starts** with:
   - Bind mount: `groups/{folder}/` → `/workspace/group/` (workspace)
   - Bind mount: `data/sessions/{folder}/` → session state dirs
   - Env vars: `ANTHROPIC_BASE_URL` pointing to the correct proxy (`:3001` for Anthropic, `:3003/w/{folder}/` for Neuralwatt)
   - `NANOCLAW_MODEL`, `NANOCLAW_IS_MAIN=0`, `DISCORD_GUILD_ID`, etc.
   - Port mappings from worker profile (`-p` flags), if configured
3. **init.sh runs** from the worker profile. This clones repos (skipping already-cloned), installs profile-specific tools, symlinks skills and credentials. Runs every time a container spawns.
4. **Agent runner starts** with the Claude Agent SDK. If a session ID exists in SQLite, it resumes that session.

### Image layers: public vs personal

The container image supports two layers:

| Layer | Location | What goes here |
|-|-|-|
| **Public base** | `container/Dockerfile` | Packages every NanoClaw user needs (node, git, chromium, claude-code, rust, python) |
| **Personal** | `~/.config/nanoclaw/Dockerfile` | Your additions (databases, test frameworks, CLI tools). Optional. |

`container/build.sh` builds the base image, then layers the personal Dockerfile on top if it exists. The personal Dockerfile should start with `FROM nanoclaw-agent:base`.

### Dockerfile vs init.sh vs profile tools

| Where | What goes here | When it runs |
|-|-|-|
| **Dockerfile** | Packages that are the same every time and slow to install. Split between public base and personal layer. | Image build (once) |
| **init.sh** | Setup that needs host context: cloning repos (needs SSH keys), symlinking credentials from mounts, configuring service connections. Idempotent. | Every container spawn |
| **Profile tools** | Installs that depend on workspace content (e.g., `uv tool install /workspace/group/myproject`). | Every container spawn, after init.sh |

If an install takes more than a few seconds and is the same across all workers, move it to a Dockerfile layer.

## Running

The container stays alive until:
- The master destroys it
- NanoClaw restarts (containers run with `--rm`)
- The container crashes (OOM, agent error, etc.)
- Docker is restarted

Workers have no idle timeout (disabled via `disableIdleTimeout`). They stay up indefinitely.

## Destroy

When the master calls `destroy_worker`:

1. **Container killed** if running.
2. **Discord channel deleted.**
3. **Registration removed** from `registered_groups` in SQLite.
4. **Session ID preserved** in the `sessions` table so a future `create_worker` with `reuse: "resume"` can pass it to the SDK for continuation.
5. **Session dir preserved** (`data/sessions/{folder}/.claude/`) with conversation history.
6. **Agent-runner cache deleted** (`data/sessions/{folder}/agent-runner-src/`).
7. **Workspace preserved** (`groups/{folder}/`). Repos, code changes, and CLAUDE.md stay on disk.

If the worker was a Neuralwatt worker, the master reports its lifetime usage stats before cleanup.

## Restart Recovery

When NanoClaw restarts:

1. All running containers are lost (`--rm` flag means Docker auto-removes them).
2. NanoClaw loads worker registrations from SQLite on startup.
3. Worker profiles are re-synced to SQLite (profile changes take effect).
4. `available_groups.json` is regenerated.
5. On the next message to any worker, a fresh container spawns and the worker resumes.

Session IDs are preserved in SQLite, so conversation context survives across restarts (the SDK resumes the session).

## Directory Layout

The `groups/` directory is gitignored and holds per-agent workspaces:

| Directory | What it is | Created by |
|-|-|-|
| `groups/discord_main/` | Master agent workspace (assembled CLAUDE.md, repos, logs) | Startup sync |
| `groups/discord_{name}/` | Worker workspaces (repos, code, assembled CLAUDE.md) | `create_worker` |

All `groups/` directories are ephemeral workspaces (gitignored). Agent instructions are assembled from layered fragments at startup (master) or worker creation time:

1. `instructions/global.md` (repo) — shared base for all agents
2. `instructions/master.md` or `instructions/worker.md` (repo) — role-specific
3. `~/.config/nanoclaw/instructions/global.md` (personal) — user-specific, all agents
4. `~/.config/nanoclaw/instructions/master.md` or `worker.md` (personal) — user-specific, role-specific

The assembled result is written to `groups/{folder}/CLAUDE.md`. See `profile-sync.ts` for the assembly logic.

## Storage Layers

| Layer | Location | Survives container death? | Survives destroy? | Survives "fresh" recreate? |
|-|-|-|-|-|
| Registration | SQLite `registered_groups` | Yes | No | No |
| Session ID | SQLite `sessions` table | Yes | Yes (for resume) | No |
| SDK state | `data/sessions/{folder}/.claude/` | Yes | Yes (for resume) | No |
| Agent-runner cache | `data/sessions/{folder}/agent-runner-src/` | Yes | No | No |
| Workspace | `groups/{folder}/` | Yes | Yes | No |

## Updating Workers

When you change the container image, `init.sh`, agent-runner source, or worker profiles, existing running workers don't automatically pick up the changes.

**Container image changes:** Take effect on next container spawn. Kill the container or restart NanoClaw, then message the worker.

**init.sh changes:** Take effect on next spawn. But `init.sh` is designed to be idempotent: it skips repos that are already cloned, tools that are already installed, etc. If you need a tool upgrade, you may need to delete the existing installation first.

**Agent-runner source changes:** The host auto-syncs agent-runner source by comparing mtimes. Changes take effect on the next container spawn without manual intervention.

**Worker profile changes:** Synced to SQLite on NanoClaw startup, but don't trigger container restarts. Restart NanoClaw, then the next container spawn uses the new profile.

**Instruction changes** (`instructions/` or `~/.config/nanoclaw/instructions/`): The assembled CLAUDE.md is regenerated on every NanoClaw startup (for master and all workers). Changes take effect on next container spawn — no destroy/recreate needed, just restart NanoClaw and message the worker.

**Personal Dockerfile changes** (`~/.config/nanoclaw/Dockerfile`): Requires an image rebuild (`container/build.sh`), then restart NanoClaw. Existing workers respawn with the new image on next message.

**Full clean slate:** Destroy the worker and recreate with "fresh" to wipe everything, or destroy and recreate with "resume" to keep repos but get a fresh session and container.
