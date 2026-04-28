/**
 * Universal inference proxy for NanoClaw.
 *
 * All worker containers route API traffic through this proxy. It reads a
 * per-worker config file to decide whether to forward to Anthropic (via
 * the credential proxy) or to Neuralwatt (with Anthropic→OpenAI translation).
 *
 * Config: data/worker-backends.json (re-read on every request for live toggling)
 * {
 *   "discord_foobar": { "backend": "neuralwatt", "model": "Qwen/Qwen3.5-397B-A17B-FP8" },
 *   "discord_other": { "backend": "anthropic" }
 * }
 *
 * Workers identify themselves via the X-Worker-Folder header (set by container-runner).
 * Default: forward to Anthropic credential proxy.
 *
 * Usage:
 *   NEURALWATT_API_KEY=... CREDENTIAL_PROXY_URL=http://localhost:3001 bun run tools/anthropic-shim.ts
 */

import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.SHIM_PORT || '3003');
const TRACES_DIR = process.env.SHIM_TRACES_DIR || 'logs/shim-traces';
const TRACES_DISABLED = process.env.SHIM_TRACES === '0';
fs.mkdirSync(TRACES_DIR, { recursive: true });
const NEURALWATT_BASE = (process.env.NEURALWATT_BASE_URL || 'https://api.neuralwatt.com/v1').replace(/\/$/, '');
const NEURALWATT_URL = `${NEURALWATT_BASE}/chat/completions`;
const NEURALWATT_API_KEY = process.env.NEURALWATT_API_KEY || '';
const WORKER_API_KEY_PREFIX = 'sk-ant-worker-';
const BACKEND_NEURALWATT = 'neuralwatt';
const DEBUG = process.env.SHIM_DEBUG === '1';
// Streaming enabled by default. Set SHIM_STREAMING=0 to disable (falls back to
// buffered non-streaming). Previously disabled due to suspected raw tool call
// token bug, which turned out to be stale containers with invalid API keys.
const STREAMING_ENABLED = process.env.SHIM_STREAMING !== '0';
// Credential proxy binds to docker0 bridge on Linux (172.17.0.1),
// localhost on macOS/WSL. Auto-detect or use env override.
function detectCredentialProxyUrl(): string {
  if (process.env.CREDENTIAL_PROXY_URL) return process.env.CREDENTIAL_PROXY_URL;
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a: any) => a.family === 'IPv4');
    if (ipv4) return `http://${ipv4.address}:3001`;
  }
  return 'http://127.0.0.1:3001';
}
const CREDENTIAL_PROXY_URL = detectCredentialProxyUrl();
const CONFIG_PATH = process.env.BACKEND_CONFIG_PATH || 'data/worker-backends.json';

// ── Config ─────────────────────────────────────────────────────

interface WorkerBackendConfig {
  backend: 'anthropic' | 'neuralwatt';
  model?: string;
}

// ── Usage tracking ─────────────────────────────────────────────

interface WorkerUsage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  energy_joules: number;
  energy_kwh: number;
  last_updated: string;
}

const USAGE_PATH = process.env.USAGE_PATH || 'data/worker-usage.json';

let workerUsage: Record<string, WorkerUsage> = {};

function loadUsage(): void {
  try {
    if (fs.existsSync(USAGE_PATH)) {
      workerUsage = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8'));
    }
  } catch {
    /* start fresh if corrupt */
  }
}

