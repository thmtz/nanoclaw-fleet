/**
 * Fleet MCP tools — master-only lifecycle ops for worker agent groups.
 *
 * All four tools are fire-and-forget EXCEPT list_workers, which synchronously
 * reads the central DB via the host through a `messages_out` query... but
 * the container can't read central DB, so list_workers instead emits a
 * system action and blocks on the response. Simpler for MVP: make
 * list_workers emit a request and the host writes a messages_in with
 * the data, then the agent-runner returns it to the agent via tool result.
 *
 * UPDATE (MVP): to avoid building a request/response correlation layer
 * just for list_workers, it's emitted as system action 'list_workers_request'
 * and the host writes the result as a normal chat message back. The tool
 * returns immediately with "asked; see next message". Good enough for the
 * prototype — a future iteration can add a proper tool-call-in-flight
 * correlation like ask_user_question uses.
 *
 * Gating: this module is only imported by the barrel when
 * NANOCLAW_FLEET_ROLE=master is set on the container. Non-master containers
 * never see these tools.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools/fleet] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const createWorker: McpToolDefinition = {
  tool: {
    name: 'create_worker',
    description:
      "Create a new fleet worker. Each worker gets its own Discord channel and container. Fire-and-forget — you'll get a system message when it's ready.\n\nResume vs fresh: if a worker with the requested name was previously destroyed (status='archived'), the default behavior is to RESUME from archive — workspace files, CLAUDE.local.md, and prior conversation history come back. Backend/model can change on resume.\n\nWhen the user asks for a fresh / clean / new-from-scratch worker on a name that has archived history, you MUST first confirm with them that the prior workspace + conversation history will be PERMANENTLY DELETED, then call this tool with `fresh: true`. Setting fresh=true silently destroys the prior state — there is no undo. Skip the confirmation only when the user explicitly asked for fresh AND acknowledged the data loss in the same message.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Worker name (becomes channel name, folder name, and destination name)' },
        backend: {
          type: 'string',
          description:
            "Provider name — 'claude' (default) or any installed provider skill (neuralwatt, opencode, codex, ollama).",
        },
        model: { type: 'string', description: 'Model identifier for the selected backend. Optional.' },
        instructions: {
          type: 'string',
          description: 'Seed CLAUDE.local.md for the new worker — personality, role, tooling hints.',
        },
        fresh: {
          type: 'boolean',
          description:
            'Force a clean slate even if an archived worker with this name exists. PERMANENTLY DELETES the prior workspace + session history. Confirm with the user FIRST. Default false (resume from archive when one exists).',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');
    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({
        action: 'create_worker',
        requestId: id,
        name,
        backend: args.backend ?? null,
        model: args.model ?? null,
        instructions: args.instructions ?? null,
        fresh: args.fresh === true,
      }),
    });
    log(`create_worker: ${id} → "${name}"${args.fresh ? ' (fresh)' : ''}`);
    return ok(
      `Creating worker "${name}"${args.fresh ? ' (fresh — purging any archived prior)' : ''}. You will be notified when it is ready.`,
    );
  },
};

export const destroyWorker: McpToolDefinition = {
  tool: {
    name: 'destroy_worker',
    description:
      'Destroy a fleet worker. Stops the container, archives the agent group (workspace and conversation preserved), and deletes its Discord channel by default. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Worker name' },
        delete_channel: {
          type: 'boolean',
          description: 'Delete the Discord channel too (default true). Set false to keep the channel for audit.',
        },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!name) return err('name is required');
    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({
        action: 'destroy_worker',
        requestId: id,
        name,
        delete_channel: args.delete_channel ?? true,
      }),
    });
    log(`destroy_worker: ${id} → "${name}"`);
    return ok(`Destroying worker "${name}". You will be notified when done.`);
  },
};

export const switchBackend: McpToolDefinition = {
  tool: {
    name: 'switch_backend',
    description:
      'Switch a worker to a different inference backend and/or model. Preserves workspace and conversation. Container restarts on next message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Worker name' },
        backend: { type: 'string', description: "Provider name (e.g. 'claude', 'neuralwatt', 'opencode')" },
        model: { type: 'string', description: 'Model identifier for the backend. Optional.' },
      },
      required: ['name', 'backend'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const backend = args.backend as string;
    if (!name || !backend) return err('name and backend are required');
    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({
        action: 'switch_backend',
        requestId: id,
        name,
        backend,
        model: args.model ?? null,
      }),
    });
    log(`switch_backend: ${id} → "${name}" → ${backend}`);
    return ok(
      `Switching worker "${name}" to ${backend}${args.model ? ` (${args.model})` : ''}. Will take effect on next message.`,
    );
  },
};

export const listWorkers: McpToolDefinition = {
  tool: {
    name: 'list_workers',
    description:
      'Request a list of all fleet workers. The host will write a chat message with the list — watch for it in your next batch.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({ action: 'list_workers_request', requestId: id }),
    });
    return ok('Worker list requested. The host will respond with the data in your next message batch.');
  },
};

export const cleanupWorkers: McpToolDefinition = {
  tool: {
    name: 'cleanup_workers',
    description:
      'Reconcile fleet state and clean up orphans: orphan Discord channels (no agent_group) and orphan containers (no active agent_group) are auto-cleaned; orphan workers (active agent_group with missing Discord channel) are reported back to you so you can decide. Pass dry_run=true to preview without changes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dry_run: { type: 'boolean', description: 'Report only, no changes. Defaults to false.' },
      },
    },
  },
  async handler(args) {
    const dryRun = args.dry_run === true;
    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({ action: 'cleanup_workers', requestId: id, dry_run: dryRun }),
    });
    log(`cleanup_workers: ${id} (dry_run=${dryRun})`);
    return ok(
      dryRun
        ? 'Cleanup dry-run requested. The host will reply with the reconciliation report.'
        : 'Cleanup requested. The host will reply with what was cleaned + any orphan workers needing your decision.',
    );
  },
};

registerTools([createWorker, destroyWorker, switchBackend, listWorkers, cleanupWorkers]);
