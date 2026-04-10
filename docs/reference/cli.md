# ncf CLI Reference

The `ncf` (NanoClaw Fleet) CLI is the unified tool for managing workers, containers, and debugging. Works from both the host machine and inside containers.

## Installation

```bash
# From project root
npx tsx src/cli.ts <command>

# Or add alias
alias ncf='npx tsx /path/to/nanoclaw-fleet/src/cli.ts'
```

## Commands

### Status

```bash
ncf status [--json]
```

Show all workers, containers, backends, and usage stats.

**Output fields:**

- `folder` — Group folder name (e.g., `discord_main`)
- `name` — Display name
- `jid` — Discord channel ID
- `backend` — `anthropic` or `neuralwatt`
- `model` — Model ID
- `container` — Running container name or `null`
- `requests` — Total requests
- `tokens` — Total tokens
- `energyWh` — Energy usage (Neuralwatt only)

### Create

```bash
ncf create <name> [--backend <b>] [--model <m>] [--trigger <t>]
```

Create a new worker (Discord channel + workspace). Container spawns on first message.

**Options:**

- `--backend` — `anthropic` (default) or `neuralwatt`
- `--model` — Model ID for neuralwatt (e.g., `moonshotai/Kimi-K2.5`)
- `--trigger` — Trigger pattern (default: `@Andy`)

### Destroy

```bash
ncf destroy <worker>
```

Tear down a worker: delete Discord channel, remove registration, clear session state. Workspace preserved.

### Switch

```bash
ncf switch <worker> <backend> [model]
```

Switch a worker's backend or model. Neuralwatt-to-Neuralwatt switches are instant; cross-backend switches restart the container.

**Examples:**

```bash
ncf switch test-worker neuralwatt moonshotai/Kimi-K2.5
ncf switch test-worker anthropic
```

### Restart

```bash
ncf restart <worker> [--fresh]
```

Restart a worker's container. Use `--fresh` to clear session history first.

**Use cases:**

- `ncf restart main` — Restart master container (picks up code changes)
- `ncf restart main --fresh` — Fresh start, clears `.claude/` session state
- `ncf restart worker-name` — Restart a worker container

### Rebuild

```bash
ncf rebuild [worker]
```

Rebuild the container image. Required after `Dockerfile` or `init.sh` changes.

**Note:** Agent-runner source auto-syncs by mtime on each container spawn — no rebuild needed for `container/agent-runner/src/` changes.

### Logs

```bash
ncf logs <worker> [n] [--cache|--slow|--follow|--json]
```

Show per-worker audit logs (turns).

**Options:**

- `n` — Number of entries (default: 20)
- `--cache` — Show only cache hits
- `--slow` — Show only slow requests (>5s)
- `--follow` — Follow container logs in real-time
- `--json` — JSON output

### Session

```bash
ncf session <worker> [lines] [--json]
```

Show session transcript from the SDK's JSONL file.

**Options:**

- `lines` — Number of lines (default: 80)
- `--json` — JSON output

### History

```bash
ncf history [--json] [--since <date>] [--limit <n>]
```

Query worker lifecycle events from `logs/worker-events.jsonl`.

**Options:**

- `--since` — ISO timestamp (e.g., `2026-04-06T00:00:00Z`)
- `--limit` — Max events (default: 50)
- `--json` — JSON output

### Inject

```bash
ncf inject <channel> <message> [--wait]
```

Inject a message to any registered channel. Useful for testing and debugging.

**Options:**

- `--wait` — Poll logs until agent responds, then print output

**Examples:**

```bash
ncf inject main "create a worker called test"
ncf inject --wait test "what model are you?"
ncf inject dc:1234567890 "hello"
```

### Debug

```bash
ncf debug
```

Show system state: paths, database location, running containers, proxy status, config files.

## When to Use What

| Task                                   | Command                                   |
| -------------------------------------- | ----------------------------------------- |
| Check system health                    | `ncf status`                              |
| Create a worker                        | `ncf create <name>`                       |
| Tear down a worker                     | `ncf destroy <name>`                      |
| Switch a worker's model                | `ncf switch <name> neuralwatt <model>`    |
| Restart master after code changes      | `ncf restart main`                        |
| Fresh start for master (clear session) | `ncf restart main --fresh`                |
| Rebuild after Dockerfile changes       | `ncf rebuild`                             |
| Debug a worker's conversation          | `ncf session <name>`                      |
| Check cache performance                | `ncf logs <name> --cache`                 |
| Test via CLI                           | `ncf inject --wait <name> "test message"` |
| System diagnostics                     | `ncf debug`                               |

## Common Patterns

### Testing a Worker

```bash
ncf create test-e2e --backend neuralwatt --model moonshotai/Kimi-K2.5
ncf inject --wait test-e2e "what model are you?"
ncf logs test-e2e --cache  # Check cache hits
ncf destroy test-e2e
```

### Debugging Master Issues

```bash
ncf restart main --fresh   # Clear stale session
ncf inject main "list workers"
ncf logs main 50             # Last 50 log entries
```

### After Code Changes

```bash
# Host-side changes (src/)
npm run build && systemctl --user restart nanoclaw

# Container-side changes (container/Dockerfile)
ncf rebuild

# Agent-runner changes (container/agent-runner/src/)
# Auto-syncs on next spawn — just restart the container
ncf restart main
```
