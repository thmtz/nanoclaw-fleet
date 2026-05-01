/**
 * Resolve the per-worker auto-compact window — how many input tokens can
 * accumulate before the Claude Agent SDK auto-summarizes the conversation.
 *
 * Why per-worker: a single hardcoded value (the previous 165k) compacts
 * Opus/Sonnet workers at 16% of their 1M context, which both wastes context
 * and creates more chances to trip the post-compaction failure modes. For
 * shorter-context Neuralwatt models (128–256k) the same value either fires
 * sensibly or never fires at all (model errors first).
 *
 * Resolution order:
 *   1. Explicit per-worker override (caller passes a number)
 *   2. Hardcoded Claude model → context map (we know these values)
 *   3. Neuralwatt model-limits cache file (written by tools/anthropic-shim.ts)
 *   4. Fallback (DEFAULT_FALLBACK_WINDOW)
 *
 * The returned value is ~85% of the model's context — leaves headroom for
 * the response itself plus a buffer before the SDK starts summarizing.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';

const COMPACT_RATIO = 0.85;
const DEFAULT_FALLBACK_WINDOW = 165_000;

/**
 * Hardcoded Claude model context limits. Values come from Anthropic's
 * published model docs and are stable for the lifetime of each model
 * version — when adding a new model, look up its window once and add it
 * here. Anthropic's `/v1/models` endpoint doesn't expose context length
 * the way Neuralwatt's does, so we maintain this map by hand.
 */
const CLAUDE_MODEL_CONTEXT: Record<string, number> = {
  // Claude 4.x — Opus and Sonnet support 1M context (extended)
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5-20250929': 1_000_000,
  'claude-sonnet-4-20250514': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-haiku-4-5': 200_000,
};

/**
 * Where the Neuralwatt limits cache lives. Resolution order:
 *   1. NW_SHIM_MODEL_LIMITS_PATH env var (matches the shim's MODEL_LIMITS_PATH)
 *   2. Same in .env file
 *   3. Fallback to <cwd>/data/model-limits.json (the shim's default)
 */
function defaultLimitsPath(): string {
  const fromProcess = process.env.NW_SHIM_MODEL_LIMITS_PATH;
  if (fromProcess) return fromProcess;
  try {
    const fromEnvFile = readEnvFile(['NW_SHIM_MODEL_LIMITS_PATH']).NW_SHIM_MODEL_LIMITS_PATH;
    if (fromEnvFile) return fromEnvFile;
  } catch {
    /* fallthrough */
  }
  return path.join(process.cwd(), 'data', 'model-limits.json');
}

let nwLimitsCache: { mtime: number; data: Record<string, number> } | null = null;

function loadNeuralwattLimits(limitsPath: string = defaultLimitsPath()): Record<string, number> {
  try {
    if (!fs.existsSync(limitsPath)) return {};
    const stat = fs.statSync(limitsPath);
    if (nwLimitsCache && nwLimitsCache.mtime === stat.mtimeMs) return nwLimitsCache.data;
    const data = JSON.parse(fs.readFileSync(limitsPath, 'utf-8')) as Record<string, number>;
    nwLimitsCache = { mtime: stat.mtimeMs, data };
    return data;
  } catch (err) {
    // Cache regenerates on the shim's next /v1/models refresh, so this
    // is recoverable — but corruption shouldn't be invisible. Workers
    // fall through to DEFAULT_FALLBACK_WINDOW until the cache repairs.
    console.warn(
      `[compact-window] Failed to read NW limits cache at ${limitsPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

export interface ResolveCompactWindowOptions {
  /** Explicit per-worker override — wins over all auto-resolution. */
  override?: number;
  /** Path to the Neuralwatt limits cache. Defaults to `data/model-limits.json`. */
  limitsPath?: string;
  /** Fallback window when nothing matches. Defaults to 165k. */
  fallback?: number;
}

/**
 * Resolve the auto-compact window for a given model name. Pure function —
 * tests can pass a custom limitsPath / fallback. Returns floor(ratio * context).
 */
export function resolveCompactWindow(model: string | undefined, opts: ResolveCompactWindowOptions = {}): number {
  const fallback = opts.fallback ?? DEFAULT_FALLBACK_WINDOW;
  if (typeof opts.override === 'number' && opts.override > 0) return opts.override;
  if (!model) return fallback;

  const claude = CLAUDE_MODEL_CONTEXT[model];
  if (claude) return Math.floor(claude * COMPACT_RATIO);

  const nwLimits = loadNeuralwattLimits(opts.limitsPath);
  const nw = nwLimits[model];
  if (nw) return Math.floor(nw * COMPACT_RATIO);

  return fallback;
}
