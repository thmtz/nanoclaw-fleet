/**
 * Unit tests for the neuralwatt model resolver. Mocks global fetch so we
 * can exercise the success / 404 / 503 / connect-error paths without a
 * live shim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelResolutionError, resolveModelForBackend } from './model-resolver.js';

const realFetch = globalThis.fetch;

function mockFetch(impl: (url: string) => Promise<Response> | Response): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return await impl(url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.NW_SHIM_HOST_URL = 'http://shim.test';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.NW_SHIM_HOST_URL;
  vi.restoreAllMocks();
});

describe('resolveModelForBackend', () => {
  it('returns undefined when no model is supplied', async () => {
    expect(await resolveModelForBackend('neuralwatt', undefined)).toBeUndefined();
    expect(await resolveModelForBackend('neuralwatt', '')).toBeUndefined();
    expect(await resolveModelForBackend('neuralwatt', '   ')).toBeUndefined();
  });

  it('passes claude models through without hitting the shim', async () => {
    mockFetch(() => {
      throw new Error('shim should not be called for claude');
    });
    expect(await resolveModelForBackend('claude', 'opus-4.7')).toBe('opus-4.7');
  });

  it('returns canonical id from the shim on a fuzzy match', async () => {
    mockFetch((url) => {
      expect(url).toBe('http://shim.test/models/resolve/GLM-5.1');
      return new Response(
        JSON.stringify({ model: 'zai-org/GLM-5.1-FP8', match: 'fuzzy', candidates: ['zai-org/GLM-5.1-FP8'] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    expect(await resolveModelForBackend('neuralwatt', 'GLM-5.1')).toBe('zai-org/GLM-5.1-FP8');
  });

  it('throws ModelResolutionError with candidates on 404', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'no match for "bogus"', available: ['glm-5-fast', 'kimi-k2.6-fast'] }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(resolveModelForBackend('neuralwatt', 'bogus')).rejects.toBeInstanceOf(ModelResolutionError);
  });

  it('throws ModelResolutionError on 503 (shim catalogue empty)', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'no models available' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(resolveModelForBackend('neuralwatt', 'kimi')).rejects.toThrow(ModelResolutionError);
  });

  it('throws ModelResolutionError when the shim is unreachable', async () => {
    mockFetch(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3003');
    });
    await expect(resolveModelForBackend('neuralwatt', 'kimi')).rejects.toMatchObject({
      name: 'ModelResolutionError',
    });
  });

  // Regression: a hung shim (accepting connections but not responding) used
  // to block the fleet handler indefinitely. The resolver now applies an
  // AbortSignal.timeout, and on abort throws ModelResolutionError with a
  // timeout-flavored message instead of propagating the raw TimeoutError
  // (which the handler can't categorize).
  it('throws ModelResolutionError with a timeout message when fetch aborts', async () => {
    mockFetch(() => {
      // Simulate what the platform throws when AbortSignal.timeout fires —
      // skip the real wall-clock wait so the test stays fast.
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    await expect(resolveModelForBackend('neuralwatt', 'kimi')).rejects.toMatchObject({
      name: 'ModelResolutionError',
      message: expect.stringContaining('did not respond within'),
    });
  });
});
