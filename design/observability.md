# Unified Observability for NanoClaw Fleet

Status: DRAFT
Author: thmtz | Created: 2026-04-10

## Problem

A single user message travels through six layers before a response appears in Discord:

    Discord -> NanoClaw host -> Docker container -> Agent SDK -> API provider -> back

When something goes wrong (agent hangs, response missing, wrong context, slow reply), diagnosing requires checking multiple disconnected log sources. There's no way to trace a single request across all layers, and some layers have no logging at all.

Real examples from today:
- The master agent hung for 30 minutes. We had to `docker exec` into the container and check TCP socket state to figure out the SDK wasn't making network calls. Nothing was logged between "message received" and "container timeout."
- A worker claimed it had no custom instructions, but we couldn't verify what system prompt the SDK actually sent to the API.
- The `didGroupSendMessage` flag suppressed a response silently. No log recorded the suppression.

## Current State

Six separate log sources, each with different formats and gaps:

| Layer | File | Format | Captures | Missing |
|-|-|-|-|-|
| Host process | `logs/nanoclaw.{log,jsonl}` | pino (pretty + JSONL) | Message receive, container spawn, IPC events, errors | No per-message trace ID. No suppression/throbber events. |
| Worker audit | `logs/workers/<folder>/turns.jsonl` | JSONL | model, tokens, latency, energy per API call | No request/response content. Extracted after container exits. |
| Worker events | `logs/worker-events.jsonl` | JSONL | created, destroyed, backend_switched | Missing `time` on some entries. |
| Container stderr | `docker logs <name>` | plaintext | `[msg #N] type=X`, SDK init, MessageStream counters | Gone when container is removed. Not indexed. |
| SDK session | `data/sessions/<folder>/.claude/.../session.jsonl` | JSONL | Full conversation (user msgs, tool calls, results, assistant text) | No system prompt. No raw API request. No per-message timing. |
| Shim/proxy | `logs/shim.{log,error.log}` | plaintext | Request method + path, per-NW-call audit | No request body. No system prompt. No Anthropic-backend calls. |

The SDK session JSONL comes closest to a complete record, but it's missing the system prompt, has no timestamps on individual messages, and doesn't capture what the API provider actually received.

## Goals

1. **Trace any user message end-to-end** from Discord receipt to Discord response, across all layers.
2. **Answer "what was the agent doing?"** at any point, without guessing.
3. **Verify API payloads** when debugging instruction delivery or context issues.
4. **Low overhead by default**, detailed on demand.
5. **Dual-format output**: JSONL for agents to query programmatically, human-readable rendering for operators.

## Design

### Trace IDs

Every user message gets a trace ID when it enters the host. The ID propagates through all layers:

- Host attaches it when storing the message
- Container input includes it
- Agent-runner logs it on every `[msg #N]` line
- Shim/proxy logs it on every API call
- Output callback includes it when the response is sent

Format: `t-<timestamp-ms>-<random>` (e.g., `t-1775852707-a3f`). Short enough to grep, unique enough to avoid collisions.

This is the single most valuable change. Everything else builds on it.

### Tiered Logging: Index + Detail Files

Each worker gets a two-tier log structure. The index file has one compact line per API turn (lightweight, always written). The detail directory has full request/response payloads per turn (heavy, written on demand).

```
logs/workers/<folder>/
  turns.jsonl              # index: one line per API turn (always)
  turns/                   # detail: full payloads per turn (opt-in)
    0001.json              # full request + response for turn 1
    0002.json              # ...
```

The index entry references the detail file by turn number. An agent or human can scan the index to find a turn of interest, then read the detail file for the full picture.

**Index entry (always written):**
```json
{"id":1,"ts":"2026-04-10T14:25:07Z","trace_id":"t-1775852707-a3f","model":"kimi-k2.5","input_tokens":1200,"output_tokens":85,"cached_tokens":1100,"latency_ms":2400,"tools_called":["Bash","send_message"],"stop_reason":"end_turn","detail":"turns/0001.json"}
```

Compared to today's audit entries, this adds: `id`, `trace_id`, `tools_called`, and `detail` pointer.

**Detail file (written when verbose logging is on):**
```json
{
  "id": 1,
  "trace_id": "t-1775852707-a3f",
  "ts": "2026-04-10T14:25:07Z",
  "request": {
    "model": "kimi-k2.5",
    "system": "You are an agent running inside...",
    "messages": [
      {"role": "user", "content": "..."}
    ],
    "tools": ["Bash", "Read", "Write", "Grep", "mcp__nanoclaw__send_message"]
  },
  "response": {
    "content": [
      {"type": "text", "text": "Let me check..."},
      {"type": "tool_use", "name": "Bash", "input": {"command": "ncf status --json"}}
    ],
    "usage": {"input_tokens": 1200, "output_tokens": 85},
    "stop_reason": "end_turn"
  },
  "timing": {
    "queue_ms": 12,
    "boot_ms": 0,
    "api_ms": 2400,
    "total_ms": 2412
  }
}
```

