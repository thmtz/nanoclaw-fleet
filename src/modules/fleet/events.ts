/**
 * Fleet worker lifecycle event log.
 *
 * Append-only JSONL at `logs/worker-events.jsonl` tracking create / destroy /
 * switch_backend / resume per agent group. The v1 fork used this as the
 * `ncf history` backing store + a way for an agent to answer "what workers
 * existed yesterday?" without trusting in-memory state.
 *
 * Host-local file only — not replicated, not cross-install. Best-effort
 * append; callers ignore failures.
 */
import fs from 'fs';
import path from 'path';

const EVENTS_FILE = path.resolve(process.cwd(), 'logs', 'worker-events.jsonl');

export type WorkerEventKind = 'created' | 'destroyed' | 'backend_switched' | 'resumed';

export interface WorkerEvent {
  timestamp: string;
  event: WorkerEventKind;
  worker: string;
  folder: string;
  details?: Record<string, unknown>;
}

export function logWorkerEvent(event: WorkerEvent): void {
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
  } catch {
    // Best-effort — lifecycle path shouldn't fail on a logging error.
  }
}

export function readWorkerEvents(opts?: {
  worker?: string;
  event?: WorkerEventKind;
  since?: string;
  limit?: number;
}): WorkerEvent[] {
  if (!fs.existsSync(EVENTS_FILE)) return [];

  const lines = fs.readFileSync(EVENTS_FILE, 'utf-8').trim().split('\n');
  let events: WorkerEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as WorkerEvent);
    } catch {
      // Ignore corrupt lines — don't let one bad row break history.
    }
  }
  if (opts?.since) {
    const sinceMs = new Date(opts.since).getTime();
    if (!Number.isNaN(sinceMs)) events = events.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
  }
  if (opts?.worker) {
    const w = opts.worker.toLowerCase();
    events = events.filter((e) => e.worker.toLowerCase().includes(w) || e.folder.toLowerCase().includes(w));
  }
  if (opts?.event) {
    events = events.filter((e) => e.event === opts.event);
  }
  if (opts?.limit) {
    events = events.slice(-opts.limit);
  }
  return events;
}
