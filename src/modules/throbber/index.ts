/**
 * Throbber module — cycles a reaction emoji on the user's incoming
 * message while the agent is working, so the user sees the agent is
 * alive and processing even before the first outbound text lands.
 *
 * Mirrors the typing module pattern: per-session state, heartbeat-gated
 * refresh, adapter binding on startup, cleared when a user-facing
 * message is delivered.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';

const THROBBER_EMOJIS = ['🔵', '🟦', '🔷'];
const THROBBER_CYCLE_MS = 2000;
/**
 * Grace window from startThrobber: react unconditionally for this long
 * regardless of heartbeat state. Covers container spawn/wake latency
 * (5–12s cold start before the first heartbeat).
 */
const THROBBER_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this many
 * ms of now to keep cycling. Heartbeats land every few hundred ms
 * during active work, so 6s is well above the working floor and small
 * enough to stop the throbber quickly when the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;

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
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
  idx: number;
  interval: NodeJS.Timeout;
  startedAt: number;
  active: boolean;
}

let adapter: ReactionAdapter | null = null;
const throbbers = new Map<string, ThrobberTarget>();

/** Bind the throbber module to the channel delivery adapter. Called
 *  once from src/delivery.ts inside setDeliveryAdapter. */
export function setThrobberAdapter(a: ReactionAdapter): void {
  adapter = a;
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
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

function cycle(sessionId: string): void {
  const t = throbbers.get(sessionId);
  if (!t) return;

  const withinGrace = Date.now() - t.startedAt < THROBBER_GRACE_MS;
  if (!withinGrace && !isHeartbeatFresh(t.agentGroupId, sessionId)) {
    // Agent idle — stop cycling.
    clearInterval(t.interval);
    throbbers.delete(sessionId);
    if (t.active) {
      for (const emoji of THROBBER_EMOJIS) {
        void unreact(t, emoji);
      }
    }
    return;
  }

  const prevEmoji = THROBBER_EMOJIS[(t.idx - 1 + THROBBER_EMOJIS.length) % THROBBER_EMOJIS.length];
  const nextEmoji = THROBBER_EMOJIS[t.idx % THROBBER_EMOJIS.length];

  // Add before remove — keeps reaction count >= 1 so the message doesn't
  // visually jump from having reactions to none.
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
    // New inbound message on an already-running throbber — retarget onto
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
    existing.startedAt = Date.now();
    cycle(sessionId);
    return;
  }

  const t: ThrobberTarget = {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    messageId,
    idx: 0,
    interval: setInterval(() => cycle(sessionId), THROBBER_CYCLE_MS),
    startedAt: Date.now(),
    active: false,
  };
  t.interval.unref();
  throbbers.set(sessionId, t);
  // First reaction immediately — don't wait 2s.
  cycle(sessionId);
  log.debug('Throbber started', { sessionId, messageId });
}

export function stopThrobber(sessionId: string): void {
  const t = throbbers.get(sessionId);
  if (!t) return;
  clearInterval(t.interval);
  throbbers.delete(sessionId);
  if (!t.active) return;
  // Clear all possible emojis — in case a cycle raced mid-transition.
  for (const emoji of THROBBER_EMOJIS) {
    void unreact(t, emoji);
  }
  log.debug('Throbber stopped', { sessionId });
}
