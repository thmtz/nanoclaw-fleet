/**
 * Hysteresis tests for resource-monitor's threshold evaluator. Pure
 * function — no DB, no docker, no os.
 */
import { describe, it, expect } from 'vitest';

import { evaluateThresholds, type MonitorState } from './index.js';

function metrics(over: { mem?: number; disk?: number; containers?: number; max?: number } = {}): {
  memoryPercent: number;
  memoryUsedGB: number;
  memoryTotalGB: number;
  diskPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  containerCount: number;
  containerMax: number;
  containerPercent: number;
} {
  const containerMax = over.max ?? 5;
  const containerCount = over.containers ?? 0;
  return {
    memoryPercent: over.mem ?? 0,
    memoryUsedGB: 0,
    memoryTotalGB: 0,
    diskPercent: over.disk ?? 0,
    diskUsedGB: 0,
    diskTotalGB: 0,
    containerCount,
    containerMax,
    containerPercent: Math.round((containerCount / containerMax) * 100),
  };
}

describe('evaluateThresholds', () => {
  it('fires memory alert when crossing 80%, then clears at <70%', () => {
    const state: MonitorState = { active: new Set() };

    // Below alert: nothing
    let r = evaluateThresholds(state, metrics({ mem: 75 }));
    expect(r.messages).toEqual([]);
    state.active = r.nextActive;

    // Cross alert
    r = evaluateThresholds(state, metrics({ mem: 81 }));
    expect(r.messages.some((m) => m.includes('Memory at 81%'))).toBe(true);
    expect(r.nextActive.has('memoryPercent')).toBe(true);
    state.active = r.nextActive;

    // Stay above alert (still in alert band) — no repeat
    r = evaluateThresholds(state, metrics({ mem: 85 }));
    expect(r.messages).toEqual([]);
    state.active = r.nextActive;

    // Drop below alert but above clear (still in alert band) — no clear yet
    r = evaluateThresholds(state, metrics({ mem: 75 }));
    expect(r.messages).toEqual([]);
    expect(r.nextActive.has('memoryPercent')).toBe(true);
    state.active = r.nextActive;

    // Cross clear
    r = evaluateThresholds(state, metrics({ mem: 65 }));
    expect(r.messages.some((m) => m.includes('Memory back'))).toBe(true);
    expect(r.nextActive.has('memoryPercent')).toBe(false);
  });

  it('fires container alert when crossing 80% of max', () => {
    const state: MonitorState = { active: new Set() };

    // 4/5 = 80% — at threshold, alert fires
    let r = evaluateThresholds(state, metrics({ containers: 4, max: 5 }));
    expect(r.messages.some((m) => m.includes('Containers at 4/5'))).toBe(true);
    state.active = r.nextActive;

    // 3/5 = 60% — AT clear threshold (which is `< 60`), no clear yet
    r = evaluateThresholds(state, metrics({ containers: 3, max: 5 }));
    expect(r.messages).toEqual([]);
    state.active = r.nextActive;

    // 2/5 = 40% — below clear, fires
    r = evaluateThresholds(state, metrics({ containers: 2, max: 5 }));
    expect(r.messages.some((m) => m.includes('Containers back'))).toBe(true);
  });

  it('fires multiple alerts in one tick when multiple metrics cross', () => {
    const state: MonitorState = { active: new Set() };
    const r = evaluateThresholds(state, metrics({ mem: 90, disk: 85, containers: 5, max: 5 }));
    expect(r.messages.length).toBe(3);
    expect(r.messages.some((m) => m.includes('Memory'))).toBe(true);
    expect(r.messages.some((m) => m.includes('Disk'))).toBe(true);
    expect(r.messages.some((m) => m.includes('Containers'))).toBe(true);
  });

  it('does not refire after the metric stays in the alert band', () => {
    const state: MonitorState = { active: new Set() };
    let r = evaluateThresholds(state, metrics({ mem: 90 }));
    expect(r.messages).toHaveLength(1);
    state.active = r.nextActive;
    r = evaluateThresholds(state, metrics({ mem: 92 }));
    expect(r.messages).toEqual([]);
    r = evaluateThresholds(state, metrics({ mem: 95 }));
    expect(r.messages).toEqual([]);
  });
});
