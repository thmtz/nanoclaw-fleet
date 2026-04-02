# Model Discovery

The translation shim exposes endpoints that let the master agent discover available Neuralwatt models and resolve natural language queries to model IDs.

## Endpoints

### GET /models

Returns all models available on the Neuralwatt API. Results are cached for 5 minutes.

```bash
curl -s http://localhost:3003/models
```

```json
{ "models": ["moonshotai/Kimi-K2.5", "moonshotai/Kimi-K2.5-fast", "Qwen/Qwen3-Coder", ...] }
```

### GET /models/resolve/\<query\>

Fuzzy-matches a query to a model ID. The matching algorithm:

1. **Exact match** on the full model ID (case-insensitive)
2. **Contains match** if exactly one model ID contains the query string
3. **Fuzzy match** splits the query on delimiters (`-`, `_`, `/`, `.`), scores each model by how many query parts appear in its ID, returns the highest-scoring match

The fuzzy split only handles those four delimiters, not spaces. Use hyphens or slashes in queries for best results:

```bash
# Hyphenated query splits into ["kimi", "k2.5", "fast"]
curl -s http://localhost:3003/models/resolve/kimi-k2.5-fast
# → { "model": "moonshotai/Kimi-K2.5-fast", "match": "fuzzy", "candidates": [...] }

# Substring match (single match = "contains")
curl -s http://localhost:3003/models/resolve/Kimi-K2.5
# → { "model": "moonshotai/Kimi-K2.5", "match": "contains" }

# Slash-separated works too
curl -s http://localhost:3003/models/resolve/Qwen/Qwen3-Coder
# → { "model": "Qwen/Qwen3-Coder", "match": "exact" }
```

**Note:** Space-separated queries like "kimi fast" don't split correctly (spaces aren't in the delimiter set). This is a known limitation. Use hyphens instead: "kimi-fast".

On no match, returns 404 with the full list of available models:
```json
{ "error": "no match for \"nonexistent\"", "available": ["moonshotai/Kimi-K2.5", ...] }
```

## How the Master Uses It

When a user says "create agent foo using neuralwatt kimi-fast," the master agent:

1. Calls `/models/resolve/kimi-fast` to get the model ID
2. Passes the resolved model to the `create_worker` MCP tool
3. The host writes the model to `data/worker-backends.json`
4. The shim reads this config on each request and routes to the correct model

The master doesn't need to know the full model catalog. It delegates resolution to the shim, which stays current with Neuralwatt's API.

## Runtime Model Switching

The `switch_backend` MCP tool (master-only) can change a Neuralwatt worker's model without destroying it. The master resolves the new model name via `/models/resolve`, then updates `data/worker-backends.json`. The shim re-reads this file on each request, so the change takes effect immediately.

Switching between Anthropic and Neuralwatt backends requires destroying and recreating the worker, since the backend determines which proxy the container talks to (port 3001 vs 3003), and that's set at container startup.
