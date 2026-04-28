import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _throbberInflightForTest, setThrobberAdapter, startThrobber, stopThrobber } from './index.js';

type Call = ['add' | 'remove', string, string];

let calls: Call[];

function makeAdapter() {
  return {
    addReaction: async (
      _channelType: string,
      _platformId: string,
      _threadId: string | null,
      messageId: string,
      emoji: string,
    ): Promise<void> => {
      calls.push(['add', messageId, emoji]);
    },
    removeReaction: async (
      _channelType: string,
      _platformId: string,
      _threadId: string | null,
      messageId: string,
      emoji: string,
    ): Promise<void> => {
      calls.push(['remove', messageId, emoji]);
    },
  };
}

const SESSION = 'sess-test';
const AG = 'ag-test';
const CHANNEL_TYPE = 'discord';
const PLATFORM_ID = 'discord:guild:channel';

beforeEach(() => {
  calls = [];
  setThrobberAdapter(makeAdapter());
});

afterEach(() => {
  // Always tear down so the next test gets a fresh map. stopThrobber
  // is idempotent if no throbber is registered for this session.
  stopThrobber(SESSION);
});

describe('throbber', () => {
  it('startThrobber registers a single inflight message id', () => {
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm1');
    expect(_throbberInflightForTest(SESSION)).toEqual(['m1']);
  });

  it('retarget appends new inbound id to inflight without stripping the prior one', () => {
    // The PR #80 regression: retargeting the throbber to a newer
    // message used to unreact every emoji on the older message,
    // making older inbound messages read as silent. The fix tracks
    // every inflight message and only cycles on the latest while
    // leaving prior ones with their last emoji as an "I saw it"
    // badge until the turn ends.
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm1');
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm2');
    expect(_throbberInflightForTest(SESSION)).toEqual(['m1', 'm2']);

    // No unreact should fire on m1 just because m2 came in.
    const removesOnM1 = calls.filter((c) => c[0] === 'remove' && c[1] === 'm1');
    expect(removesOnM1).toHaveLength(0);
  });

  it('retarget is idempotent — repeating the same message id does not duplicate', () => {
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm1');
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm1');
    expect(_throbberInflightForTest(SESSION)).toEqual(['m1']);
  });

  it('stopThrobber clears reactions on every tracked inflight message', () => {
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm1');
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm2');
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm3');

    stopThrobber(SESSION);

    const removedMessageIds = new Set(calls.filter((c) => c[0] === 'remove').map((c) => c[1]));
    expect(removedMessageIds.has('m1')).toBe(true);
    expect(removedMessageIds.has('m2')).toBe(true);
    expect(removedMessageIds.has('m3')).toBe(true);

    // After stop, the throbber is gone — inflight returns undefined.
    expect(_throbberInflightForTest(SESSION)).toBeUndefined();
  });

  it('stopThrobber on an unknown session is a no-op', () => {
    expect(() => stopThrobber('sess-never-started')).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('startThrobber without an addReaction-capable adapter is a no-op', () => {
    setThrobberAdapter({}); // no addReaction
    startThrobber(SESSION, AG, CHANNEL_TYPE, PLATFORM_ID, null, 'm1');
    expect(_throbberInflightForTest(SESSION)).toBeUndefined();
  });
});
