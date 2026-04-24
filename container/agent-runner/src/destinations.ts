/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  // Single-destination shortcut: the agent just writes its response normally.
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    return [
      '## Sending messages',
      '',
      `Your messages are delivered to \`${d.name}\`${label}. Just write your response directly — no special wrapping needed.`,
      '',
      'To mark something as scratchpad (logged but not sent), wrap it in `<internal>...</internal>`.',
      '',
      'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool.',
    ].join('\n');
  }

  // Figure out the origin destination — whichever one matches the latest
  // session_routing. That's the channel the user is actually chatting
  // with us in, and the default reply target. Without this hint the SDK
  // regularly picks an agent-typed destination (e.g. `master`) when the
  // user asks "hi" in a Discord channel, routing the reply to the
  // master agent where the user can't see it.
  const db = getInboundDb();
  let originName: string | undefined;
  try {
    const routing = db
      .prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1')
      .get() as { channel_type: string | null; platform_id: string | null } | undefined;
    if (routing?.channel_type && routing?.platform_id) {
      const originRow = db
        .prepare(
          "SELECT name FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?",
        )
        .get(routing.channel_type, routing.platform_id) as { name: string } | undefined;
      originName = originRow?.name;
    }
  } catch {
    // fall through — session_routing or destinations table missing on
    // very old session DBs. Default guidance still fires.
  }

  const lines: string[] = ['## Sending messages', ''];

  // When the turn started from a real channel (Discord etc.), strongly
  // bias toward plain-text replies that flow back to that channel via
  // the scratchpad → session_routing path. Listing `<message to=...>`
  // without this rule has repeatedly caused workers to stamp their
  // reply with `to="master"` — routing it to the master agent where
  // the real user (in Discord) never sees it.
  if (originName) {
    lines.push(
      `**You are chatting with a user in \`${originName}\`.** Write your reply as plain text — no wrappers needed. It goes straight back to that chat.`,
      '',
      `Other destinations below are for **explicit cross-agent coordination only**. Do NOT wrap your reply to the user in a \`<message to="...">\` block — the user will never see it.`,
      '',
      '### Available destinations',
      '',
    );
  } else {
    lines.push('You can send messages to the following destinations:', '');
  }

  for (const d of all) {
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    const marker = d.name === originName ? ' ← **origin chat — plain text goes here**' : '';
    lines.push(`- \`${d.name}\`${label}${marker}`);
  }
  lines.push('');

  if (originName) {
    lines.push(
      `To address a **different** destination (cross-agent handoff, escalation), wrap that one message in \`<message to="other-name">...</message>\`. Plain text outside any block still goes to the origin chat (\`${originName}\`).`,
    );
  } else {
    lines.push('To send a message, wrap it in a `<message to="name">...</message>` block.');
    lines.push('You can include multiple `<message>` blocks in one response to send to multiple destinations.');
    lines.push('Text outside of `<message>` blocks is scratchpad — logged but not sent anywhere.');
  }
  lines.push('Use `<internal>...</internal>` to mark reasoning as scratchpad (logged, not sent).');
  lines.push('');
  lines.push(
    'To send a message mid-response (e.g., an acknowledgment before a long task), call the `send_message` MCP tool with the `to` parameter set to a destination name.',
  );
  return lines.join('\n');
}