The detail file captures what actually went to the API. System prompt, full message array, tool definitions. This is what you need when debugging "did the agent have the right context?"

Verbose logging is controlled by `NANOCLAW_VERBOSE_LOGS=1` (global) or per-worker config. Off by default because payloads contain conversation content. Large payloads (over some threshold) get the middle truncated, similar to how gpuctl handles long command output.

### Host Event Log

The host JSONL (`nanoclaw.jsonl`) gains trace IDs on all message-related events. A trace through the host for a warm-container response looks like:

```
{"trace_id":"t-...","event":"msg_received","group":"discord_main","sender":"Bob"}
{"trace_id":"t-...","event":"msg_piped","group":"discord_main"}
{"trace_id":"t-...","event":"throbber_start","group":"discord_main","message_id":"..."}
{"trace_id":"t-...","event":"agent_output","group":"discord_main","suppressed":false}
{"trace_id":"t-...","event":"throbber_clear","group":"discord_main"}
{"trace_id":"t-...","event":"msg_sent","group":"discord_main","length":142,"latency_ms":3200}
```

For a cold boot, you'd also see `container_spawn`, `container_first_output`, and startup timing.

Events that are invisible today get explicit entries: message suppression (`suppressed: true`), throbber lifecycle, IPC task processing, backend switches.

### Container Stderr Archival

Container stderr is currently lost when the container is replaced. The host already captures stderr in a buffer. On container exit, write it to `logs/workers/<folder>/stderr-<timestamp>.log`. The host already does this for timeout cases; extend to all exits. This preserves the `[msg #N]` entries, MessageStream counters, and SDK errors for post-hoc debugging.

### CLI: Dual-Format Output

Every log-related `ncf` command supports both formats:

**Human-readable (default):** Rendered text with role headers, indented tool calls, timestamps.

```
$ ncf session main 10
-- USER ----------------------------------------
Give me full status of all workers...

  -> send: Pulling status now.
  <- Message sent.
  -> $ ncf status --json
  <- {"master":{"folder":"discord_main"...
  -> send: | Worker | Model | Status |...
  <- Message sent.
```

**Machine-readable (`--json`):** Compact JSONL, one line per action. Easy to pipe through `jq`.

```bash
$ ncf session main --json | jq 'select(.tool == "Bash") | .command'
"ncf status --json"
"docker ps --filter name=nanoclaw..."

$ ncf logs main --json | jq 'select(.latency_ms > 5000)'
{"id":3,"trace_id":"t-...","model":"kimi-k2.5","latency_ms":9200,...}
```

New command: `ncf trace <trace-id>` assembles the full cross-layer timeline for one request. Pulls from host events, container stderr, SDK session, and audit index. Shows everything that happened between message receipt and response delivery.

```bash
$ ncf trace t-1775852707-a3f
14:25:04.100  host     msg_received    sender=Bob
14:25:04.112  host     msg_piped       -> discord_main
14:25:04.150  host     throbber_start  message_id=1492249125985718323
14:25:04.300  agent    [msg #41] system/init
14:25:06.500  agent    [msg #42] assistant (tool_use: Bash)
14:25:06.800  agent    [msg #43] user (tool_result)
14:25:07.100  api      kimi-k2.5       1200 in / 85 out / 2400ms  [detail: turns/0003.json]
14:25:07.200  agent    [msg #44] assistant (text)
14:25:07.300  host     agent_output    suppressed=false
14:25:07.400  host     msg_sent        length=142
14:25:07.400  host     throbber_clear

$ ncf trace t-1775852707-a3f --json   # same data as JSONL
```

## What This Doesn't Cover

- **Metrics/alerting.** This is logging, not monitoring.
- **Log shipping.** Logs stay local. JSONL format makes it easy to ship later if needed.
- **Automatic anomaly detection.** Humans and agents read the logs.

## Implementation Order

1. **Trace IDs.** Generate in host message handler, propagate through container input, agent-runner, shim. This unblocks everything else.
2. **Host event log enrichment.** Add trace IDs and missing events (suppression, throbber, piping) to nanoclaw.jsonl.
3. **Container stderr archival.** Write stderr to file on all container exits.
4. **Turn index enrichment.** Add `id`, `trace_id`, `tools_called`, `detail` pointer to turns.jsonl.
5. **Detail files.** Add `turns/` directory with full API payloads behind `NANOCLAW_VERBOSE_LOGS`.
6. **`ncf trace` command.** Cross-layer timeline assembly.

Steps 1-3 are the foundation. Steps 4-6 build on it.
