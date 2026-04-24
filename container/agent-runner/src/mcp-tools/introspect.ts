/**
 * Introspection MCP tools — let a worker answer "what model am I running?"
 * and "how much have I used?" without shelling out or inspecting container
 * internals. Ported from v1 nanoclaw-fleet's get_backend / get_usage tools.
 *
 * get_backend   → {backend, model, provider}
 * get_usage     → parses turns.jsonl for this worker and returns totals
 * get_models    → proxies the NW shim's /models endpoint for model discovery
 */
import fs from 'fs';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const TURNS_FILE = '/workspace/turns.jsonl';

const getBackend: McpToolDefinition = {
  tool: {
    name: 'get_backend',
    description:
      'Report which inference backend + model this worker is running on. ' +
      'Useful when the agent needs to introspect its own configuration (e.g. "am I on Claude or Neuralwatt?").',
    inputSchema: { type: 'object', properties: {} },
  },
  handler: async () => {
    const backend = process.env.NANOCLAW_PROVIDER ?? 'unknown';
    const model = process.env.ANTHROPIC_MODEL ?? '(default)';
    return ok(JSON.stringify({ backend, model }));
  },
};

const getUsage: McpToolDefinition = {
  tool: {
    name: 'get_usage',
    description:
      'Report this worker\'s cumulative token usage + turn latency, read from the local turns.jsonl audit log. ' +
      'Fields: turns, input_tokens, output_tokens, cached_tokens, total_ms, max_ms.',
    inputSchema: { type: 'object', properties: {} },
  },
  handler: async () => {
    if (!fs.existsSync(TURNS_FILE)) return ok(JSON.stringify({ turns: 0, note: 'no turns yet' }));
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let totalMs = 0;
    let maxMs = 0;
    try {
      const lines = fs.readFileSync(TURNS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
      for (const ln of lines) {
        try {
          const e = JSON.parse(ln);
          turns++;
          inputTokens += e.input_tokens ?? 0;
          outputTokens += e.output_tokens ?? 0;
          cachedTokens += e.cached_tokens ?? 0;
          const ms = e.total_ms ?? 0;
          totalMs += ms;
          if (ms > maxMs) maxMs = ms;
        } catch {
          // Skip malformed lines — one corrupt row shouldn't break the totals.
        }
      }
    } catch (e) {
      return err(`read turns.jsonl failed: ${String(e)}`);
    }
    return ok(
      JSON.stringify({
        turns,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        total_ms: totalMs,
        max_ms: maxMs,
        avg_ms: turns > 0 ? Math.round(totalMs / turns) : 0,
      }),
    );
  },
};

const getModels: McpToolDefinition = {
  tool: {
    name: 'get_models',
    description:
      'List models the Neuralwatt shim makes available (for fuzzy matching + discovery). ' +
      'Returns the raw {models: []} response from the shim; empty when the shim is unreachable. ' +
      'Optional `query` parameter returns the fuzzy-resolved single match instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional natural-language model name. When set, returns {model, match} from /models/resolve/<q>.',
        },
      },
    },
  },
  handler: async (input) => {
    const base = (process.env.ANTHROPIC_BASE_URL ?? 'http://host.docker.internal:3003').replace(/\/w\/[^/]+$/, '');
    const query = (input as { query?: string }).query;
    const url = query ? `${base}/models/resolve/${encodeURIComponent(query)}` : `${base}/models`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const f = (globalThis as any).fetch;
      if (typeof f !== 'function') return err('fetch not available in this runtime');
      const resp = await f(url);
      const body = await resp.text();
      if (!resp.ok) return err(`shim ${resp.status}: ${body.slice(0, 200)}`);
      return ok(body);
    } catch (e) {
      return err(`shim unreachable: ${String(e)}`);
    }
  },
};

registerTools([getBackend, getUsage, getModels]);
