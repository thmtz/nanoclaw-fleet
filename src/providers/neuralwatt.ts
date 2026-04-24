/**
 * Host-side container config for the `neuralwatt` provider.
 *
 * Injects ANTHROPIC_BASE_URL so the Claude Agent SDK routes outbound calls
 * to the Neuralwatt translation shim instead of api.anthropic.com. Model
 * selection comes through ANTHROPIC_MODEL (set from the per-group
 * container.json providers.neuralwatt.model entry maintained by the fleet
 * setFleetBackend helper).
 *
 * Default base URL is `http://host.docker.internal:3003` — matches the
 * existing Neuralwatt shim's default bind. Override per-group by writing a
 * different base_url into container.json::providers.neuralwatt.base_url, or
 * globally via NW_SHIM_URL / ANTHROPIC_BASE_URL on the host .env.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const DEFAULT_BASE_URL = 'http://host.docker.internal:3003';

function readNeuralwattBlock(folder: string): { model?: string; base_url?: string } {
  const p = path.join(GROUPS_DIR, folder, 'container.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      providers?: Record<string, { model?: string; base_url?: string }>;
    };
    return raw.providers?.neuralwatt ?? {};
  } catch {
    return {};
  }
}

registerProviderContainerConfig('neuralwatt', (ctx) => {
  const block = readNeuralwattBlock(ctx.agentGroupFolder);
  // Precedence:
  //   1. container.json providers.neuralwatt.base_url  — explicit override
  //   2. host env NW_SHIM_URL or ANTHROPIC_BASE_URL     — global override
  //   3. DEFAULT_BASE_URL + /w/<folder>                 — lets the v1 shim
  //      apply the right per-folder backend/model from its
  //      worker-backends.json. Without the /w/<folder> prefix the shim
  //      falls back to "anthropic" and routes through the credential
  //      proxy instead of the NW upstream.
  const explicitBase = block.base_url ?? ctx.hostEnv.NW_SHIM_URL ?? ctx.hostEnv.ANTHROPIC_BASE_URL;
  const baseUrl = explicitBase ?? `${DEFAULT_BASE_URL}/w/${ctx.agentGroupFolder}`;

  const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl };
  if (block.model) env.ANTHROPIC_MODEL = block.model;
  return { env };
});
