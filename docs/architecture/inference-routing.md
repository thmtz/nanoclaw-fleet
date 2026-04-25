# Inference Routing

How API traffic flows from worker containers to inference backends.

## Topology

```
                                ┌──────────────────────┐
                                │   api.anthropic.com  │
                                └──────────┬───────────┘
                                           │
                                ┌──────────┴───────────┐
                                │  Credential Proxy    │
                                │  :3001 (OAuth/API)   │
                                └──────────┬───────────┘
                                           │
         ┌─────────────────────────────────┼─────────────────────────────────┐
         │                                 │                                 │
┌────────┴─────────┐  ┌───────────────────┴──────────┐  ┌────────────────────┴───────┐
│ Anthropic Worker │  │ Anthropic Worker             │  │ Neuralwatt Worker          │
│ ANTHROPIC_BASE_  │  │ ANTHROPIC_BASE_URL=          │  │ ANTHROPIC_BASE_URL=        │
│ URL=:3001        │  │ :3001                        │  │ :3003/w/discord_foo        │
│ (OAuth)          │  │ (API key)                    │  │ (placeholder key)          │
└──────────────────┘  └──────────────────────────────┘  └────────────┬───────────────┘
                                                                     │
                                                          ┌──────────┴───────────┐
                                                          │  Translation Shim    │
                                                          │  :3003               │
                                                          │  Anthropic ↔ OpenAI  │
                                                          │  reads config/req    │
                                                          └──────────┬───────────┘
                                                                     │
                                                          ┌──────────┴───────────┐
                                                          │  api.neuralwatt.com  │
                                                          │  (OpenAI format)     │
                                                          └──────────────────────┘
```

The Claude Agent SDK only knows how to speak Anthropic's Messages API. Anything else has to look like Anthropic from the SDK's side. Two outbound proxies make that work:

- **Credential proxy** (`src/credential-proxy.ts`, port 3001) holds the real OAuth token or API key on the host and injects it into outbound traffic. The container only ever sees a placeholder. Required for Anthropic workers, transparent for Neuralwatt.
- **Translation shim** (`tools/anthropic-shim.ts`, port 3003) translates Anthropic Messages requests into OpenAI `chat/completions` and translates the response back. It also tracks usage and energy.

## Request flow: Anthropic worker

```
1. Agent SDK → POST /v1/messages
   Authorization: Bearer <temp-api-key>
   { model: "claude-opus-4-6", messages: [...] }

2. Credential proxy (:3001)
   - First call uses /api/oauth/claude_cli/create_api_key with placeholder Bearer.
     Proxy swaps in the real OAuth token; Anthropic returns a temporary API key.
   - Subsequent calls send x-api-key directly; proxy passes through.

3. api.anthropic.com responds in Anthropic Messages format.
```

For API-key auth the flow is simpler: the proxy injects `x-api-key` on every request. The container side never sees the secret.

## Request flow: Neuralwatt worker

```
1. Agent SDK → POST /w/discord_foo/v1/messages
   x-api-key: placeholder
   { model: "claude-opus-4-6", messages: [...], tools: [...] }

2. Shim (:3003)
   - Extracts the folder from the URL: "discord_foo".
   - Reads data/worker-backends.json: { backend: "neuralwatt", model: "moonshotai/Kimi-K2.5" }.
   - Translates the request:
     * system blocks → system message
     * tool_use / tool_result blocks → OpenAI function-call format
     * model id → resolved Neuralwatt model
   - POSTs /v1/chat/completions to api.neuralwatt.com with the real API key.

3. Neuralwatt responds in OpenAI format.

4. Shim translates back:
   * function_call → tool_use content blocks
   * reasoning_content → thinking blocks
   * finish_reason → stop_reason
   * usage + energy_joules attached to the response stream
```

The shim caches `worker-backends.json` with an mtime check, so model edits take effect on the next request without a restart.

## Configuration

### Per-worker backend

Set at container creation in `worker.env`:

```
NANOCLAW_BACKEND=neuralwatt   # absent for anthropic
```

`src/container-runner.ts` reads this and points `ANTHROPIC_BASE_URL` at the right proxy. The backend is fixed for the container's lifetime; switching backends requires `ncf switch`, which restarts the container.

### Per-worker model (Neuralwatt)

Lives in `data/worker-backends.json`:

```json
{
  "discord_foo": { "backend": "neuralwatt", "model": "moonshotai/Kimi-K2.5" }
}
```

The shim reads this on every request (mtime-cached). Edits or `ncf switch <worker> neuralwatt <model>` take effect immediately.

### Defaults from `.env`

Four env vars seed `worker-backends.json` on the first spawn when no entry exists:

```
NANOCLAW_DEFAULT_WORKER_BACKEND=neuralwatt
NANOCLAW_DEFAULT_WORKER_MODEL=zai-org/GLM-5.1-FP8
NANOCLAW_DEFAULT_MASTER_BACKEND=neuralwatt
NANOCLAW_DEFAULT_MASTER_MODEL=zai-org/GLM-5.1-FP8
```

`src/backend-defaults.ts::resolveDefaultBackendConfig` re-reads `.env` on every call, so edits take effect without restarting NanoClaw.

To revert a worker (or the master) back to env defaults: delete its entry from `data/worker-backends.json`. The next spawn re-seeds from `.env`.

### Shim seeding (so shim and container agree)

The shim (separate process) defaults to Anthropic when a folder has no entry. If the container were spawned with env-derived `NANOCLAW_BACKEND=neuralwatt` but no entry was written, the shim would route that worker's traffic to the real Anthropic API with a placeholder key and the SDK would see `401 invalid x-api-key`.

To prevent this, `container-runner.ts` calls `seedBackendEntry(folder, defaults)` on every spawn when no entry exists. The shim and the container then agree on what backend to use.

## Provider API keys

Direct provider keys are passed into every container as env vars:

- `FIREWORKS_API_KEY`
- `TOGETHER_API_KEY`
- `SYNTHETIC_API_KEY`

These are injected from `.env` (read at spawn) and exposed for ad-hoc provider calls (eval scripts, model comparisons, one-off experiments). They are independent of the per-worker routing above. Use them when you explicitly want to call a provider, not when you want the worker's normal inference path.

## Key files

| File | Role |
|-|-|
| `src/credential-proxy.ts` | OAuth and API-key injection for Anthropic |
| `tools/anthropic-shim.ts` | Anthropic ↔ OpenAI translation, model resolution, usage tracking |
| `src/container-runner.ts` | Sets `ANTHROPIC_BASE_URL` per container, seeds backend entries |
| `src/backend-defaults.ts` | Resolves default backend/model from `.env` |
| `data/worker-backends.json` | Runtime backend/model state (shim reads per request) |

## Limitations

- Backend (Anthropic vs Neuralwatt) is fixed per container lifetime. Switching restarts the container.
- Streaming is supported, but tool-call streaming requires partial-JSON accumulation; complex tool schemas can hit edges.
- Open-source models vary in tool-calling quality; Kimi and GLM are the better-tested paths.
