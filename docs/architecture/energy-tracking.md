# Usage & Energy Tracking

Status: **Implemented** | Created: 2026-03-27

## Goal

Track usage metrics for Neuralwatt-backed workers at two levels:
- **(a) All of NanoClaw** — totals across all Neuralwatt workers
- **(b) Per worker** — metrics for each individual worker session

Metrics to track per worker: request count, input tokens, output tokens, total tokens, energy (joules, kWh), average power (watts), total inference duration.

Anthropic workers don't return energy data. Token tracking for Anthropic workers could be added later but is out of scope here.

## What Data Is Available

### Per-response data

Every Neuralwatt API response includes an `energy` object:

```json
{
  "energy_joules": 25.15,
  "energy_kwh": 0.000007,
  "avg_power_watts": 1278.6,
  "duration_seconds": 1.967,
  "attribution_method": "prorated",
  "attribution_ratio": 0.25
}
```

For **non-streaming** responses, this is a top-level field in the JSON body.

For **streaming** (SSE) responses, energy arrives as an SSE comment near the end of the stream:
```
data: {"choices": [], "usage": {"prompt_tokens": 12, "total_tokens": 62, ...}}
: energy {"energy_joules": 13.02, "energy_kwh": 3.618e-06, ...}
data: [DONE]
```

The `: ` prefix makes it an SSE comment, which standard parsers ignore. Custom parsing is needed to extract energy data from SSE streams.

### Account-level usage (API endpoint)

`GET /v1/usage/energy` returns daily totals:
```json
{
  "daily": [
    { "date": "2026-03-27", "requests": 1568, "energy_kwh": 0.327, "energy_joules": 1176257 }
  ],
  "totals": { "requests": 9452, "energy_kwh": 3.198, "energy_joules": 11512681 }
}
```

This is account-wide (not NanoClaw-specific, no per-model or per-request-ID breakdown). Useful for total energy reporting but not for per-worker attribution.

## Design

The shim (`tools/anthropic-shim.ts`) already sees every Neuralwatt response and knows which worker made the request, making it the natural place to accumulate metrics.

After each response, the shim extracts both `usage` (tokens) and `energy` fields and adds them to running per-worker totals. Totals are flushed to `data/worker-usage.json` after every response (the file is small and request rates are low).

For non-streaming responses, energy is in the parsed JSON body. For streaming (future), the energy comment needs to be captured before `[DONE]` using line-by-line SSE parsing.

On startup, the shim loads existing totals from `data/worker-usage.json` and continues accumulating. Usage data persists across both shim and container restarts. Destroying a worker does not clear its usage history.

### Endpoints

The shim exposes `GET /usage` (all workers), `GET /usage/<worker-folder>` (single worker), and `GET /usage/total` (sum). Workers and master can query via `curl http://host.docker.internal:3003/usage`.

```json
{
  "discord_test": {
    "requests": 42,
    "input_tokens": 15200,
    "output_tokens": 8400,
    "total_tokens": 23600,
    "energy_joules": 1050,
    "energy_kwh": 0.000292,
    "last_updated": "..."
  },
  "total": { "requests": 42, "input_tokens": 15200, "output_tokens": 8400, "total_tokens": 23600, "energy_joules": 1050, "energy_kwh": 0.000292 }
}
```

### Agent-facing access

Workers should be able to ask "how much energy have I used?" without manual curl commands. Two approaches:

**MCP tool (preferred):** Add a `get_usage` tool to `ipc-mcp-stdio.ts`. The tool queries the shim's `/usage/<folder>` endpoint from inside the container and returns a formatted response. Workers and master can call it naturally: "check my usage."

**Fallback:** Workers can `curl http://host.docker.internal:3003/usage/<their-folder>` directly via Bash.

The master gets the full picture (`/usage` for all workers) and can compare across workers. Workers only see their own stats.

Example interactions:
- Worker: "How much energy have I used?" → "42 requests, 23.6k tokens, 1.05 kJ (0.29 Wh)"
- Master: "Which worker used the most resources?" → shows all workers sorted by tokens or energy

### Shim tracking vs account-level API

The shim's per-worker data and Neuralwatt's `/v1/usage/energy` endpoint measure different things. The shim gives per-worker attribution within NanoClaw. The API gives account-wide totals (including non-NanoClaw usage) and is the billing source of truth.

## Implementation steps

1. Extract `usage` + `energy` from Neuralwatt responses in the shim (non-streaming)
2. Accumulate per-worker totals in memory
3. Add `/usage` endpoints
4. Flush to `data/worker-usage.json` after each response
5. Load persisted data on shim startup
6. (Later) Streaming energy parsing when SSE support is added

## Open questions

- Should we track energy for Anthropic workers too? Anthropic doesn't return energy data, but we could track request counts and token usage for cost estimation.
- Retention policy: keep energy data forever, or roll up daily and expire after N days?
- Should workers see their own energy usage in their CLAUDE.md or system prompt? ("You've used 0.05 kWh so far in this session.")
