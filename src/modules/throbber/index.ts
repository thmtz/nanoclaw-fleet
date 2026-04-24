/**
 * Throbber module — cycles a reaction emoji on the user's incoming
 * message each time the container writes a heartbeat.
 *
 * The heartbeat file's mtime is bumped by the container on every SDK
 * event (see container/agent-runner/src/poll-loop.ts `touchHeartbeat()`),
 * which means every inference API response. The throbber is a direct
 * visual of that signal: emoji cycles each time the API responds. If
 * inference hangs, the emoji stops changing and the user can see the
 * agent is wedged — even if nothing is posted to Discord yet.
 *
 * No wall-clock timer drives the cycle. Host watches the heartbeat file
 * with fs.watchFile (500ms poll granularity) and cycles on mtime change.
 *
 * Cleared when the first non-system user-facing message delivers.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';

const THROBBER_EMOJIS = ['🔵', '🟦', '🔷'];
/**
 * fs.watchFile poll granularity — stat every ~400ms. Coarser than the
 * default 5s (way too slow for a visible throbber), finer-grained than
 * needed for correctness. Heartbeats land faster than this in practice
 * during active work, so each poll tick will see at most one apparent
 * bump per window and we cycle exactly once per window.
 */
const WATCH_INTERVAL_MS = 400;

interface ReactionAdapter {
  addReaction?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  removeReaction?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    messageId: string,
    emoji: string,
  ): Promise<void>;
}

interface ThrobberTarget {
  agentGroupId: string;
  sessionId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
  hbPath: string;
  watcher: fs.StatWatcher;
  idx: number;
  active: boolean; // have we placed at least one reaction?
  lastMtimeMs: number;
}

let adapter: ReactionAdapter | null = null;
const throbbers = new Map<string, ThrobberTarget>();

/** Bind the throbber module to the channel delivery adapter. Called
 *  once from src/delivery.ts inside setDeliveryAdapter. */
export function setThrobberAdapter(a: ReactionAdapter): void {
  adapter = a;
}

async function react(t: ThrobberTarget, emoji: string): Promise<void> {
  try {
    await adapter?.addReaction?.(t.channelType, t.platformId, t.threadId, t.messageId, emoji);
  } catch {
    // Best effort — never let throbber errors bubble.
  }
}

async function unreact(t: ThrobberTarget, emoji: string): Promise<void> {
  try {
    await adapter?.removeReaction?.(t.channelType, t.platformId, t.threadId, t.messageId, emoji);
  } catch {
    // Best effort.
  }
}

function cycle(t: ThrobberTarget): void {
  const prevEmoji = THROBBER_EMOJIS[(t.idx - 1 + THROBBER_EMOJIS.length) % THROBBER_EMOJIS.length];
  const nextEmoji = THROBBER_EMOJIS[t.idx % THROBBER_EMOJIS.length];

  // Add before remove — keeps reaction count >= 1 so the message doesn't
  // visually jump from having reactions to none mid-cycle.
  void (async () => {
    await react(t, nextEmoji);
    if (t.active) await unreact(t, prevEmoji);
    t.active = true;
  })();
  t.idx++;
}

export function startThrobber(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  messageId: string,
): void {
  if (!adapter?.addReaction) return; // platform has no reactions

  const existing = throbbers.get(sessionId);
  if (existing) {
    // New inbound message on an already-running throbber — retarget to
    // the newer message so the emoji appears where the user last spoke.
    // Clear old target's reactions best-effort.
    if (existing.active) {
      for (const emoji of THROBBER_EMOJIS) {
        void unreact(existing, emoji);
      }
    }
    existing.messageId = messageId;
    existing.idx = 0;
    existing.active = false;
    // Reset lastMtimeMs — require a fresh heartbeat AFTER this inbound
    // before the first cycle fires. Ensures the reaction signals a
    // new API response, not a stale one from the previous turn.
    existing.lastMtimeMs = readMtime(existing.hbPath);
    return;
  }

  const hbPath = heartbeatPath(agentGroupId, sessionId);
  const target: ThrobberTarget = {
    agentGroupId,
    sessionId,
    channelType,
    platformId,
    threadId,
    messageId,
    hbPath,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    watcher: null as any, // set below
    idx: 0,
    active: false,
    lastMtimeMs: readMtime(hbPath),
  };

  // fs.watchFile polls stat at the configured interval and fires on any
  // change (mtime/ctime/size). utimesSync in the container updates mtime,
  // which fs.watch (inotify IN_MODIFY) does NOT surface on Linux — so we
  // use watchFile + poll instead. Polling is 500ms-ish; plenty responsive
  // for a visual throbber and cheap per-session.
  const watcher = fs.watchFile(hbPath, { interval: WATCH_INTERVAL_MS, persistent: false }, (curr) => {
    const t = throbbers.get(sessionId);
    if (!t) return;
    if (curr.mtimeMs === 0) return; // file missing (container not yet touched it)
    if (curr.mtimeMs === t.lastMtimeMs) return;
    t.lastMtimeMs = curr.mtimeMs;
    cycle(t);
  });
  target.watcher = watcher;
  throbbers.set(sessionId, target);
  log.debug('Throbber started', { sessionId, messageId, hbPath });
}

function readMtime(hbPath: string): number {
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

export function stopThrobber(sessionId: string): void {
  const t = throbbers.get(sessionId);
  if (!t) return;
  fs.unwatchFile(t.hbPath);
  throbbers.delete(sessionId);
  if (!t.active) return;
  // Clear all possible emojis — in case a cycle raced mid-transition.
  for (const emoji of THROBBER_EMOJIS) {
    void unreact(t, emoji);
  }
  log.debug('Throbber stopped', { sessionId });
}
