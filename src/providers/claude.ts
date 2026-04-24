/**
 * Host-side container config for the `claude` provider.
 *
 * Normally claude needs no host-side contribution — the Claude Code SDK
 * picks a sensible default model and the container gets credentials via
 * either OneCLI or the env-credential fallback.
 *
 * But fleet workers can be pointed at a specific Claude model (e.g.
 * "opus", "haiku-4.5") via `setFleetBackend('claude', model)` which
 * writes `providers.claude.model` in the worker's container.json. For
 * that to reach the SDK the container needs ANTHROPIC_MODEL set, and
 * that only happens if something wires it up here.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function readClaudeBlock(folder: string): { model?: string } {
  const p = path.join(GROUPS_DIR, folder, 'container.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      providers?: Record<string, { model?: string }>;
    };
    return raw.providers?.claude ?? {};
  } catch {
    return {};
  }
}

registerProviderContainerConfig('claude', (ctx) => {
  const block = readClaudeBlock(ctx.agentGroupFolder);
  const env: Record<string, string> = {};
  if (block.model) env.ANTHROPIC_MODEL = block.model;
  return { env };
});
