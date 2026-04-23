/**
 * Neuralwatt provider — Claude Agent SDK with ANTHROPIC_BASE_URL pointed at
 * the Neuralwatt translation shim (or any OpenAI-compat endpoint that speaks
 * Anthropic Messages wire format via a shim).
 *
 * This is the fleet-specific path: keeps the Claude Agent SDK (tools, thinking,
 * PreCompact hooks, etc.) while routing outbound calls to an alternative
 * inference provider. The host contributes ANTHROPIC_BASE_URL to the
 * container env from groups/<folder>/container.json::providers.neuralwatt.base_url
 * (or DEFAULT_NW_BASE_URL when absent).
 *
 * Model selection comes from container.json::providers.neuralwatt.model —
 * threaded into the container as ANTHROPIC_MODEL (read by Claude Code SDK
 * when picking the model for each request).
 */
import { ClaudeProvider } from './claude.js';
import { registerProvider } from './provider-registry.js';
import type { ProviderOptions } from './types.js';

registerProvider('neuralwatt', (opts: ProviderOptions) => new ClaudeProvider(opts));
