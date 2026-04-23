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

function readFleetProviderBlock(folder: string): { model?: string; base_url?: string } {
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
  // Recover the group folder from its id — central DB lookup is overkill here;
  // per-session dir is a sibling of the session id under agent_group_id, but
  // we only need the per-group container.json which lives under GROUPS_DIR.
  // Walk sessions dir → agent_group_id → central DB lookup would import a
  // circular dep, so we instead read from the group's container.json via a
  // resolver the caller provides. For v1 of the skill, fall back to env-only.
  //
  // Simpler: fleet's setFleetBackend writes providers.neuralwatt into
  // groups/<folder>/container.json. The agent_group folder isn't on ctx yet —
  // we look it up by reading every group dir to find the one matching
  // agentGroupId via container.json::agentGroupId. Cheap: O(small-N) on each
  // spawn, same order of cost as the existing provider-container path.

  let model: string | undefined;
  let baseUrl: string | undefined = ctx.hostEnv.NW_SHIM_URL || ctx.hostEnv.ANTHROPIC_BASE_URL;

  try {
    for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = path.join(GROUPS_DIR, entry.name, 'container.json');
      if (!fs.existsSync(cfgPath)) continue;
      let raw: { agentGroupId?: string; providers?: Record<string, { model?: string; base_url?: string }> };
      try {
        raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      } catch {
        continue;
      }
      if (raw.agentGroupId === ctx.agentGroupId) {
        const block = readFleetProviderBlock(entry.name);
        if (block.model) model = block.model;
        if (block.base_url) baseUrl = block.base_url;
        break;
      }
    }
  } catch {
    // Fall through to defaults.
  }

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl ?? DEFAULT_BASE_URL,
  };
  if (model) env.ANTHROPIC_MODEL = model;

  return { env };
});
