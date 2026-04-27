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
 * with fs.watchFile (~400ms poll granularity) and cycles on mtime change.
 *
 * When a new user message arrives mid-turn (streaming-input pattern: the
 * SDK pushes the new message into the active query rather than starting
 * a new turn), the throbber retargets the cycling onto the latest
 * message but leaves the previous message's current emoji in place. Old
 * messages keep their final emoji as an "I saw this" badge until the
 * turn ends, then `stopThrobber` clears reactions across every inbound
 * id we touched in the session. This was the v1→v2 regression: v2's
 * first cut stripped reactions off older messages immediately on
 * retarget, so anything that wasn't the very latest read as silent.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';

const THROBBER_EMOJIS = ['🔵', '🟦', '🔷'];
/**
 * fs.watchFile poll granularity. Coarser than the default 5s (way too
 * slow for a visible throbber), finer-grained than needed for
 * correctness. Heartbeats land faster than this in practice during
 * active work, so each poll tick will see at most one apparent bump
 * per window and we cycle exactly once per window.
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

interface InflightMessage {
  messageId: string;
  /** Last emoji we placed on this message, or undefined if no react landed. */
  lastEmoji?: string;
}

interface ThrobberTarget {
  agentGroupId: string;
  sessionId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /**
   * In-flight inbound messages we've reacted to during this throbber's
   * lifetime, in arrival order. The last entry is the active cycling
   * target; older entries keep their last emoji as an "in-flight"
   * badge until stopThrobber clears them.
   */
  inflight: InflightMessage[];
  hbPath: string;
  watcher: fs.StatWatcher;
  idx: number;
  lastMtimeMs: number;
}

let adapter: ReactionAdapter | null = null;
const throbbers = new Map<string, ThrobberTarget>();

/** Bind the throbber module to the channel delivery adapter. Called
 *  once from src/delivery.ts inside setDeliveryAdapter. */
export function setThrobberAdapter(a: ReactionAdapter): void {
  adapter = a;
}

async function react(t: ThrobberTarget, messageId: string, emoji: string): Promise<void> {
  try {
    await adapter?.addReaction?.(t.channelType, t.platformId, t.threadId, messageId, emoji);
  } catch {
    // Best effort — never let throbber errors bubble.
  }
}

async function unreact(t: ThrobberTarget, messageId: string, emoji: string): Promise<void> {
  try {
    await adapter?.removeReaction?.(t.channelType, t.platformId, t.threadId, messageId, emoji);
  } catch {
    // Best effort.
  }
}

function activeMessage(t: ThrobberTarget): InflightMessage | undefined {
  return t.inflight[t.inflight.length - 1];
}

function cycle(t: ThrobberTarget): void {
  const active = activeMessage(t);
  if (!active) return;

  const nextEmoji = THROBBER_EMOJIS[t.idx % THROBBER_EMOJIS.length];
  const prevEmoji = active.lastEmoji;

  // Add before remove on the SAME message — keeps a reaction visible
  // throughout the cycle on the active message. Older inflight messages
  // keep whatever emoji was last placed on them; that's their "in-flight"
  // badge.
  void (async () => {
    await react(t, active.messageId, nextEmoji);
    if (prevEmoji && prevEmoji !== nextEmoji) {
      await unreact(t, active.messageId, prevEmoji);
    }
    active.lastEmoji = nextEmoji;
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
    // New inbound during an active throbber — retarget the cycling onto
    // the new message. Leave the previous target's current emoji as an
    // "in-flight" badge; stopThrobber will clear all of them when the
    // turn ends.
    if (!existing.inflight.some((m) => m.messageId === messageId)) {
      existing.inflight.push({ messageId });
    }
    existing.idx = 0;
    // Reset lastMtimeMs — wait for a fresh heartbeat AFTER this inbound
    // before cycling. The reaction signals a new API response, not a
    // stale one from before this message arrived.
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
    inflight: [{ messageId }],
    hbPath,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    watcher: null as any, // set below
    idx: 0,
    lastMtimeMs: readMtime(hbPath),
  };

  // fs.watchFile polls stat at the configured interval and fires on any
  // change. utimesSync in the container updates mtime, which fs.watch
  // (inotify IN_MODIFY) does NOT surface on Linux — so we use watchFile
  // + poll instead.
  const watcher = fs.watchFile(hbPath, { interval: WATCH_INTERVAL_MS, persistent: false }, (curr) => {
    const t = throbbers.get(sessionId);
    if (!t) return;
    if (curr.mtimeMs === 0) return; // file missing
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
  // Clear every emoji we ever placed on every in-flight message in this
  // throbber's lifetime. Try every emoji on every message — cheap and
  // covers cycle-mid-transition races where lastEmoji might not match
  // what's actually on the server.
  for (const m of t.inflight) {
    for (const emoji of THROBBER_EMOJIS) {
      void unreact(t, m.messageId, emoji);
    }
  }
  log.debug('Throbber stopped', { sessionId, inflight: t.inflight.length });
}
