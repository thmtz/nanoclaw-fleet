/**
 * Outbound wake server.
 *
 * The container writes to outbound.db and then POSTs to this server so the
 * host delivers immediately instead of waiting for the next 1s poll tick.
 * Polling remains as a safety net — a dropped wake just falls back to the
 * next poll.
 *
 * Routes:
 *   POST /wake/:sessionId  (no body required)
 *
 * The container reaches this via host.docker.internal. The container-side
 * writer (container/agent-runner/src/db/messages-out.ts) fires a
 * best-effort fetch after every writeMessageOut.
 */
import http from 'http';

import { deliverSessionMessages } from './delivery.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';

const DEFAULT_PORT = 3100;

let server: http.Server | null = null;
let port = 0;

/**
 * Pending deliveries keyed by sessionId — dedupes bursts of wakes from a
 * single session so we don't stack handlers. The first wake triggers
 * drainSession; subsequent wakes within the drain are collapsed because
 * deliverSessionMessages already guards re-entry via inflightDeliveries.
 */
const pending = new Set<string>();

export function startOutboundWakeServer(): number {
  if (server) return port;

  const envPort = parseInt(process.env.OUTBOUND_WAKE_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer((req, res) => {
    const url = req.url || '/';
    const match = url.match(/^\/wake\/([^/?]+)/);
    if (!match || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const sessionId = match[1];
    // Drain request body (we don't need it, but Node won't close the
    // socket cleanly until 'end' fires).
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');

      if (pending.has(sessionId)) return;
      pending.add(sessionId);

      // Fire async — don't block the HTTP response on actual delivery.
      void (async () => {
        try {
          const session = getSession(sessionId);
          if (!session) {
            log.debug('Wake for unknown session', { sessionId });
            return;
          }
          await deliverSessionMessages(session);
        } catch (err) {
          log.warn('Outbound wake delivery error', { sessionId, err });
        } finally {
          pending.delete(sessionId);
        }
      })();
    });
  });

  server.listen(envPort, '0.0.0.0', () => {
    const addr = server!.address();
    port = typeof addr === 'object' && addr ? addr.port : envPort;
    log.info('Outbound wake server started', { port });
  });

  return envPort;
}

export function getOutboundWakePort(): number {
  return port || parseInt(process.env.OUTBOUND_WAKE_PORT || String(DEFAULT_PORT), 10);
}

export async function stopOutboundWakeServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    port = 0;
    pending.clear();
    log.info('Outbound wake server stopped');
  }
}