function saveUsage(): void {
  fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
  const tmp = `${USAGE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(workerUsage, null, 2));
  fs.renameSync(tmp, USAGE_PATH);
}

function recordUsage(
  workerFolder: string,
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
  energy: { energy_joules?: number; energy_kwh?: number } | undefined,
): void {
  if (!workerFolder) return;
  const w = workerUsage[workerFolder] || {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    energy_joules: 0,
    energy_kwh: 0,
    last_updated: '',
  };
  w.requests++;
  w.input_tokens += usage?.prompt_tokens || 0;
  w.output_tokens += usage?.completion_tokens || 0;
  w.total_tokens += usage?.total_tokens || 0;
  w.energy_joules += energy?.energy_joules || 0;
  w.energy_kwh += energy?.energy_kwh || 0;
  w.last_updated = new Date().toISOString();
  workerUsage[workerFolder] = w;
  saveUsage();
}

// Deduplicate SDK retries: track last request per worker to detect duplicates.
// The SDK sends each request twice with different max_tokens.
const lastRequest = new Map<string, { msgCount: number; timestamp: number }>();

function isDuplicateRequest(workerFolder: string, msgCount: number): boolean {
  const now = Date.now();
  const last = lastRequest.get(workerFolder);
  if (last && last.msgCount === msgCount && now - last.timestamp < 5000) {
    return true;
  }
  lastRequest.set(workerFolder, { msgCount, timestamp: now });
  return false;
}

function getUsageTotal(): Omit<WorkerUsage, 'last_updated'> {
  const total = {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    energy_joules: 0,
    energy_kwh: 0,
  };
  for (const w of Object.values(workerUsage)) {
    total.requests += w.requests;
    total.input_tokens += w.input_tokens;
    total.output_tokens += w.output_tokens;
    total.total_tokens += w.total_tokens;
    total.energy_joules += w.energy_joules;
    total.energy_kwh += w.energy_kwh;
  }
  return total;
}

// Load persisted usage on startup
loadUsage();

let modelsCache: string[] | null = null;
let modelsCacheTime = 0;

async function refreshModelsCache(): Promise<void> {
  const now = Date.now();
  if (modelsCache && now - modelsCacheTime < 5 * 60 * 1000) return;
  try {
    const resp = await fetch(`${NEURALWATT_BASE}/models`, {
      headers: { Authorization: `Bearer ${NEURALWATT_API_KEY}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      modelsCache = (data as any).data?.map((m: any) => m.id) || [];
      modelsCacheTime = now;
    }
  } catch {
    /* ignore */
  }
}

let cachedConfig: Record<string, WorkerBackendConfig> = {};
let configMtime = 0;

function loadConfig(): Record<string, WorkerBackendConfig> {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return cachedConfig;
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs === configMtime) return cachedConfig;
    cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    configMtime = stat.mtimeMs;
  } catch (err) {
    console.error(`[proxy] Failed to read config: ${err}`);
  }
  return cachedConfig;
}

function getWorkerConfig(workerFolder: string): WorkerBackendConfig {
  const config = loadConfig();
  return config[workerFolder] || { backend: 'anthropic' };
}

// ── Model mapping (Neuralwatt) ─────────────────────────────────

const NEURALWATT_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-6': 'Qwen/Qwen3.5-397B-A17B-FP8',
  'claude-sonnet-4-6': 'Qwen/Qwen3.5-397B-A17B-FP8',
  'claude-sonnet-4-5-20250929': 'Qwen/Qwen3.5-397B-A17B-FP8',
  'claude-sonnet-4-20250514': 'Qwen/Qwen3.5-397B-A17B-FP8',
  'claude-haiku-4-5-20251001': 'Qwen/Qwen3.5-35B-A3B',
};
const DEFAULT_NEURALWATT_MODEL = 'Qwen/Qwen3.5-397B-A17B-FP8';

function resolveNeuralwattModel(anthropicModel: string, configModel?: string): string {
  if (configModel) return configModel;
  return NEURALWATT_MODEL_MAP[anthropicModel] || DEFAULT_NEURALWATT_MODEL;
}

// ── Anthropic → OpenAI translation ─────────────────────────────

function anthropicToOpenAI(body: any, model: string) {
  const messages: any[] = [];

  if (body.system) {
    const systemText = typeof body.system === 'string' ? body.system : body.system.map((b: any) => b.text).join('\n');
    messages.push({ role: 'system', content: systemText });
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts = msg.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
      const toolCalls = msg.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const m: any = { role: 'assistant', content: textParts || null };
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      messages.push(m);
    } else if (msg.role === 'user') {
      const toolResults = msg.content.filter((b: any) => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const resultContent =
            typeof tr.content === 'string'
              ? tr.content
              : Array.isArray(tr.content)
                ? tr.content.map((c: any) => c.text || '').join('')
                : '';
          messages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: resultContent,
          });
        }
        const textParts = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
        if (textParts) messages.push({ role: 'user', content: textParts });
      } else {
        const text = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        messages.push({ role: 'user', content: text });
      }
    }
  }

  const tools = body.tools?.map((t: any) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema,
    },
  }));

  const result: any = {
    model,
    max_tokens: body.max_tokens,
    messages,
    stream: false,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
  };

  if (tools?.length) result.tools = tools;
  return result;
}

