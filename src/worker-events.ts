/**
 * Worker event log: append-only JSONL file tracking worker lifecycle events.
 * Used by the master to query worker history (e.g. "what workers existed today?").
 */
import fs from 'fs';
import path from 'path';

const EVENTS_FILE = path.join(process.cwd(), 'logs', 'worker-events.jsonl');

export interface WorkerEvent {
  timestamp: string;
  event: 'created' | 'destroyed' | 'backend_switched' | 'resumed';
  worker: string;
  folder: string;
  details?: Record<string, unknown>;
}

export function logWorkerEvent(event: WorkerEvent): void {
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
}

export function readWorkerEvents(opts?: {
  worker?: string;
  event?: string;
  since?: string;
  limit?: number;
}): WorkerEvent[] {
  if (!fs.existsSync(EVENTS_FILE)) return [];

  const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').trim().split('\n');
  let events: WorkerEvent[] = [];

  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip corrupt lines */
    }
  }

  if (opts?.since) {
    const sinceTime = new Date(opts.since).getTime();
    events = events.filter((e) => new Date(e.timestamp).getTime() >= sinceTime);
  }
  if (opts?.worker) {
    const w = opts.worker.toLowerCase();
    events = events.filter(
      (e) =>
        e.worker.toLowerCase().includes(w) ||
        e.folder.toLowerCase().includes(w),
    );
  }
  if (opts?.event) {
    events = events.filter((e) => e.event === opts.event);
  }
  if (opts?.limit) {
    events = events.slice(-opts.limit);
  }

  return events;
}
