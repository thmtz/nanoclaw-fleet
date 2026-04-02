# Design: Dynamic Worker Agents

Status: **In Progress** | Created: 2026-03-26 | Updated: 2026-03-26

## Glossary

- **Worker** — An isolated coding agent: a Discord channel + Docker container + Claude agent session. Created on demand, destroyed when no longer needed.
- **Worker profile** — A JSON config file defining what a worker comes pre-loaded with: repos to clone, tools to install, credentials to mount, skills to symlink, and a CLAUDE.md template. Lives at `~/.config/nanoclaw/worker-profiles/`. The repo ships examples at `worker-profiles/`.
- **Container image** — The Docker image (`nanoclaw-agent:latest`) with base tools baked in (node, python, cargo, uv, ruff, dolt, bd). Shared by all workers. Rebuilt infrequently.
- **Init script** — `init.sh` from the worker profile, runs on container boot. Clones repos, installs tools, symlinks skills. Personalizes the generic container image into a worker environment.
- **Master** — The orchestrator agent in `#master`. Its only job is lifecycle management (create/list/destroy workers). Runs with `isMain=true`.

## Problem

We want to spin up isolated coding agents on demand, each with its own Discord channel, from a single "master" channel. Today we manually set up each agent session. This doesn't scale and requires pre-provisioning.

## Goals

1. **Master channel as orchestrator.** One persistent Discord channel where the user talks to a master agent. The master's only job is lifecycle management — creating, listing, and tearing down workers.

2. **Workers are disposable.** Each worker is a fresh Docker container with its own Discord channel and Claude agent. Think of them like VMs: spin up, do work, tear down. Workers should be cheap to create and destroy.

3. **One bot token.** A single Discord bot owns the gateway. NanoClaw's host process routes messages between channels and containers. No bot pool.

4. **Pre-configured worker environments.** Workers boot with a known set of tools, repos, and credentials. This config should be declarative — a template or manifest that says "clone these repos, mount these secrets, install these tools."

5. **Channel-per-worker mapping.** Each worker gets a dedicated Discord channel in the server. The channel is created when the worker spins up and (optionally) archived or deleted when it's torn down.

6. **Worker isolation.** Workers cannot see each other's filesystems or sessions. They communicate with the outside world only through their Discord channel (and whatever network access the container allows).

7. **Worker persistence is opt-in.** By default, tearing down a worker destroys its container and state. But we may want to "pause" a worker (stop container, keep volume) and resume later.

8. **Long-lived workers.** Workers must stay alive until explicitly shut down — no idle reaping. Many workstreams involve 12+ hour processes. The current 30-min global idle timeout would kill these. Workers should only terminate when the master (or user) says so. Need to verify the Agent SDK itself doesn't silently drop sessions over long durations (context compaction is expected, but session loss is not acceptable).

9. **Code survives container death.** All local code work (cloned repos, uncommitted changes, new commits) must survive a container crash or restart. Containers are ephemeral — they run with `--rm` and can die at any time (OOM, host reboot, manual kill, agent error). The bind-mount strategy (`/workspace/group` → `groups/{worker}/` on host) ensures repo data lives on the host filesystem, not inside the container. **Workers must never write code or meaningful state outside of `/workspace/group`.** Anything outside that path (installed tools, pip packages, compiled binaries, `/tmp`) is ephemeral and rebuilt by `init.sh` on next spawn. When a container dies mid-work, messaging the worker's Discord channel spawns a fresh container with the same bind mounts — repos and all their changes are still there, only the conversation context and installed tooling need to be rebuilt.

## Non-Goals (for now)

- Workers coordinating with each other directly
- Auto-scaling or queue-based worker assignment
- Multi-server (multi-guild) support
- Web UI for management

## Open Questions

- **Worker templates:** How do we define what goes into a worker container? Dockerfile per template? Mount list in a config file? Inherit from a base image?
- **Channel naming:** Auto-generated (`worker-001`) or user-specified (`gpu-experiment-march`)?
- **Master agent scope:** Should the master be able to peek into worker channels (read-only), or is it purely lifecycle management?
- **Credential forwarding:** Which secrets get mounted into workers? All of them? A curated subset?
- **Cost guardrails:** Max concurrent workers? Per-worker token budget?

## Architecture Sketch

```
Discord Server
  #master          <-->  NanoClaw host  <-->  Master agent (isMain=true)
  #worker-alpha    <-->       |         <-->  Container A (Claude agent)
  #worker-beta     <-->       |         <-->  Container B (Claude agent)
  ...
```

Single bot token. Host owns the gateway. Routes messages by channel ID. Master agent uses `register_group` MCP tool + Discord API (`guild.channels.create`) to spawn workers.

## Skills in Workers