function openAIToAnthropic(resp: any, requestedModel: string) {
  const choice = resp.choices?.[0];
  const message = choice?.message;
  const contentBlocks: any[] = [];

  const reasoning = message?.reasoning_content || message?.provider_specific_fields?.reasoning_content;
  if (reasoning) {
    contentBlocks.push({ type: 'thinking', thinking: reasoning });
  }

  if (message?.tool_calls?.length) {
    if (message.content) contentBlocks.push({ type: 'text', text: message.content });
    for (const tc of message.tool_calls) {
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id || `toolu_${Date.now()}`,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  } else {
    contentBlocks.push({
      type: 'text',
      text: message?.content || '(no response)',
    });
  }

  const stopReason = message?.tool_calls?.length
    ? 'tool_use'
    : choice?.finish_reason === 'stop'
      ? 'end_turn'
      : choice?.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';

  return {
    id: `msg_${resp.id || Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
  };
}

// ── Anthropic pass-through (to credential proxy) ───────────────

async function forwardToAnthropic(request: Request, body: Buffer, rewrittenUrl?: URL): Promise<Response> {
  const url = rewrittenUrl || new URL(request.url);
  const targetUrl = `${CREDENTIAL_PROXY_URL}${url.pathname}${url.search}`;

  // Transparent pass-through: don't modify auth headers.
  // The SDK handles its own OAuth exchange, credential proxy injects real tokens.
  const headers = new Headers(request.headers);
  headers.delete('host');

  const resp = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
  });

  return new Response(resp.body, {
    status: resp.status,
    headers: resp.headers,
  });
}

// Anthropic pass-through with trace. Tees the response body — one branch
// streams to the client unchanged, the other accumulates into a buffer
// asynchronously for the trace log. Critical: do NOT buffer the whole
// response before returning, or SDK streaming UX (throbber + partial
// rendering) breaks on every claude-direct call.
async function traceAnthropic(
  request: Request,
  bodyBuffer: Buffer,
  url: URL,
  workerFolder: string,
  startMs: number,
): Promise<Response> {
  const reqJson = safeJson(bodyBuffer);
  const isStream = reqJson?.stream === true;
  const targetUrl = `${CREDENTIAL_PROXY_URL}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');

  let resp: Response;
  try {
    resp = await fetch(targetUrl, { method: request.method, headers, body: bodyBuffer });
  } catch (err: any) {
    appendTrace({
      ts: new Date().toISOString(),
      worker: workerFolder,
      backend: 'anthropic',
      model_in: reqJson?.model,
      method: request.method,
      path: url.pathname,
      status: 0,
      stream: isStream,
      latency_ms: Date.now() - startMs,
      req_size: bodyBuffer.length,
      resp_size: 0,
      req_body: reqJson,
      resp_body: null,
      error: err.message,
    });
    throw err;
  }

  // No body (HEAD, 204, etc.) — log and return as-is.
  if (!resp.body) {
    appendTrace({
      ts: new Date().toISOString(),
      worker: workerFolder,
      backend: 'anthropic',
      model_in: reqJson?.model,
      model_out: reqJson?.model,
      method: request.method,
      path: url.pathname,
      status: resp.status,
      stream: isStream,
      latency_ms: Date.now() - startMs,
      req_size: bodyBuffer.length,
      resp_size: 0,
      req_body: reqJson,
      resp_body: null,
      error: resp.ok ? null : `upstream ${resp.status}`,
    });
    return new Response(null, { status: resp.status, headers: resp.headers });
  }

  const [forClient, forTrace] = resp.body.tee();

  // Drain the trace branch off the hot path — fire-and-forget. Errors here
  // must never block the client response or the request from completing.
  void (async () => {
    try {
      const reader = forTrace.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const respBuf = Buffer.concat(chunks);
      let parsedResp: any = null;
      let stopReason: string | null = null;
      let inTok: number | null = null;
      let outTok: number | null = null;
      if (isStream) {
        parsedResp = assembleAnthropicSse(respBuf.toString('utf-8'));
        stopReason = parsedResp.stop_reason;
        inTok = parsedResp.usage?.input_tokens ?? null;
        outTok = parsedResp.usage?.output_tokens ?? null;
      } else {
        parsedResp = safeJson(respBuf);
        stopReason = parsedResp?.stop_reason ?? null;
        inTok = parsedResp?.usage?.input_tokens ?? null;
        outTok = parsedResp?.usage?.output_tokens ?? null;
      }
      appendTrace({
        ts: new Date().toISOString(),
        worker: workerFolder,
        backend: 'anthropic',
        model_in: reqJson?.model,
        model_out: reqJson?.model,
        method: request.method,
        path: url.pathname,
        status: resp.status,
        stream: isStream,
        latency_ms: Date.now() - startMs,
        req_size: bodyBuffer.length,
        resp_size: respBuf.length,
        stop_reason: stopReason,
        input_tokens: inTok,
        output_tokens: outTok,
        req_body: reqJson,
        resp_body: parsedResp,
        error: resp.ok ? null : `upstream ${resp.status}`,
      });
    } catch (err: any) {
      console.error(`[proxy:trace] anthropic tee drain failed: ${err.message}`);
    }
  })();

  return new Response(forClient, { status: resp.status, headers: resp.headers });
}

// ── Trace logging ──────────────────────────────────────────────
//
// One JSONL file per worker at logs/shim-traces/<folder>.jsonl. Each line
// is a single /v1/messages POST: full request body, full assembled response,
// status, latency, tokens. Used by `ncf trace <worker>` for "why is this
// worker stuck?" debugging — turns.jsonl shows IF something hung, this
// shows WHAT the agent sent and WHAT came back.
//
// No size cap at write time. If files grow large, delete them — they're
// purely diagnostic. Disable entirely with SHIM_TRACES=0.

interface ShimTraceEntry {
  ts: string;
  worker: string;
  backend: 'anthropic' | 'neuralwatt';
  model_in?: string;
  model_out?: string;
  method: string;
  path: string;
  status: number;
  stream: boolean;
  latency_ms: number;
  req_size: number;
  resp_size: number;
  stop_reason?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  req_body?: unknown;
  resp_body?: unknown;
  error?: string | null;
}

function appendTrace(entry: ShimTraceEntry): void {
  if (TRACES_DISABLED) return;
  if (!entry.worker) return;
  const file = path.join(TRACES_DIR, `${entry.worker}.jsonl`);
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (err: any) {
    console.error(`[proxy:trace] write failed: ${err.message}`);
  }
}

function safeJson(buf: Buffer): any {
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    return null;
  }
}

// Best-effort assembly of an Anthropic SSE response body into a single
// final-shape message. Reads the streamed event/data lines, accumulates
// content_block_delta text/thinking/input_json into matching blocks,
// pulls stop_reason and usage from message_delta. If parsing fails on any
// chunk, that chunk is skipped — the trace still gets whatever we could
// reconstruct, plus the raw SSE text in `_raw` for forensic use.
function assembleAnthropicSse(raw: string): any {
  const blocks: any[] = [];
  let stopReason: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    let evt: any;
    try {
      evt = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (evt.type === 'content_block_start') {
      blocks[evt.index] = { ...evt.content_block };
      if (evt.content_block?.type === 'tool_use') blocks[evt.index].input = '';
    } else if (evt.type === 'content_block_delta') {
      const b = blocks[evt.index];
      if (!b) continue;
      const d = evt.delta;
      if (d?.type === 'text_delta') b.text = (b.text ?? '') + (d.text ?? '');
      else if (d?.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + (d.thinking ?? '');
      else if (d?.type === 'input_json_delta') b.input = (b.input ?? '') + (d.partial_json ?? '');
    } else if (evt.type === 'message_delta') {
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      if (evt.usage?.output_tokens != null) outputTokens = evt.usage.output_tokens;
    } else if (evt.type === 'message_start') {
      if (evt.message?.usage?.input_tokens != null) inputTokens = evt.message.usage.input_tokens;
    }
  }
  // Tool-use input arrived as JSON-string fragments; parse the final accumulated string.
  for (const b of blocks) {
    if (b?.type === 'tool_use' && typeof b.input === 'string') {
      try {
        b.input = JSON.parse(b.input || '{}');
      } catch {
        /* leave as-is */
      }
    }
  }
  return {
    type: 'message',
    role: 'assistant',
    content: blocks.filter(Boolean),
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ── Server ─────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  // Catch unhandled errors — never return Bun's default HTML error page.
  error(err) {
    console.error(`[proxy] Unhandled error: ${err.message}`);
    return Response.json({ type: 'error', error: { type: 'server_error', message: err.message } }, { status: 500 });
  },
  async fetch(request) {
    const url = new URL(request.url);

    // Log ALL requests for debugging
    console.log(`[proxy:req] ${request.method} ${url.pathname}`);

    // Stub out SDK init endpoints that try to reach CLAUDE_CODE_API_BASE_URL.
    // For NW workers, this points to the shim. Return empty 200s so the SDK's
    // oauth/profile, fast-mode, usage checks don't crash with 401/404.
    // Only /v1/messages (via /w/<folder>/) needs real handling.
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/v1/organizations') ||
      url.pathname.startsWith('/v1/sessions') ||
      (request.method === 'GET' &&
        !url.pathname.startsWith('/w/') &&
        !url.pathname.startsWith('/usage') &&
        !url.pathname.startsWith('/health') &&
        !url.pathname.startsWith('/models'))
    ) {
      return Response.json({});
    }

    // Health + usage + config endpoints
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }
    if (url.pathname === '/usage') {
      return Response.json({ ...workerUsage, total: getUsageTotal() });
    }
    if (url.pathname === '/usage/total') {
      return Response.json(getUsageTotal());
    }
    if (url.pathname.startsWith('/usage/')) {
      const folder = url.pathname.slice('/usage/'.length);
      return Response.json(workerUsage[folder] || { error: 'no data' });
    }
    // Resolve a fuzzy model name to the best matching model ID
    if (url.pathname.startsWith('/models/resolve/')) {
      const query = decodeURIComponent(url.pathname.slice('/models/resolve/'.length)).toLowerCase();
      await refreshModelsCache();
      if (!modelsCache?.length) {
        return Response.json({ error: 'no models available' }, { status: 503 });
      }
      // Exact match first
      const exact = modelsCache.find((m) => m.toLowerCase() === query);
      if (exact) return Response.json({ model: exact, match: 'exact' });
      // Contains match (e.g., "kimi-k2.5-fast" matches "kimi-k2.5-fast")
      const contains = modelsCache.filter((m) => m.toLowerCase().includes(query));
      if (contains.length === 1) return Response.json({ model: contains[0], match: 'contains' });
      // Fuzzy: split query into parts, score by how many parts match
      const parts = query.split(/[-_/.]+/);
      const scored = modelsCache
        .map((m) => {
          const ml = m.toLowerCase();
          const score = parts.filter((p) => ml.includes(p)).length;
          return { model: m, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length > 0) {
        return Response.json({
          model: scored[0].model,
          match: 'fuzzy',
          candidates: scored.slice(0, 5).map((s) => s.model),
        });
      }
      return Response.json({ error: `no match for "${query}"`, available: modelsCache }, { status: 404 });
    }
    // List available Neuralwatt models (queries API, cached 5 min)
    if (url.pathname === '/models') {
      await refreshModelsCache();
      return Response.json({ models: modelsCache || [] });
    }
    if (url.pathname === '/config' && request.method === 'GET') {
      return Response.json(loadConfig());
    }
    if (url.pathname === '/config' && request.method === 'PUT') {
      const newConfig = await request.json();
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
      return Response.json({ status: 'updated' });
    }

    // Worker config lookup endpoint (workers can read their own config)
    // Access via /w/<folder>/worker-config or /worker-config with x-api-key
    if (url.pathname === '/worker-config' || url.pathname.endsWith('/worker-config')) {
      const pathMatch = url.pathname.match(/^\/w\/([^/]+)\//);
      const folder = pathMatch ? pathMatch[1] : '';
      const config = getWorkerConfig(folder);
      const model =
        config.backend === 'neuralwatt' ? resolveNeuralwattModel('', config.model) : 'claude (via anthropic)';
      return Response.json({ ...config, resolved_model: model });
    }

    // Global error handler: never return HTML, always JSON.
    const startMs = Date.now();
    try {
      // Read request body once
      const bodyBuffer = Buffer.from(await request.arrayBuffer());

      // Worker folder is encoded in the URL path: /w/<folder>/v1/messages
      // Strip the /w/<folder> prefix to get the real path.
      const workerMatch = url.pathname.match(/^\/w\/([^/]+)(\/.*)/);
      const workerFolder = workerMatch ? workerMatch[1] : '';
      if (workerMatch) {
        // Rewrite URL to strip worker prefix for downstream routing
        url.pathname = workerMatch[2];
      }
      const workerConfig = getWorkerConfig(workerFolder);
      const isMessagesPost = url.pathname === '/v1/messages' && request.method === 'POST';

      // Anthropic backend: pass through to credential proxy. Wrap /v1/messages
      // POSTs so we can record the full req/resp pair into shim-traces.jsonl;
      // other endpoints (oauth, profile, models) are noisy and not useful for
      // worker-stuck debugging.
      if (workerConfig.backend === 'anthropic') {
        if (isMessagesPost) {
          return await traceAnthropic(request, bodyBuffer, url, workerFolder, startMs);
        }
        return forwardToAnthropic(request, bodyBuffer, url);
      }

      // Neuralwatt backend: translate and forward
      if (url.pathname !== '/v1/messages' || request.method !== 'POST') {
        // Non-messages endpoints (e.g., /v1/models) — pass to credential proxy
        return forwardToAnthropic(request, bodyBuffer, url);
      }

      {
        const anthropicBody = JSON.parse(bodyBuffer.toString());
        const nwModel = resolveNeuralwattModel(anthropicBody.model, workerConfig.model);
        const openaiReq = anthropicToOpenAI(anthropicBody, nwModel);

        const reqBodySize = JSON.stringify(openaiReq).length;
        console.log(
          `[proxy] ${workerFolder}: ${anthropicBody.model} → ${nwModel} (${openaiReq.messages.length} msgs${openaiReq.tools ? `, ${openaiReq.tools.length} tools` : ''}, ${(reqBodySize / 1024).toFixed(1)}KB request)`,
        );
        // Dump request for analysis when SHIM_DUMP is set
        if (process.env.SHIM_DUMP === '1') {
          const dumpPath = `/tmp/shim-dump-${workerFolder}-${Date.now()}.json`;
          fs.writeFileSync(dumpPath, JSON.stringify(openaiReq, null, 2));
          console.log(`[proxy:dump] Request saved to ${dumpPath}`);
        }
        if (DEBUG) {
          console.log(`[proxy:debug] Request body size: ${reqBodySize} bytes`);
          console.log(
            `[proxy:debug] Messages: ${openaiReq.messages.map((m: any) => `${m.role}:${(m.content || '').length}chars`).join(', ')}`,
          );
          console.log(`[proxy:debug] Anthropic max_tokens: ${anthropicBody.max_tokens}`);
        }

        // Streaming: translate OpenAI SSE → Anthropic SSE on the fly.
        // Streaming is enabled by default (SHIM_STREAMING=0 to disable).
        if (STREAMING_ENABLED && anthropicBody.stream) {
          openaiReq.stream = true;
          const resp = await fetch(NEURALWATT_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${NEURALWATT_API_KEY}`,
            },
            body: JSON.stringify(openaiReq),
          });

          if (!resp.ok) {
            const err = await resp.text();
            console.error(`[proxy] Neuralwatt stream error: ${resp.status}`);
            appendTrace({
              ts: new Date().toISOString(),
              worker: workerFolder,
              backend: 'neuralwatt',
              model_in: anthropicBody.model,
              model_out: nwModel,
              method: 'POST',
              path: '/v1/messages',
              status: resp.status,
              stream: true,
              latency_ms: Date.now() - startMs,
              req_size: bodyBuffer.length,
              resp_size: err.length,
              req_body: anthropicBody,
              resp_body: { error_text: err },
              error: `upstream ${resp.status}`,
            });
            return Response.json(
              {
                type: 'error',
                error: { type: 'api_error', message: `Upstream: ${err}` },
              },
              { status: resp.status },
            );
          }

          const msgId = `msg_${Date.now()}`;
          const stream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              let streamClosed = false;
              const emit = (event: string, data: any) => {
                if (streamClosed) return;
                try {
                  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                } catch {
                  streamClosed = true;
                }
              };

              // Emit message_start
              emit('message_start', {
                type: 'message_start',
                message: {
                  id: msgId,
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: anthropicBody.model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 0 },
                },
              });

              let blockIndex = 0;
              let inThinking = false;
              let inText = false;
              let inToolUse = false;
              let stopReason = 'end_turn';
              let usage: any = {};
              let energy: any = undefined;
              let toolCallAccum: Record<number, { id: string; name: string; args: string }> = {};
              // Trace accumulators — reconstruct final Anthropic message
              // shape for the trace log without re-parsing the SSE we
              // already emit.
              let traceText = '';
              let traceThinking = '';

              const reader = resp.body!.getReader();
              const decoder = new TextDecoder();
              let buffer = '';

              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split('\n');
                  buffer = lines.pop()!;

                  for (const line of lines) {
                    // Energy comment
                    if (line.startsWith(': energy ')) {
                      try {
                        energy = JSON.parse(line.slice(9));
                      } catch {}
                      continue;
                    }

                    if (line === 'data: [DONE]') continue;
                    if (!line.startsWith('data: ')) continue;

                    let chunk: any;
                    try {
                      chunk = JSON.parse(line.slice(6));
                    } catch {
                      continue;
                    }

                    const choice = chunk.choices?.[0];
                    const delta = choice?.delta;

                    // Capture usage from any chunk that has it
                    if (chunk.usage) {
                      usage = chunk.usage;
                    }

                    // Skip chunks with no choices
                    if (!chunk.choices || chunk.choices.length === 0) {
                      continue;
                    }

                    if (!delta) continue;

                    // Reasoning/thinking
                    if (delta.reasoning != null) {
                      traceThinking += delta.reasoning;
                      if (!inThinking) {
                        inThinking = true;
                        emit('content_block_start', {
                          type: 'content_block_start',
                          index: blockIndex,
                          content_block: { type: 'thinking', thinking: '' },
                        });
                      }
                      emit('content_block_delta', {
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: {
                          type: 'thinking_delta',
                          thinking: delta.reasoning,
                        },
                      });
                    }

                    // Text content (skip null — API sends null during tool calls)
                    if (delta.content != null && delta.content !== '') {
                      traceText += delta.content;
                      if (inThinking) {
                        emit('content_block_stop', {
                          type: 'content_block_stop',
                          index: blockIndex,
                        });
                        blockIndex++;
                        inThinking = false;
                      }
                      if (!inText) {
                        inText = true;
                        emit('content_block_start', {
                          type: 'content_block_start',
                          index: blockIndex,
                          content_block: { type: 'text', text: '' },
                        });
                      }
                      emit('content_block_delta', {
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'text_delta', text: delta.content },
                      });
                    }

                    // Tool calls
                    if (delta.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (tc.id) {
                          // New tool call start
                          if (inThinking) {
                            emit('content_block_stop', {
                              type: 'content_block_stop',
                              index: blockIndex,
                            });
                            blockIndex++;
                            inThinking = false;
                          }
                          if (inText) {
                            emit('content_block_stop', {
                              type: 'content_block_stop',
                              index: blockIndex,
                            });
                            blockIndex++;
                            inText = false;
                          }
                          toolCallAccum[idx] = {
                            id: tc.id,
                            name: tc.function?.name || '',
                            args: '',
                          };
                          emit('content_block_start', {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: {
                              type: 'tool_use',
                              id: tc.id,
                              name: tc.function?.name || '',
                            },
                          });
                          inToolUse = true;
                        }
                        if (tc.function?.arguments) {
                          toolCallAccum[idx].args += tc.function.arguments;
                          emit('content_block_delta', {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: {
                              type: 'input_json_delta',
                              partial_json: tc.function.arguments,
                            },
                          });
                        }
                      }
                    }

                    // Finish reason
                    if (choice?.finish_reason) {
                      if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
                      else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
                      else stopReason = 'end_turn';
                    }
                  }
                }

                // Close any open blocks
                if (inThinking || inText || inToolUse) {
                  emit('content_block_stop', {
                    type: 'content_block_stop',
                    index: blockIndex,
                  });
                }

                // message_delta with stop_reason and usage
                emit('message_delta', {
                  type: 'message_delta',
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: usage.completion_tokens || 0 },
                });

                emit('message_stop', { type: 'message_stop' });

                // Record usage
                recordUsage(workerFolder, usage, energy);
                console.log(
                  `[proxy] → stream ${stopReason} (${usage.completion_tokens || '?'} out, ${usage.prompt_tokens || '?'} in)`,
                );

                // Trace: assemble the final Anthropic-shape message from
                // accumulators and log alongside the request.
                const traceContent: any[] = [];
                if (traceThinking) traceContent.push({ type: 'thinking', thinking: traceThinking });
                if (traceText) traceContent.push({ type: 'text', text: traceText });
                for (const tc of Object.values(toolCallAccum)) {
                  let parsedInput: any = tc.args;
                  try {
                    parsedInput = JSON.parse(tc.args || '{}');
                  } catch {
                    /* keep string */
                  }
                  traceContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput });
                }
                // resp_size: total assembled chars across content blocks.
                // Bytes-on-the-wire isn't tracked for the streaming neuralwatt
                // path because we re-emit Anthropic SSE rather than re-buffer
                // the OpenAI bytes. Char count is enough for "is the response
                // tiny / huge?" triage; turns.jsonl carries the accurate
                // result_text_length.
                const traceToolJsonLen = Object.values(toolCallAccum).reduce((a, t) => a + (t.args?.length ?? 0), 0);
                appendTrace({
                  ts: new Date().toISOString(),
                  worker: workerFolder,
                  backend: 'neuralwatt',
                  model_in: anthropicBody.model,
                  model_out: nwModel,
                  method: 'POST',
                  path: '/v1/messages',
                  status: 200,
                  stream: true,
                  latency_ms: Date.now() - startMs,
                  req_size: bodyBuffer.length,
                  resp_size: traceText.length + traceThinking.length + traceToolJsonLen,
                  stop_reason: stopReason,
                  input_tokens: usage.prompt_tokens ?? null,
                  output_tokens: usage.completion_tokens ?? null,
                  req_body: anthropicBody,
                  resp_body: {
                    id: msgId,
                    type: 'message',
                    role: 'assistant',
                    model: anthropicBody.model,
                    content: traceContent,
                    stop_reason: stopReason,
                    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
                  },
                  error: null,
                });
              } catch (err: any) {
                console.error(`[proxy] Stream error: ${err.message}`);
                appendTrace({
                  ts: new Date().toISOString(),
                  worker: workerFolder,
                  backend: 'neuralwatt',
                  model_in: anthropicBody.model,
                  model_out: nwModel,
                  method: 'POST',
                  path: '/v1/messages',
                  status: 0,
                  stream: true,
                  latency_ms: Date.now() - startMs,
                  req_size: bodyBuffer.length,
                  resp_size: 0,
                  req_body: anthropicBody,
                  resp_body: null,
                  error: err.message,
                });
              } finally {
                if (!streamClosed) {
                  try {
                    controller.close();
                  } catch {
                    // Already closed by client disconnect
                  }
                }
              }
            },
          });

          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            },
          });
        }

        // Non-streaming: buffer full response
        const resp = await fetch(NEURALWATT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${NEURALWATT_API_KEY}`,
          },
          body: JSON.stringify(openaiReq),
        });

        if (!resp.ok) {
          const err = await resp.text();
          console.error(`[proxy] Neuralwatt error: ${resp.status} ${err}`);
          appendTrace({
            ts: new Date().toISOString(),
            worker: workerFolder,
            backend: 'neuralwatt',
            model_in: anthropicBody.model,
            model_out: nwModel,
            method: 'POST',
            path: '/v1/messages',
            status: resp.status,
            stream: false,
            latency_ms: Date.now() - startMs,
            req_size: bodyBuffer.length,
            resp_size: err.length,
            req_body: anthropicBody,
            resp_body: { error_text: err },
            error: `upstream ${resp.status}`,
          });
          return Response.json(
            {
              type: 'error',
              error: { type: 'api_error', message: `Upstream: ${err}` },
            },
            { status: resp.status },
          );
        }

        const openaiResp = await resp.json();
        const anthropicResp = openAIToAnthropic(openaiResp, anthropicBody.model);

        // Track usage + energy per worker
        recordUsage(workerFolder, openaiResp.usage, openaiResp.energy);

        console.log(
          `[proxy] → ${anthropicResp.stop_reason} (${anthropicResp.usage.output_tokens} out, ${openaiResp.usage?.prompt_tokens || '?'} in)`,
        );
        if (DEBUG) {
          console.log(`[proxy:debug] Raw usage: ${JSON.stringify(openaiResp.usage)}`);
          console.log(`[proxy:debug] Raw energy: ${JSON.stringify(openaiResp.energy)}`);
        }

        appendTrace({
          ts: new Date().toISOString(),
          worker: workerFolder,
          backend: 'neuralwatt',
          model_in: anthropicBody.model,
          model_out: nwModel,
          method: 'POST',
          path: '/v1/messages',
          status: 200,
          stream: false,
          latency_ms: Date.now() - startMs,
          req_size: bodyBuffer.length,
          resp_size: JSON.stringify(anthropicResp).length,
          stop_reason: anthropicResp.stop_reason,
          input_tokens: openaiResp.usage?.prompt_tokens ?? null,
          output_tokens: openaiResp.usage?.completion_tokens ?? null,
          req_body: anthropicBody,
          resp_body: anthropicResp,
          error: null,
        });

        return Response.json(anthropicResp);
      }
    } catch (err: any) {
      console.error(`[proxy] Error: ${err.message}`);
      return Response.json(
        {
          type: 'error',
          error: { type: 'api_error', message: err.message },
        },
        { status: 500 },
      );
    }
  },
});

console.log(`[proxy] Universal inference proxy on port ${PORT}`);
console.log(`[proxy] Anthropic → ${CREDENTIAL_PROXY_URL}`);
console.log(`[proxy] Neuralwatt → ${NEURALWATT_URL}`);
console.log(`[proxy] Config: ${CONFIG_PATH}`);
