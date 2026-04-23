import fs from 'fs';
import path from 'path';

import {
  BACKEND_ANTHROPIC,
  BACKEND_NEURALWATT,
  DATA_DIR,
  type InferenceBackend,
  WORKER_BACKENDS_FILENAME,
} from './config.js';
import { readEnvFile } from './env.js';

export const MAIN_FOLDER = 'discord_main';

export const FALLBACK_ANTHROPIC_MODEL = 'claude-opus-4-6';
export const FALLBACK_NEURALWATT_MODEL = 'moonshotai/Kimi-K2.5';

export interface BackendConfig {
  backend: InferenceBackend;
  model: string;
}

/**
 * Resolve the default backend + model for a folder, re-reading .env on each
 * call so edits take effect on next worker/master spawn with no service restart.
 *
 * `discord_main` uses NANOCLAW_DEFAULT_MASTER_{BACKEND,MODEL}.
 * All other folders use NANOCLAW_DEFAULT_WORKER_{BACKEND,MODEL}.
 * For Anthropic, *_MODEL wins over the legacy NANOCLAW_MODEL; both override the
 * built-in fallback.
 */
export function resolveDefaultBackendConfig(folder: string): BackendConfig {
  const isMaster = folder === MAIN_FOLDER;
  const env = readEnvFile([
    'NANOCLAW_DEFAULT_MASTER_BACKEND',
    'NANOCLAW_DEFAULT_MASTER_MODEL',
    'NANOCLAW_DEFAULT_WORKER_BACKEND',
    'NANOCLAW_DEFAULT_WORKER_MODEL',
    'NANOCLAW_MODEL',
  ]);
  const backendKey = isMaster
    ? 'NANOCLAW_DEFAULT_MASTER_BACKEND'
    : 'NANOCLAW_DEFAULT_WORKER_BACKEND';
  const modelKey = isMaster
    ? 'NANOCLAW_DEFAULT_MASTER_MODEL'
    : 'NANOCLAW_DEFAULT_WORKER_MODEL';

  const rawBackend = env[backendKey] || BACKEND_ANTHROPIC;
  const backend: InferenceBackend =
    rawBackend === BACKEND_NEURALWATT ? BACKEND_NEURALWATT : BACKEND_ANTHROPIC;

  const explicitModel = env[modelKey];
  const model =
    explicitModel ||
    (backend === BACKEND_NEURALWATT
      ? FALLBACK_NEURALWATT_MODEL
      : env.NANOCLAW_MODEL || FALLBACK_ANTHROPIC_MODEL);

  return { backend, model };
}

/**
 * Resolve the effective backend config for a folder: explicit state from
 * worker-backends.json wins, else env defaults. Used by status display and
 * container spawn to present a consistent view.
 */
export function resolveEffectiveBackendConfig(
  folder: string,
  entry: { backend?: string; model?: string } | null | undefined,
): BackendConfig {
  if (entry?.backend) {
    const backend: InferenceBackend =
      entry.backend === BACKEND_NEURALWATT
        ? BACKEND_NEURALWATT
        : BACKEND_ANTHROPIC;
    if (entry.model) return { backend, model: entry.model };
    // Entry with no model: fall back to env-derived default for that backend.
    const defaults = resolveDefaultBackendConfig(folder);
    if (defaults.backend === backend) return defaults;
    return {
      backend,
      model:
        backend === BACKEND_NEURALWATT
          ? FALLBACK_NEURALWATT_MODEL
          : FALLBACK_ANTHROPIC_MODEL,
    };
  }
  return resolveDefaultBackendConfig(folder);
}

/**
 * Write a backend entry to worker-backends.json iff none exists.
 * The shim and status display both read this file, so env-derived defaults
 * for master must be persisted at spawn time; otherwise the shim falls back
 * to `backend: 'anthropic'` and routes NW traffic to the real Anthropic API.
 * Returns true when an entry was written.
 */
export function seedBackendEntry(
  folder: string,
  config: BackendConfig,
): boolean {
  const backendsPath = path.join(DATA_DIR, WORKER_BACKENDS_FILENAME);
  let backends: Record<string, { backend: string; model?: string }> = {};
  try {
    backends = JSON.parse(fs.readFileSync(backendsPath, 'utf-8'));
  } catch {
    /* missing or corrupt — start fresh */
  }
  if (backends[folder]) return false;
  backends[folder] = { backend: config.backend, model: config.model };
  fs.mkdirSync(path.dirname(backendsPath), { recursive: true });
  const tmpPath = `${backendsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(backends, null, 2));
  fs.renameSync(tmpPath, backendsPath);
  return true;
}