Workers run the Agent SDK, which supports the `Skill` tool. Slash commands typed in a worker's Discord channel arrive as plain text — the agent interprets and invokes them, no Discord slash command registration needed.

Skills must be present in the container's `.claude/skills/` to be available. Today NanoClaw copies from `container/skills/` in the repo. To make personal skills (`~/.claude/skills/`) available to workers, we can either mount the host directory read-only or copy selected skills into the container image. TBD which approach — mount is simpler, copy is more reproducible.

## What NanoClaw Already Supports

- `register_group` MCP tool — master agent can dynamically register new channel→container mappings at runtime (fully implemented: IPC → host watcher → SQLite → message routing)
- Per-group container isolation (isolated filesystem, `.claude/` session, IPC directory)
- Concurrency control via GroupQueue (default 5 concurrent containers)
- Single bot token, host-owned gateway, channel-ID-based routing

## Implementation Progress

### Phase 1: Minimal end-to-end loop (in progress)

**Done:**
- `DiscordChannel.createChannel()` and `deleteChannel()` added to `src/channels/discord.ts`
- `Channel` interface extended with optional `createChannel`/`deleteChannel` in `src/types.ts`
- `create_worker` and `destroy_worker` IPC task handlers added to `src/ipc.ts`
- IPC deps wired in `src/index.ts` to bridge Discord channel methods to IPC
- `create_worker` and `destroy_worker` MCP tools added to `container/agent-runner/src/ipc-mcp-stdio.ts` (master-only)
- Discord bot granted `Manage Channels` permission
- Discord server created, `#master` channel registered as main group
- Master agent CLAUDE.md updated with orchestrator instructions and ack-first communication style
- `DISCORD_GUILD_ID` added to `.env`, tools default to it
- `.env.example` updated with documented Discord config (guild ID, bot token, permissions)

**Tested and working (2026-03-26):**
- Master agent in `#master` receives "create a worker called X" → calls `create_worker` → Discord channel created → group registered
- Worker channel responds to all messages without @mention (`requiresTrigger: false`)
- Worker container spawns on first message, fully isolated (`isMain: false`)
- End-to-end flow confirmed: master creates channel, user messages worker, worker responds

**Learnings:**
- **Agent-runner source is cached per-group.** `container-runner.ts` copies `container/agent-runner/src/` to `data/sessions/{group}/agent-runner-src/` on first run, then mounts it into the container. It only copies if the directory doesn't exist. To pick up source changes, delete `data/sessions/{group}/agent-runner-src/` manually.
- Container Docker build also caches COPY steps. Must `docker build --no-cache` when source changes (not `build.sh --no-cache` — the script uses `$1` as tag).
- Agent doesn't pick up CLAUDE.md changes mid-session — must kill container to force a fresh spawn.
- The `DISCORD_GUILD_ID` env var must be passed through to containers for `create_worker` defaults to work. Verify it reaches the agent runner.

### Phase 2: Worker profiles + polish (in progress)

