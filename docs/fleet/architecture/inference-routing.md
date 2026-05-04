# Inference Routing

How fleet workers reach Claude or Neuralwatt without knowing the difference.

## The constraint

The Claude Agent SDK only speaks Anthropic's Messages API. Anything else has to look like Anthropic from the SDK's side. The fleet does this with two paths:

- **Claude path** — `ANTHROPIC_BASE_URL` defaults to `api.anthropic.com`. OneCLI's vault attaches the user's credential at request time. The container never holds a raw key.
- **Neuralwatt path** — `ANTHROPIC_BASE_URL` is set to `http://host.docker.internal:3003/w/<folder>`. The Neuralwatt translation shim (the v1 fleet's `tools/anthropic-shim.ts`, kept as-is and run alongside v2) translates each Anthropic Messages request into OpenAI `chat/completions`, attaches the real Neuralwatt key, and emits Anthropic-format SSE back.

```
Claude worker
  SDK ── Anthropic Messages ──→ ANTHROPIC_BASE_URL (api.anthropic.com)
                                  ↑
                            OneCLI vault attaches credential

Neuralwatt worker
  SDK ── Anthropic Messages ──→ ANTHROPIC_BASE_URL (host:3003/w/<folder>)
                                  ↓
                            Shim: read worker-backends.json → translate → POST to api.neuralwatt.com
                                  ↓
                            Anthropic-format SSE back to SDK
```

## Provider abstraction (v2 baseline)

v2 has an `AgentProvider` interface in `container/agent-runner/src/providers/`. Each provider registers itself in a central registry. The active provider is selected per agent group via `agent_groups.agent_provider` (default `claude`). The fleet adds:

- `container/agent-runner/src/providers/neuralwatt.ts` — registers `neuralwatt` as an alias for `ClaudeProvider`. The runtime is identical; only the host-injected env vars differ.
- `src/providers/{claude,neuralwatt}.ts` — host-side functions that compute env from each agent group's `container.json`. The container runner calls each registered provider's config function during `buildEnv()` and merges the result into the container spawn.

Two host-side providers, one container-side runtime, two actual network destinations.

## Per-backend persistent config

Each agent group's `container.json` carries a `providers` map so per-backend model and base_url persist across switches:

```json
{
  "provider": "neuralwatt",
  "providers": {
    "neuralwatt": {
      "model": "zai-org/GLM-5.1-FP8",
      "base_url": "http://host.docker.internal:3003"
    },
    "claude": {
      "model": "claude-opus-4-7"
    }
  }
}
```

Switching from Neuralwatt to Claude doesn't lose the Neuralwatt model — `provider` flips to `"claude"`, the next spawn uses `providers.claude.model`, and a future flip back to Neuralwatt picks up `providers.neuralwatt.model` without re-asking.

`setFleetBackend(folder, backend, model)` (`src/modules/fleet/lib.ts`) is the single writer for this map.

## Env injection

`registerProviderContainerConfig('claude', ctx => ...)` (in `src/providers/claude.ts`) reads `providers.claude.model` from the agent group's container config and emits:

```
ANTHROPIC_MODEL=<model>          # if set
```

`registerProviderContainerConfig('neuralwatt', ctx => ...)` (in `src/providers/neuralwatt.ts`) emits:

```
ANTHROPIC_BASE_URL=<base_url>/w/<folder>
ANTHROPIC_MODEL=<model>
```

`base_url` defaults to `http://host.docker.internal:3003` if not overridden in the providers map. The shim treats `/w/<folder>/` as the routing prefix — it reads the folder out of the path on every request and looks up the model in `worker-backends.json`. That gives runtime model switching without redeploying anything.

`src/container-runner.ts` calls each registered provider's config function in turn and merges the env into the spawn. Providers that don't apply emit nothing.

## Shim auto-sync (the 401 fix)

The Neuralwatt shim is a separate process from NanoClaw. It reads `data/worker-backends.json` for per-folder model resolution. Without a sync, a freshly-created Neuralwatt worker would have a `container.json::providers.neuralwatt.model` but no entry in the shim's file — the shim would default to Claude, forward to `api.anthropic.com` with a placeholder key, and the SDK would see `401 invalid x-api-key`.

`syncShimBackendConfig()` in `src/modules/fleet/lib.ts` is called from `setFleetBackend` whenever the active backend is Neuralwatt. It reads `NW_SHIM_CONFIG_PATH` from the environment, opens the shim's `worker-backends.json`, and writes/updates the entry for this folder. Best effort — if the file is missing or unwritable, the host logs a warning and continues. Workers run fine without Neuralwatt; the sync only matters when you flip a worker onto the shim.

## Pre-flight model validation

`switch_backend`, `create_worker`, and the resume path all run the requested model through `resolveModelForBackend(backend, model)` (`src/modules/fleet/model-resolver.ts`) before any DB or `container.json` write. For `neuralwatt` this is a `GET <NW_SHIM_HOST_URL>/models/resolve/<query>` against the shim — the shim already does the fuzzy matching and knows the live model catalogue. The canonical id from the shim (e.g. `zai-org/GLM-5.1-FP8` for input `GLM-5.1`) is what gets persisted.

If the shim returns 404 (no match) or 503 (catalogue empty) or the connect fails, the helper throws `ModelResolutionError` and the handler `notifyAgent`s the master with the resolver's message — nothing is persisted. This avoids the failure mode where a bad model id silently lands in `container.json` + `worker-backends.json` and surfaces only later as an SDK "model not available" error inside the worker container, far from where the bad input came in.

`claude` is pass-through. The SDK validates Claude model ids downstream and there's no shim hop where a bad value can poison routing for a container's whole lifetime.

`NW_SHIM_HOST_URL` defaults to `http://127.0.0.1:3003` (the host's view of the shim, distinct from the container's `host.docker.internal:3003`).

## Runtime model switching

Within Neuralwatt:

```
master: switch foo to qwen 3.5
  → setFleetBackend('discord_foo', 'neuralwatt', 'Qwen/Qwen3-Coder')
  → container.json updated, shim's worker-backends.json updated
  → next request reads new model from shim
```

No container restart. The shim's mtime cache picks up the change and the next inference call uses the new model.

Across backends (Claude ↔ Neuralwatt):

```
master: switch foo to claude
  → setFleetBackend updates container.json: provider="claude"
  → container is killed
  → next message respawns with ANTHROPIC_BASE_URL pointing at api.anthropic.com
```

Container restart required because `ANTHROPIC_BASE_URL` is set at spawn time.

## Defaults

The fleet doesn't read `NANOCLAW_DEFAULT_*` env vars on every spawn the way the v1 fork did. Instead, the model and backend persist in `container.json::providers.*`. Defaults are seeded the first time a worker is created without explicit `--backend`/`--model` flags:

- `agent_provider` defaults to `claude` (the v2 baseline default).
- The model defaults to whatever the SDK uses if no `ANTHROPIC_MODEL` is set.

To change the master's or future workers' defaults, write the values into the relevant `container.json::providers.<backend>` block once. Or pass `--backend` and `--model` at create time.

## Streaming

The shim handles streaming SSE in both directions: it asks Neuralwatt for `stream: true`, parses the OpenAI-format event stream, and emits Anthropic-format `message_start`, `content_block_delta` (text and thinking), `tool_use`, and `message_stop` events. The energy comment line (`: energy {...}`, an SSE comment that standard parsers throw away) is captured before `[DONE]` and recorded into `data/worker-usage.json`.

The streaming logic lives in the v1 shim (`tools/anthropic-shim.ts`) and is reused as-is. v2 doesn't reimplement it.

## Files

| File                                                 | Role                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/modules/fleet/lib.ts`                           | `setFleetBackend`, `syncShimBackendConfig`                                  |
| `src/modules/fleet/model-resolver.ts`                | `resolveModelForBackend` (pre-flight model validation against the shim)     |
| `src/providers/claude.ts`                            | Host-side provider config: emits `ANTHROPIC_MODEL` from container.json      |
| `src/providers/neuralwatt.ts`                        | Host-side provider config: emits `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` |
| `src/providers/provider-container-registry.ts`       | Registration plumbing                                                       |
| `container/agent-runner/src/providers/claude.ts`     | Container-side default provider                                             |
| `container/agent-runner/src/providers/neuralwatt.ts` | Container-side alias to ClaudeProvider                                      |
| `tools/anthropic-shim.ts`                            | The shim itself (v1 fleet, reused)                                          |
| `data/worker-backends.json`                          | Shim's per-folder backend/model state                                       |
| `groups/<folder>/container.json`                     | Per-agent-group provider config                                             |

## Limitations

- Backend (Claude vs Neuralwatt) is fixed for a container's lifetime; `switch_backend` restarts the container when the active backend actually changes.
- Tool-call streaming relies on partial-JSON accumulation; complex tool schemas can hit edges. Kimi and GLM are the better-tested paths.
- The shim is a separate process. If it isn't running and a Neuralwatt worker takes a turn, the SDK gets a connect-refused. `ncf debug` reports shim health.
