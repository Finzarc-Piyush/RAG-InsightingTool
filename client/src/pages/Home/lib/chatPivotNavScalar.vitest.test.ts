import { describe, expect, it } from 'vitest';
import { computeAllowPivotAutoShow } from '@/pages/Home/lib/chatPivotNav';
import type { Message } from '@/shared/schema';

function assistant(over: Partial<Message> = {}): Message {
  return {
    role: 'assistant',
    content: 'The average shipping time is 3.96 days.',
    timestamp: Date.now() + Math.random(),
    ...over,
  } as Message;
}

describe('computeAllowPivotAutoShow · scalar suppression', () => {
  it('returns false when server set pivotAutoShow=false AND no pivotDefaults (scalar answer)', () => {
    const m = assistant({
      pivotAutoShow: false,
      preview: [{ 'Shipping Time (Days)': 3.96 }],
    } as Partial<Message>);
    expect(computeAllowPivotAutoShow(m)).toBe(false);
  });

  it('still returns true when pivotAutoShow=false but pivotDefaults are present (e.g. legacy/explicit defaults)', () => {
    const m = assistant({
      pivotAutoShow: false,
      preview: [{ Region: 'East', Sales: 100 }],
      pivotDefaults: { rows: ['Region'], values: ['Sales'] },
    } as Partial<Message>);
    expect(computeAllowPivotAutoShow(m)).toBe(true);
  });

  it('returns true when pivotAutoShow is undefined and preview rows exist (legacy unchanged)', () => {
    const m = assistant({
      preview: [{ a: 1 }],
    } as Partial<Message>);
    expect(computeAllowPivotAutoShow(m)).toBe(true);
  });

  it('returns true when pivotAutoShow=true (server hint wins)', () => {
    const m = assistant({
      pivotAutoShow: true,
      preview: [{ a: 1 }],
    } as Partial<Message>);
    expect(computeAllowPivotAutoShow(m)).toBe(true);
  });
});
