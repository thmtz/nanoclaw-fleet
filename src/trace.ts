/**
 * Trace ID generation for cross-layer request tracing.
 *
 * Every user message gets a trace ID when it enters the host. The ID propagates
 * through container input, agent-runner logs, and IPC events so a single request
 * can be traced end-to-end.
 *
 * Format: t-<timestamp-ms>-<random-hex> (e.g. t-1775852707123-a3f)
 * Short enough to grep, unique enough to avoid collisions.
 */
import crypto from 'crypto';

export function generateTraceId(): string {
  const ts = Date.now();
  const rand = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  return `t-${ts}-${rand}`;
}
