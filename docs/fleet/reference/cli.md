# `ncf` CLI Reference

`ncf` (NanoClaw Fleet) is the command-line tool for managing the fleet. The wrapper at `./ncf` (or `ncf` if you alias it globally) calls `pnpm exec tsx scripts/ncf.ts`.

```bash
alias ncf='/path/to/nanoclaw-fleet/ncf'
```

All mutation commands (create, destroy, switch) are **fire-and-forget** — they write a system action into the master's outbound DB and exit immediately. The host's delivery loop processes the action and notifies the master via inbound chat. Read commands hit the central DB or filesystem directly.

## Commands

### `ncf status [--json]`

Snapshot of the fleet: master + every worker, container state, backend, model, channel, last activity. `--json` for machine-readable output (consumed by the status pin).

### `ncf list [--json]`

Alias for `status`.

### `ncf create <name> [--backend <b>] [--model <m>] [--instructions <text>]`

Create a worker. Writes a `create_worker` system action to the master's outbound DB. The host:

- Inserts the agent_group (or reactivates an archived one with the same name).
- Creates a Discord channel (skipped if `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID` aren't set).
- Wires bidirectional `agent_destinations` to the master.
- Applies the worker profile.
- Syncs the shim's `worker-backends.json` if `NW_SHIM_CONFIG_PATH` is set.
- Writes a worker event.
- Notifies the master via inbound chat.

Flags:

- `--backend` — `claude` (default) or `neuralwatt` or any registered provider.
- `--model` — model id; for Neuralwatt the shim does fuzzy resolution.
- `--instructions` — initial CLAUDE.local.md content.

The container does not spawn until the worker's channel receives a message.

### `ncf destroy <name> [--keep-channel]`

Destroy a worker. Stops the container, archives the agent_group (`status='archived'`), removes the worker → master destination, deletes the Discord channel by default. Workspace, session id, and SDK state are preserved on disk. Pass `--keep-channel` to leave the Discord channel intact (useful when you plan to recreate immediately).

### `ncf switch <name> <backend> [model]`

Change a worker's backend or model. Accepts `master` and `self` as aliases (the master can switch its own provider). Writes a `switch_backend` action.

```bash
ncf switch foo neuralwatt moonshotai/Kimi-K2.5
ncf switch foo neuralwatt qwen-coder            # fuzzy-resolved through shim
ncf switch foo claude claude-opus-4-7
ncf switch master neuralwatt zai-org/GLM-5.1-FP8
```

Within Neuralwatt, model-only switches edit the shim's `worker-backends.json` and take effect on the next request. Cross-backend switches (Claude ↔ Neuralwatt) restart the container.

### `ncf logs <name> [--follow] [--cache] [--slow <ms>]`

Wrapper around `docker logs` for the worker's running container.

- `--follow` — `docker logs -f`
- `--cache` — filter to lines that look like SDK cache hits
- `--slow <ms>` — filter to turns slower than this

Container stderr is also archived to `logs/workers/<folder>/stderr-<ts>.log` (last 20 retained), so trace ids stay searchable after the container exits.

### `ncf session <name> [--limit N]`

Last N rows from the session's `inbound.db` and `outbound.db`. Default 10 of each. Useful for "what did the agent actually see and reply with?".

### `ncf inject <name> <msg> [--wait] [--timeout <sec>]`

Write a chat message directly into the worker's `inbound.db` (bypassing Discord) and POST a wake to the host. With `--wait`, polls `messages_out` for a reply and prints it.

Useful for scripted testing. Won't exercise channel adapters, throbber reactions, or status pins — for those use the debug bot path documented in [testing.md](../guides/testing.md#real-discord-with-the-debug-bot).

### `ncf restart <name> [--fresh]`

Kill the worker's container. Next message respawns it. With `--fresh`, also clears `session_state.stored_session_id` so the SDK starts a new session (instead of resuming).

### `ncf debug`

System diagnostic dump: paths, agent groups, docker state, shim health, wake server. The first thing to run when something feels off.

### `ncf reap-orphans [--confirm]`

Find Discord channels named `worker-*` or `lc-*` whose channel id isn't in `messaging_groups`, list them. With `--confirm`, delete them. Useful after a failed `create_worker` left a channel behind without a corresponding agent_group.

### `ncf history [name] [--since <iso>] [--limit N] [--event <kind>] [--json]`

Read `logs/worker-events.jsonl`. Filter by worker, event type, since-date, max count.

```bash
ncf history                                    # last 50 events
ncf history foo                                 # only events touching 'foo'
ncf history --event backend_switched
ncf history --since 2026-04-01T00:00:00Z --limit 200
ncf history --json | jq '.[] | select(.event=="created")'
```

### `ncf turns <name> [--limit N] [--slow <ms>]`

Read the worker's `data/v2-sessions/<ag>/<sess>/turns.jsonl`. One line per SDK turn with tokens, latency, stop reason, energy.

```bash
ncf turns foo                       # last N turns
ncf turns foo --slow 5000           # turns over five seconds
ncf turns foo --json | jq
```

### `ncf trace <name> [--limit N] [--full] [--errors-only] [--json]`

Read `logs/shim-traces/<folder>.jsonl` — one entry per `/v1/messages` call through the shim, with the full request body and an Anthropic-shape final response. Use this when a worker isn't responding and you need to see what it actually sent the model and what came back.

```bash
ncf trace foo                       # last 5 entries, summarised
ncf trace foo --limit 1             # most recent only
ncf trace foo --full                # don't truncate any field
ncf trace foo --errors-only         # only non-2xx + transport errors
ncf trace foo --json | jq           # raw JSONL
```

Only covers traffic that flows through the shim — neuralwatt-backed workers, plus anthropic-backed ones if their `ANTHROPIC_BASE_URL` points at the shim. A claude-direct worker that talks straight to `api.anthropic.com` won't appear here. Disable globally with `SHIM_TRACES=0`; relocate with `SHIM_TRACES_DIR=/some/path`.

### `ncf rebuild`

Wraps `container/build.sh`. Rebuilds the base image, layers your personal Dockerfile if present, retags `:latest`.

## Cheat sheet

| Task                      | Command                               |
| ------------------------- | ------------------------------------- |
| Health check              | `ncf status`                          |
| Diagnostic dump           | `ncf debug`                           |
| Make a worker             | `ncf create <name>`                   |
| Switch backend            | `ncf switch <name> <backend> [model]` |
| Restart worker            | `ncf restart <name>`                  |
| Reset session             | `ncf restart <name> --fresh`          |
| Image rebuild             | `ncf rebuild`                         |
| Watch live logs           | `ncf logs <name> --follow`            |
| Slow-turn audit           | `ncf turns <name> --slow 5000`        |
| Inspect last API exchange | `ncf trace <name> --limit 1 --full`   |
| Lifecycle audit           | `ncf history`                         |
| Cleanup orphans           | `ncf reap-orphans --confirm`          |
| Send a probe              | `ncf inject --wait <name> "ping"`     |

## After code changes

```bash
# host source (src/)
pnpm run build
systemctl --user restart nanoclaw

# agent runner (container/agent-runner/src/)
ncf restart <worker>           # auto-syncs by mtime; no rebuild needed

# container image (container/Dockerfile or ~/.config/nanoclaw/Dockerfile)
ncf rebuild
ncf restart <worker>
```
