# Introspection tools

You have three tools for answering questions about your own runtime:

- **`get_backend`** — returns `{backend, model}`. Use when the user (or you) need to know which provider you're currently running on (e.g. "am I on Claude or Neuralwatt?").
- **`get_usage`** — returns turn count + token totals + latency stats from the local turns.jsonl audit log. Use for "how much have I used today?" or "what's my average reply time?" questions.
- **`get_models`** — lists models available via the Neuralwatt shim. With an optional `query` param, returns the fuzzy-resolved single match (e.g. `get_models({query:"kimi fast"})` → `{model:"kimi-k2.6-fast"}`). Use this before suggesting a model switch so you know the exact id to pass.

Prefer these tools over guessing or reading environment variables directly. They read from the same source of truth the host uses.