**Done:**
- `destroy_worker` now deletes from SQLite (prevents zombie groups on restart)
- Self-destruction guard (master can't destroy itself)
- Worker profiles system: `worker-profiles/default.json` defines repos, tools, mounts
- `worker-profiles/init.sh` — runs on container boot, clones repos, installs tools
- `worker-profiles/CLAUDE.worker.md` — template instructions for worker agents
- Workers can self-improve their profile by editing `worker-profiles/` and filing a PR
- Dockerfile updated to run init.sh before agent starts
- Container runner passes WORKER_REPOS and WORKER_TOOLS env vars from profile

**Done:**
- Idle timeout disabled for workers (`disableIdleTimeout` flag, 24h hard timeout)
- Agent-runner source syncs based on mtime (no more stale tools)
- Duplicate worker name check prevents channel orphaning
- destroy_worker race fix (2s delay before channel deletion)
- Master CLAUDE.md documents all MCP tools
- Skills installed via init.sh symlinks from cloned skills repo (working)

**Deferred:**
- Verify Agent SDK session stability over 12+ hours (needs real-world testing)
- IPC fire-and-forget feedback (cosmetic — host sends its own confirmation)

### Phase 3: Configurable inference backend (implemented)

Goal: let the master agent choose which model and backend each worker uses at creation time.

#### Current state

- `NANOCLAW_MODEL` is a global env var (`sonnet`/`opus`/`haiku`) — same for all containers
- All containers route API traffic through the credential proxy (host port 3001), which forwards to `ANTHROPIC_BASE_URL` (defaults to `api.anthropic.com`)
- The proxy injects real credentials — containers only see placeholder tokens
- Worker profiles already support per-worker env vars via `worker.env`

#### Per-worker model selection

Add a `"model"` field to worker profiles. When `create_worker` runs, write `NANOCLAW_MODEL=<model>` to the worker's `data/sessions/{group}/worker.env`. The agent-runner already reads `NANOCLAW_MODEL` from env (line 395 of `container/agent-runner/src/index.ts`), so no container-side changes needed.

The `create_worker` MCP tool gains an optional `model` parameter. Master can say "create a worker called gpu-test using haiku." If omitted, falls back to the global `NANOCLAW_MODEL`.

#### Swappable inference backend (Anthropic vs Neuralwatt)

Two backends:
- **Anthropic** — Claude models via `api.anthropic.com` (current default)
- **Neuralwatt** — Open-source models (Qwen, Kimi, DeepSeek, etc.) via Neuralwatt's inference API

The Agent SDK sends requests to whatever `ANTHROPIC_BASE_URL` points at. The credential proxy currently runs one instance forwarding to one upstream. To support two backends:

**Option A: Two proxy instances (simpler)**
- Proxy A (port 3001) → `api.anthropic.com` with Anthropic credentials
- Proxy B (port 3002) → Neuralwatt endpoint with Neuralwatt API key
- Worker profile specifies `"backend": "anthropic"` or `"neuralwatt"`
- `container-runner.ts` sets the container's `ANTHROPIC_BASE_URL` to the corresponding proxy port

**Option B: Single proxy with per-request routing (cleaner)**
- One proxy instance, route based on a custom header (e.g., `X-Backend: neuralwatt`)
- Proxy selects upstream + credentials based on the header
- Requires injecting the header in the Agent SDK's requests (may not be configurable)

**Recommended: Option A.** It's straightforward, no SDK changes needed, and the two proxy instances are trivial (same code, different config). The credential proxy is ~120 lines — spinning up a second instance is cheap.

**Neuralwatt compatibility requirement:** The Neuralwatt endpoint must speak the Anthropic Messages API (`/v1/messages`), since that's what the Agent SDK sends. If Neuralwatt only speaks OpenAI format, we'd need a translation shim (e.g., LiteLLM proxy or a custom adapter). This is the main unknown.

**Inference API key:** Store your API key at a known path (e.g., `~/.config/nanoclaw/inference_api_key`) and mount it read-only into worker containers. The host proxy reads it directly.

#### Implementation steps

1. Add `model` and `backend` fields to worker profile JSON schema
2. Add optional `model` and `backend` params to `create_worker` MCP tool
3. Write `NANOCLAW_MODEL` to `worker.env` from profile/tool params
4. Extract proxy startup into a factory (`createProxy(port, upstream, credentials)`)
5. Start two proxy instances in `src/index.ts` — one Anthropic, one Neuralwatt
6. In `container-runner.ts`, set `ANTHROPIC_BASE_URL` to the correct proxy port based on the worker's backend config
7. Test with a Neuralwatt-backed worker running an open-source model

### Phase 4: Stretch goals (not started)

- Container pause/resume (named volumes, stop-without-remove)
- Worker templates (declarative config for what goes into a container)

## Worker Lifecycle

Each worker has state across three storage layers:

| Layer | Path | Contents | Survives destroy? |
|-|-|-|-|
| DB | SQLite (`registered_groups`, `sessions`) | Registration, session ID | No |
| Session state | `data/sessions/{folder}/` | `.claude/` (SDK state, skills, debug), `agent-runner-src/` | No |
| Workspace | `groups/{folder}/` | Cloned repos, code changes, CLAUDE.md | Yes |

**Destroy** deletes DB records and session state. The workspace is preserved so a future worker with the same name can reuse it.

**Create** with a name that has an existing workspace triggers a collision prompt:
- `reuse: "resume"` — keep workspace (repos, code changes), fresh SDK session
- `reuse: "fresh"` — wipe everything (workspace + session state)

The "resume" option preserves code changes, not conversation history. Conversation context is lost on every container restart (the SDK always starts fresh). The session ID in SQLite just tells the SDK which transcript to append to, but with session state deleted on destroy, there's nothing to resume. A "resumed" worker simply gets its repos and files back.

`create_worker` also defensively clears any stale `.claude/` or `agent-runner-src/` data, in case destroy didn't run or ran before this cleanup logic existed.

## Why Not Claude Code Channels?

CC Channels is architecturally 1:1 — one bot process, one gateway, one Claude session. Multiple guild channels can feed into one session, but they all share one context (not isolated). To get N independent agents, you'd need either a pool of bot tokens (one per session) or a routing layer between Discord and multiple Claude processes. The routing layer approach is exactly what NanoClaw already provides — one bot, one gateway, N containers — so we build on that rather than reinventing it inside the CC Channels plugin.

## Prior Art

- CC Channels plugin supports `DISCORD_STATE_DIR` for multi-instance, but requires one bot token per instance
