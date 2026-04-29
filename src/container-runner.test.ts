/**
 * Unit tests for container-runner helpers. Currently only covers
 * `pickOauthToken` — the OAuth precedence that prevents the regression
 * where workers 401 hours after spawn because they were baked with a
 * since-rotated short-lived token instead of the long-lived `.env` one.
 */
import { describe, it, expect } from 'vitest';

import { pickOauthToken } from './container-runner.js';

describe('pickOauthToken', () => {
  it('prefers .env over credentials.json when both are set', () => {
    expect(pickOauthToken({ envToken: 'long-lived-env', liveToken: 'short-lived-live' })).toEqual({
      token: 'long-lived-env',
      source: '.env',
    });
  });

  it('falls back to credentials.json when .env is empty', () => {
    expect(pickOauthToken({ envToken: undefined, liveToken: 'short-lived-live' })).toEqual({
      token: 'short-lived-live',
      source: 'credentials.json',
    });
  });

  it('returns none when neither is set', () => {
    expect(pickOauthToken({ envToken: undefined, liveToken: undefined })).toEqual({
      token: undefined,
      source: 'none',
    });
  });

  it('treats empty string .env token as unset (so we still try credentials.json)', () => {
    expect(pickOauthToken({ envToken: '', liveToken: 'short-lived-live' })).toEqual({
      token: 'short-lived-live',
      source: 'credentials.json',
    });
  });
});
