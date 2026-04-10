/**
 * Per-worker audit logging.
 *
 * Extracts usage data from Claude SDK transcripts after each container turn
 * and writes structured JSONL entries to logs/workers/<folder>/turns.jsonl.
 *
 * For Neuralwatt workers, the shim writes turn entries directly (it sees every
 * API call). For Anthropic workers, this module reads the SDK transcript to
 * extract the same data post-hoc.
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

const LOGS_DIR = path.join(process.cwd(), 'logs', 'workers');

interface TurnEntry {
  ts: string;
  model: string;
  backend: 'neuralwatt' | 'anthropic';
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number | null;
  cache_creation_tokens: number | null;
  latency_ms: number | null;
  stop_reason: string;
  stream: boolean;
}

/** Parse assistant messages with usage data from transcript JSONL lines. */
function parseTurnsFromLines(lines: string[], turns: TurnEntry[]): void {
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.message?.role !== 'assistant') continue;
      if (!entry.message?.usage) continue;

      const usage = entry.message.usage;
      turns.push({
        ts: new Date().toISOString(),
        model: entry.message.model || 'unknown',
        backend: 'anthropic',
        input_tokens:
          (usage.input_tokens || 0) +
          (usage.cache_read_input_tokens || 0) +
          (usage.cache_creation_input_tokens || 0),
        output_tokens: usage.output_tokens || 0,
        cached_tokens: usage.cache_read_input_tokens || null,
        cache_creation_tokens: usage.cache_creation_input_tokens || null,
        latency_ms: null,
        stop_reason: entry.message.stop_reason || 'unknown',
        stream: true,
      });
    } catch {
      // Skip malformed lines
    }
  }
}

/**
 * Extract usage from SDK transcript entries written during a container run.
 * Reads only entries added after `sinceOffset` bytes.
 */
export function extractTurnsFromTranscript(
  groupFolder: string,
  sessionId: string | undefined,
  sinceOffset: number,
): void {
  if (!sessionId) return;

  // Find the transcript file
  const sessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  const transcriptFile = path.join(sessionsDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(transcriptFile)) {
    logger.debug(
      { groupFolder, sessionId },
      'No transcript file found for audit extraction',
    );
    return;
  }

  const stat = fs.statSync(transcriptFile);
  if (stat.size <= sinceOffset) return; // No new data

  // Read only new bytes
  const fd = fs.openSync(transcriptFile, 'r');
  const buf = Buffer.alloc(stat.size - sinceOffset);
  fs.readSync(fd, buf, 0, buf.length, sinceOffset);
  fs.closeSync(fd);

  const newContent = buf.toString('utf-8');
  const lines = newContent.trim().split('\n').filter(Boolean);

  const turns: TurnEntry[] = [];

  // Extract turns from transcript lines
  parseTurnsFromLines(lines, turns);

  // Also scan subagent transcripts for this session
  const subagentsDir = path.join(sessionsDir, sessionId, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    for (const subFile of fs.readdirSync(subagentsDir)) {
      if (!subFile.endsWith('.jsonl')) continue;
      try {
        const subContent = fs.readFileSync(
          path.join(subagentsDir, subFile),
          'utf-8',
        );
        parseTurnsFromLines(
          subContent.trim().split('\n').filter(Boolean),
          turns,
        );
      } catch {
        // Skip corrupt subagent files
      }
    }
  }

  // Write to audit log
  const dir = path.join(LOGS_DIR, groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  const auditFile = path.join(dir, 'turns.jsonl');
  const entries = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
  fs.appendFileSync(auditFile, entries);

  logger.debug(
    { groupFolder, newTurns: turns.length },
    'Extracted audit turns from transcript',
  );
}

/**
 * Get the current byte offset of a transcript file (for tracking new entries).
 */
export function getTranscriptOffset(
  groupFolder: string,
  sessionId: string | undefined,
): number {
  if (!sessionId) return 0;
  const transcriptFile = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
  try {
    return fs.statSync(transcriptFile).size;
  } catch {
    return 0;
  }
}
