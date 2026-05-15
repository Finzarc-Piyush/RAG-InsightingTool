import { describe, expect, it } from 'vitest';
import {
  targetYTickCount,
  MIN_Y_TICKS,
  MAX_Y_TICKS,
  DEFAULT_Y_TICKS,
  PX_PER_Y_TICK,
} from './yAxisTickCount';

describe('targetYTickCount', () => {
  it('returns DEFAULT_Y_TICKS when no height given', () => {
    expect(targetYTickCount()).toBe(DEFAULT_Y_TICKS);
  });

  it('returns DEFAULT_Y_TICKS for invalid heights', () => {
    expect(targetYTickCount(0)).toBe(DEFAULT_Y_TICKS);
    expect(targetYTickCount(-100)).toBe(DEFAULT_Y_TICKS);
    expect(targetYTickCount(NaN)).toBe(DEFAULT_Y_TICKS);
    expect(targetYTickCount(Infinity)).toBe(DEFAULT_Y_TICKS);
  });

  it('clamps to MIN_Y_TICKS for very short charts', () => {
    expect(targetYTickCount(50)).toBe(MIN_Y_TICKS);
    expect(targetYTickCount(100)).toBe(MIN_Y_TICKS);
    expect(targetYTickCount(150)).toBe(MIN_Y_TICKS);
  });

  it('clamps to MAX_Y_TICKS for very tall charts', () => {
    expect(targetYTickCount(1000)).toBe(MAX_Y_TICKS);
    expect(targetYTickCount(1600)).toBe(MAX_Y_TICKS);
  });

  it('produces ~one tick per PX_PER_Y_TICK in the middle range', () => {
    // 280px (PremiumChart default) → round(280/52) = 5
    expect(targetYTickCount(280)).toBe(5);
    // 460px (pivot chart container) → round(460/52) = 9
    expect(targetYTickCount(460)).toBe(9);
    // 700px (modal chart roughly) → round(700/52) = 13 → clamped to 10
    expect(targetYTickCount(700)).toBe(MAX_Y_TICKS);
    // 350px → round(350/52) = 7
    expect(targetYTickCount(350)).toBe(7);
  });

  it('honours the typography rule: never below MIN, never above MAX', () => {
    for (let h = 1; h <= 2000; h += 17) {
      const n = targetYTickCount(h);
      expect(n).toBeGreaterThanOrEqual(MIN_Y_TICKS);
      expect(n).toBeLessThanOrEqual(MAX_Y_TICKS);
    }
  });
});
