/**
 * Per-turn audit log (container side).
 *
 * Appends one JSON line per completed SDK turn to
 *   /workspace/turns.jsonl
 *
 * The host mounts that path into `logs/workers/<folder>/turns.jsonl` so
 * `ncf logs <worker> --cache|--slow` etc. can query usage / latency from
 * the host side (see v1 nanoclaw-fleet/src/audit-log.ts for the original).
 *
 * Current entry is latency-only — tokens + stop_reason require plumbing
 * through the ProviderEvent result type, which both claude.ts and
 * neuralwatt.ts would need to populate. Filed as the "turns.jsonl
 * usage fields" gap in docs/fleet/PARITY.md. The host-side reader can
 * still query latency / traceId / backend today.
 */
import fs from 'fs';

// The host mounts /workspace to data/v2-sessions/<ag>/<sess>/, so
// writing to /workspace/turns.jsonl lands in that session dir. The
// container-side sessions are per-session; the host aggregator will
// collect them under logs/workers/<folder>/ if needed.
const TURNS_FILE = '/workspace/turns.jsonl';

export interface TurnEntry {
  ts: string;
  traceId: string;
  backend: string;
  model?: string;
  first_event_ms: number | null;
  total_ms: number;
  result_text_length: number;
  // Populated once ProviderEvent result carries usage — null for now.
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  stop_reason: string | null;
}

export function logTurn(entry: TurnEntry): void {
  try {
    fs.appendFileSync(TURNS_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort — turn audit must never break the turn itself.
  }
}
