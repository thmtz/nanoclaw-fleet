# `ncf` CLI Reference

`ncf` (NanoClaw Fleet) is the unified tool for managing workers, watching the system, and debugging. The wrapper at `./ncf` calls `npx tsx src/cli.ts`. Drop a shell alias into your dotfiles for global use:

```bash
alias ncf='/path/to/nanoclaw-fleet/ncf'
```

`ncf` works from the host. From inside a container, the master can use the same script via `cd /workspace/project && ncf <command>`.

## Commands

### `ncf status [--json] [--no-color]`

Snapshot of the fleet: master, every worker, container state, backend, model, and usage. `--json` for machine output (used by the Discord status pin). `--no-color` for unstyled text.

Fields per worker: `folder`, `name`, `jid`, `backend`, `model`, `container` (running/stopped), `requests`, `tokens`, `energyWh` (Neuralwatt only), `lastActivity`.

### `ncf create <name> [--backend <b>] [--model <m>] [--trigger <t>]`

Create a worker. Creates the Discord channel, registers the group, prepares the workspace, and seeds backend config. The container does not spawn until the channel receives a message.

- `--backend` — `anthropic` (default) or `neuralwatt`
- `--model` — model id (Anthropic alias or Neuralwatt id; fuzzy matched via the shim)
- `--trigger` — message-trigger pattern (default: `@<assistant>`). Workers normally use no trigger; only main-style channels need one.

If the workspace already exists at `groups/discord_<name>/`, the master is prompted to choose `resume` or `fresh`.

### `ncf destroy <worker>`

Tear down a worker. Kills the container, deletes the Discord channel, removes the SQLite registration, clears the agent-runner cache. The session id, the SDK state, and the workspace are preserved so a future `ncf create` with `resume` continues where you left off.

### `ncf switch <worker> <backend> [model]`

Change a worker's backend or model. Examples:

```bash
ncf switch test neuralwatt moonshotai/Kimi-K2.5
ncf switch test neuralwatt qwen-coder      # fuzzy resolved
ncf switch test anthropic claude-opus-4-7
```

Within Neuralwatt, switches take effect on the next request (no restart). Cross-backend switches (Anthropic ↔ Neuralwatt) restart the container.

### `ncf restart <worker> [--fresh]`

Restart a worker's container. `--fresh` deletes `.claude/` first, so the SDK starts a new session. Use after host-side code changes or to recover from a crash loop.

### `ncf rebuild [worker]`

Rebuild the agent container image. Run after changes to `container/Dockerfile` or your personal `~/.config/nanoclaw/Dockerfile`. Agent-runner source under `container/agent-runner/src/` auto-syncs by mtime on every spawn, so a rebuild is not needed for those changes.

### `ncf logs <worker|--host> [n] [flags]`

Per-worker turn audit, read from `logs/workers/<folder>/turns.jsonl`. With `--host`, follows the host log instead.

- `n` — number of entries (default: 20)
- `--cache` — only cache hits
- `--slow` — only requests slower than 5 seconds
- `--follow` — tail container logs live
- `--grep <pattern>` — filter by substring
- `--json` — raw JSONL

### `ncf session <worker> [n] [--live | --json]`

SDK transcript for a worker. Default shows the last 80 lines of the assembled view (tool calls, thinking blocks, replies). `--live` streams new events as they arrive. `--json` emits one JSON event per line.

### `ncf history [worker] [--since <date>] [--limit <n>] [--json]`

Worker lifecycle events from `logs/worker-events.jsonl`: created, destroyed, backend_switched, resumed.

- `--since` — ISO timestamp; only events at or after this time
- `--limit` — max events (default: 50)
- `worker` — filter to one worker (partial match accepted)

### `ncf inject [--wait] <channel> <message>`

Write a message into IPC for the given channel. Bypasses Discord, useful for scripted testing. With `--wait`, polls docker logs until the agent replies and prints the response.

```bash
ncf inject main "create a worker called test"
ncf inject --wait test "what model are you?"
ncf inject dc:1234567890 "hello"
```

For end-to-end coverage that includes the Discord gateway, use the debug bot path described in [testing.md](../guides/testing.md#real-discord-with-the-debug-bot).

### `ncf test [--skip-nw]`

Run the standard end-to-end smoke. Creates temporary workers, exercises lifecycle, model switching, and Neuralwatt routing, then destroys them on exit. `--skip-nw` skips Neuralwatt scenarios when the shim is offline.

### `ncf debug`

Dump system state: project paths, database location, running containers, proxy reachability, env vars, mount allowlist resolution. The first thing to run when something feels off.

## Cheat sheet

| Task | Command |
|-|-|
| Health check | `ncf status` |
| Make a worker | `ncf create <name>` |
| Switch model | `ncf switch <name> neuralwatt <model>` |
| Restart a worker | `ncf restart <name>` |
| Restart and clear session | `ncf restart <name> --fresh` |
| Image rebuild | `ncf rebuild` |
| Inspect last turn | `ncf logs <name>` |
| Cache audit | `ncf logs <name> --cache` |
| Slow-request audit | `ncf logs <name> --slow` |
| Watch transcript | `ncf session <name> --live` |
| Lifecycle audit | `ncf history` |
| Smoke test | `ncf test` |
| Diagnostic dump | `ncf debug` |

## After code changes

```bash
# host-side (src/)
npm run build && systemctl --user restart nanoclaw

# container image (container/Dockerfile or personal Dockerfile)
ncf rebuild
ncf restart <worker>           # next spawn picks up the new image

# agent-runner (container/agent-runner/src/)
ncf restart <worker>           # auto-synced by mtime; no rebuild needed
```
