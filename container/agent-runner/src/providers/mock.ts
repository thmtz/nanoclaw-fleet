import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 *
 * `toolUsesPerTurn` lets a test simulate the agent issuing tool_use
 * events before the result is yielded — used to cover dispatchResultText's
 * `send_message` auto-suppress branch.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string) => string;
  private toolUsesPerTurn: string[];

  constructor(
    _options: ProviderOptions = {},
    responseFactory?: (prompt: string) => string,
    toolUsesPerTurn?: string[],
  ) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
    this.toolUsesPerTurn = toolUsesPerTurn ?? [];
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;
    const toolUsesPerTurn = this.toolUsesPerTurn;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt
        yield { type: 'activity' };
        for (const toolName of toolUsesPerTurn) {
          yield { type: 'tool_use', tool_name: toolName };
        }
        yield { type: 'result', text: responseFactory(input.prompt) };

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            for (const toolName of toolUsesPerTurn) {
              yield { type: 'tool_use', tool_name: toolName };
            }
            yield { type: 'result', text: responseFactory(msg) };
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          for (const toolName of toolUsesPerTurn) {
            yield { type: 'tool_use', tool_name: toolName };
          }
          yield { type: 'result', text: responseFactory(msg) };
        }
      },
    };

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));
