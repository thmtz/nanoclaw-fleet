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
      "Create a new fleet worker. Each worker gets its own Discord channel and container. Use when the user asks for a new worker. Fire-and-forget — you'll get a system message when it's ready.",
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
      }),
    });
    log(`create_worker: ${id} → "${name}"`);
    return ok(`Creating worker "${name}". You will be notified when it is ready.`);
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

export const forkWorker: McpToolDefinition = {
  tool: {
    name: 'fork_worker',
    description:
      "Fork an existing worker into a new agent group with its own Discord channel. The fork inherits the source's workspace files, CLAUDE.local.md, container.json (backend/model), and prior message history, but starts a fresh SDK conversation so it runs independently from the source. Useful for branching at a point in a conversation to explore two paths in parallel. Pass `source: 'self'` to fork the calling agent itself. Fire-and-forget.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: {
          type: 'string',
          description: "Source worker name (or 'self' to fork the master/calling agent)",
        },
        name: { type: 'string', description: 'Name for the fork (becomes its channel + folder + destination name)' },
      },
      required: ['source', 'name'],
    },
  },
  async handler(args) {
    const source = args.source as string;
    const name = args.name as string;
    if (!source || !name) return err('source and name are required');
    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({
        action: 'fork_worker',
        requestId: id,
        source,
        name,
      }),
    });
    log(`fork_worker: ${id} → "${source}" → "${name}"`);
    return ok(`Forking "${source}" into new worker "${name}". You will be notified when it is ready.`);
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

registerTools([createWorker, destroyWorker, switchBackend, forkWorker, listWorkers]);
