# Model Discovery

The translation shim exposes endpoints that let the master discover Neuralwatt models and resolve natural-language queries into real model ids. This is what makes "create a worker named foo using kimi fast" work without anyone memorising provider strings.

## Endpoints

### `GET /models`

Returns every model the Neuralwatt API has reported. Results are cached for five minutes.

```bash
curl -s http://localhost:3003/models
```

```json
{ "models": ["moonshotai/Kimi-K2.5", "moonshotai/Kimi-K2.5-fast", "Qwen/Qwen3-Coder", ...] }
```

### `GET /models/resolve/<query>`

Fuzzy-matches a query to a model id. The matching algorithm runs in three tiers:

1. **Exact match** on the full id (case-insensitive).
2. **Contains match** when exactly one model id contains the query as a substring.
3. **Fuzzy match.** The query is split on `-`, `_`, `/`, and `.`. Each candidate model id is scored by how many query parts it contains. The highest-scoring candidate wins.

The fuzzy split only handles those four delimiters, not spaces. Hyphens or slashes work best:

```bash
# Hyphenated query splits into ["kimi", "k2.5", "fast"]
curl -s http://localhost:3003/models/resolve/kimi-k2.5-fast
# → { "model": "moonshotai/Kimi-K2.5-fast", "match": "fuzzy", "candidates": [...] }

# Single substring match
curl -s http://localhost:3003/models/resolve/Kimi-K2.5
# → { "model": "moonshotai/Kimi-K2.5", "match": "contains" }

# Exact id
curl -s http://localhost:3003/models/resolve/Qwen/Qwen3-Coder
# → { "model": "Qwen/Qwen3-Coder", "match": "exact" }
```

Space-separated queries like `kimi fast` will not split because spaces aren't in the delimiter set. Known limitation. Use hyphens.

When nothing matches, the shim returns 404 with the full catalog:

```json
{ "error": "no match for \"nonexistent\"", "available": ["moonshotai/Kimi-K2.5", ...] }
```

## How the master uses it

When a user says "create a worker named foo using neuralwatt kimi-fast", the master:

1. Calls `GET /models/resolve/kimi-fast` to get a real model id.
2. Runs `ncf create foo --backend neuralwatt --model <resolved-model>`.
3. The host writes the resolved id into `data/worker-backends.json`.
4. The shim reads that file on every request, so the worker uses the right model from its first call.

The master never needs the full catalog. It delegates resolution to the shim, which stays current with whatever the Neuralwatt API reports.

## Runtime model switching

`ncf switch <worker> neuralwatt <model-or-query>` updates `data/worker-backends.json`. The master can pre-resolve via `/models/resolve` if it wants, or just pass the fuzzy name; either way the shim re-reads the file on the next request and the model takes effect immediately. No container restart for in-Neuralwatt switches.

Cross-backend switches (Anthropic ↔ Neuralwatt) are different. The container's `ANTHROPIC_BASE_URL` is set at spawn time and pins the worker to one proxy. `ncf switch` handles the restart for you when the backend actually changes.
