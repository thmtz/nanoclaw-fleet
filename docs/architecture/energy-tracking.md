# Energy and Usage Tracking

The translation shim attributes energy and token usage to individual workers, so the master can answer "how much have I used?" and "which worker is the heaviest?".

Anthropic does not return energy data. Token tracking for Anthropic workers comes from the SDK's transcript (see `src/audit-log.ts`); energy data only exists for Neuralwatt workers.

## Where the data comes from

Every Neuralwatt response includes an energy object:

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

For non-streaming responses, this is a top-level field in the JSON body. For streaming responses, energy arrives as an SSE comment near the end of the stream:

```
data: {"choices": [], "usage": {"prompt_tokens": 12, "total_tokens": 62, ...}}
: energy {"energy_joules": 13.02, "energy_kwh": 3.618e-06, ...}
data: [DONE]
```

The `: ` prefix makes it an SSE comment. Standard parsers throw it away, so the shim reads raw lines to capture it. See [streaming-shim.md](streaming-shim.md).

## How the shim accumulates it

The shim already sits in front of every Neuralwatt request, so it knows the worker folder and the response in one place. After each response it pulls `usage` and `energy` out, adds them to that worker's running totals, and writes `data/worker-usage.json`. Writes are synchronous; the file is small and request rates are low.

```json
{
  "discord_foo": {
    "requests": 42,
    "input_tokens": 15200,
    "output_tokens": 8400,
    "total_tokens": 23600,
    "cached_input_tokens": 7100,
    "energy_joules": 1050,
    "energy_kwh": 0.000292,
    "last_updated": "2026-04-24T..."
  }
}
```

Totals persist across shim and container restarts. `ncf destroy` does not clear them; rerunning `ncf create` with the same folder keeps the running history.

## How agents see it

The shim exposes three endpoints on port 3003:

- `GET /usage` — every worker
- `GET /usage/<folder>` — single worker
- `GET /usage/total` — summed totals

Inside any container, `curl http://host.docker.internal:3003/usage/<folder>` works directly. The agent-runner also registers a `get_usage` MCP tool so workers can ask without shelling out:

> Worker: "how much energy have I used?"
> Tool result: "42 requests, 23.6k tokens, 1.05 kJ (0.29 Wh)"

The master gets the global picture; workers see their own slice.

## Where it shows up

`ncf status` reads usage and prints requests, tokens, and Wh per worker. The Discord master and per-worker status pins surface the same data so you don't have to ask. When the master destroys a Neuralwatt worker, it reports lifetime usage before cleanup.

## Per-turn audit

For a finer-grained view, every inference request lands in `logs/workers/<folder>/turns.jsonl`:

```json
{"ts":"2026-04-24T...", "model":"moonshotai/Kimi-K2.5", "backend":"neuralwatt", "input_tokens":1500, "output_tokens":420, "cached_input_tokens":700, "latency_ms":3120, "stop_reason":"end_turn", "energy_joules":18.4}
```

Query with `ncf logs <worker>` (last N turns), `--cache` (cache-hit only), `--slow` (>5s only), or `--json` for raw output.

## Shim usage vs account-level API

The shim measures what NanoClaw containers actually consume. Neuralwatt's `/v1/usage/energy` endpoint reports account-wide totals (including any non-NanoClaw use) and is the billing source of truth. The two will differ slightly because of clock skew and any non-fleet API calls.

## Files

| File | Role |
|-|-|
| `tools/anthropic-shim.ts` | Captures `usage` and `energy` from every Neuralwatt response, accumulates totals |
| `data/worker-usage.json` | Per-worker running totals (read by `ncf status` and the status pins) |
| `logs/workers/<folder>/turns.jsonl` | Per-turn audit (model, tokens, latency, energy, stop reason) |
| `src/audit-log.ts` | Extracts turns from SDK transcripts for Anthropic workers |
| `src/status-pin.ts`, `src/worker-status-pin.ts` | Renders usage in pinned Discord status messages |
