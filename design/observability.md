# Unified Observability for NanoClaw Fleet

Status: DRAFT
Author: thmtz | Created: 2026-04-10

## Problem

A single user message travels through six layers before a response appears in Discord:

    Discord -> NanoClaw host -> Docker container -> Agent SDK -> API provider -> back

When something goes wrong (agent hangs, response missing, wrong context, slow reply), diagnosing requires checking multiple disconnected log sources. Today there's no way to trace a single request across all layers, and some layers have no logging at all.

Real examples from today's session:
- The master agent hung for 30 minutes. We had to `docker exec` into the container and check `ss -tp` to figure out the SDK wasn't making network calls. There was no log entry between "message received" and "container timeout."
- A worker claimed it had no custom instructions, but we couldn't verify what system prompt the SDK actually sent to the API without guessing.
- The `didGroupSendMessage` flag suppressed a response, but nothing logged that suppression happened.

## Current State

Six separate log sources, each with different formats and coverage:

| Layer | File | Format | What it captures | What's missing |
|-|-|-|-|-|
| Host process | `logs/nanoclaw.{log,jsonl}` | pino (pretty + JSONL) | Message receive, container spawn, IPC events, errors | No per-message trace ID. No record of message suppression or throbber events. |
| Worker audit | `logs/workers/<folder>/turns.jsonl` | JSONL | model, tokens, latency, energy per API call | No request/response content. Extracted after container exits, not real-time. |
| Worker events | `logs/worker-events.jsonl` | JSONL | created, destroyed, backend_switched | Missing `time` field on some entries. |
| Container stderr | `docker logs <name>` | plaintext | `[msg #N] type=X`, SDK init, errors, MessageStream counters | Gone when container is removed. Not indexed. |
| SDK session | `data/sessions/<folder>/.claude/.../session.jsonl` | JSONL | Full conversation: user msgs, tool calls, tool results, assistant text | No system prompt. No raw API request. No timing per message. |
| Shim/proxy | `logs/shim.{log,error.log}` | plaintext | Request method + path, audit per NW call | No request body. No system prompt. No Anthropic-backend calls. |

The SDK session JSONL comes closest to a full trace, but it's missing the system prompt, has no timestamps on individual messages, and doesn't record what the API provider actually received.

## Goals

1. **Trace any user message end-to-end** from Discord receipt to Discord response, across all layers.
2. **Answer "what was the agent doing?"** at any point in time, without guessing.
3. **Verify API payloads** when debugging instruction delivery or context issues.
4. **Low overhead by default**, detailed on demand. Don't log full API payloads unless asked.
5. **Queryable by agents**, so a debugging session can programmatically find what it needs.

## Proposal

### Trace IDs

Every user message gets a trace ID when it enters the host. The ID propagates through all layers:

- Host attaches it when storing the message
- Container input includes it
- Agent-runner logs it on every `[msg #N]` line
- Shim/proxy logs it on every API call
- Output callback includes it when the response is sent

Format: `t-<timestamp-ms>-<random>` (e.g., `t-1775852707-a3f`). Short enough to grep, unique enough to avoid collisions.

This is the single most valuable change. Everything else is secondary.

### Layered Logging (Summary + Detail)

Inspired by the gpuctl pattern: each API turn gets a one-line summary in an index file, plus a reference to a detail file with the full payload.

```
logs/workers/<folder>/
  turns.jsonl              # index: one line per API call (existing, extended)
  turns/                   # detail: full request+response per call
    t-1775852707-a3f.json  # referenced by trace ID
```

The index line (what `ncf logs` reads) gains a `trace_id` field and optionally a `detail` field pointing to the full payload file. The detail file is only written when verbose logging is enabled.

**Index entry (always written):**
```json
{"ts":"...","trace_id":"t-1775852707-a3f","model":"kimi-k2.5","input_tokens":1200,"output_tokens":85,"latency_ms":2400,"tools_called":["Bash","send_message"]}
```

**Detail file (written when `NANOCLAW_VERBOSE_LOGS=1`):**
```json
{
  "trace_id": "t-1775852707-a3f",
  "system_prompt": "...",
  "messages": [...],
  "response": {...},
  "timing": {"queue_ms": 12, "boot_ms": 0, "api_ms": 2400, "total_ms": 2412}
}
```

### Host Event Log

The host JSONL (`nanoclaw.jsonl`) gains trace IDs on all message-related events. A trace for a simple warm-container response would look like:

```
{"trace_id":"t-...","event":"msg_received","group":"discord_main","sender":"Bob"}
{"trace_id":"t-...","event":"msg_piped","group":"discord_main"}
{"trace_id":"t-...","event":"throbber_start","group":"discord_main","message_id":"..."}
{"trace_id":"t-...","event":"agent_output","group":"discord_main","suppressed":false}
{"trace_id":"t-...","event":"throbber_clear","group":"discord_main"}
{"trace_id":"t-...","event":"msg_sent","group":"discord_main","length":142}
```

For a cold boot, you'd also see `container_spawn`, `container_first_output`, and timing fields.

### Container Stderr Archival

Container stderr is currently lost when the container is replaced. The host already captures stderr in a buffer (`container-runner.ts` line 660). On container exit, write it to `logs/workers/<folder>/container-<timestamp>.log`. The host already does this for timeout cases; extend to all exits.

### Verbose API Logging

The shim and credential proxy gain an opt-in mode (`NANOCLAW_VERBOSE_LOGS=1` or per-worker config) that logs full request bodies to the detail files. This captures the system prompt, message array, and tool definitions that the provider actually received.

Without this flag, the shim logs only what it does today (method, path, token counts). The flag is off by default because API payloads contain conversation content.

### CLI Integration

`ncf` gains trace-aware commands:

```bash
ncf trace <trace-id>              # show full trace across all layers
ncf session main --live           # existing: real-time transcript
ncf session main --json           # existing: compact JSONL for agents
ncf logs main --verbose           # show detail files alongside index
```

`ncf trace` is the main new command. Given a trace ID, it assembles the full timeline: host events, container stderr entries, SDK session messages, audit entries, and (if verbose was on) the raw API payload. One command, full picture.

## What This Doesn't Cover

- **Metrics/alerting.** This is logging, not monitoring. Prometheus/Grafana are out of scope.
- **Log shipping.** Logs stay local. If we need remote aggregation later, the JSONL format makes it easy to ship to any sink.
- **Automatic anomaly detection.** A human or agent reads the logs. We're not building an alerting system.

## Implementation Order

1. **Trace IDs.** Add to host message handling, container input, agent-runner, shim. This unblocks everything else.
2. **Host event log enrichment.** Add trace IDs and missing events (suppression, throbber) to nanoclaw.jsonl.
3. **Container stderr archival.** Write stderr to file on all container exits, not just timeouts.
4. **Detail files.** Add `turns/` directory and verbose API payload logging behind the flag.
5. **`ncf trace` command.** Assembles the cross-layer view.
6. **Audit log enrichment.** Add `trace_id` and `tools_called` to turns.jsonl index entries.

Steps 1-3 are the high-value work. Steps 4-6 are nice-to-haves that build on the foundation.
