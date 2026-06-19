import { describe, expect, it } from 'vitest';
import {
  buildChatPivotNavEntries,
  type ChatPivotNavEntry,
} from '@/pages/Home/lib/chatPivotNav';
import type { Message } from '@/shared/schema';

const baseConfig = {
  rows: [],
  columns: [],
  values: [],
  filters: [],
  unused: [],
};

function makeAssistantMessage(over: Partial<Message> = {}): Message {
  return {
    role: 'assistant',
    content: '',
    timestamp: Date.now() + Math.random(),
    preview: [{ a: 1 }],
    pivotAutoShow: true,
    ...over,
  } as Message;
}

describe('buildChatPivotNavEntries', () => {
  it('uses customName when set, falls back to auto-name', () => {
    const m1 = makeAssistantMessage({
      pivotState: {
        schemaVersion: 1,
        config: {
          ...baseConfig,
          rows: ['Brand'],
          values: [{ id: 'v1', field: 'Sales', agg: 'sum' as const }],
        },
      },
    } as Partial<Message>);
    const m2 = makeAssistantMessage({
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        customName: 'Q4 board view',
      },
    } as Partial<Message>);

    const entries = buildChatPivotNavEntries([m1, m2]);
    expect(entries).toHaveLength(2);
    expect(entries[0].label).toBe('Sum of Sales by Brand');
    expect(entries[1].label).toBe('Q4 board view');
  });

  it('falls back to "Pivot N" ordinal when no pivotState exists', () => {
    const m = makeAssistantMessage();
    const entries = buildChatPivotNavEntries([m]);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('Pivot 1');
    expect(entries[0].hasPivotState).toBe(false);
    expect(entries[0].pinned).toBe(false);
  });

  it('sorts pinned entries before unpinned, preserving order within groups', () => {
    const a = makeAssistantMessage({
      timestamp: 1,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        customName: 'A',
      },
    } as Partial<Message>);
    const b = makeAssistantMessage({
      timestamp: 2,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        customName: 'B',
        pinned: true,
      },
    } as Partial<Message>);
    const c = makeAssistantMessage({
      timestamp: 3,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        customName: 'C',
      },
    } as Partial<Message>);
    const d = makeAssistantMessage({
      timestamp: 4,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        customName: 'D',
        pinned: true,
      },
    } as Partial<Message>);

    const labels = (es: ChatPivotNavEntry[]) => es.map((e) => e.label);
    const entries = buildChatPivotNavEntries([a, b, c, d]);
    expect(labels(entries)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('keeps a pinned pivot in the sidebar even when no longer navigable', () => {
    // No preview rows + pivotAutoShow false → not navigable, but pinned. Without
    // the durability fix this entry would silently vanish on reload (the bug).
    const m = makeAssistantMessage({
      timestamp: 7,
      preview: [],
      pivotAutoShow: false,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        pinned: true,
      },
    } as Partial<Message>);
    const entries = buildChatPivotNavEntries([m]);
    expect(entries).toHaveLength(1);
    expect(entries[0].pinned).toBe(true);
  });

  it('keeps a renamed (customName) pivot even when not navigable', () => {
    const m = makeAssistantMessage({
      timestamp: 8,
      preview: [],
      pivotAutoShow: false,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        customName: 'My saved view',
      },
    } as Partial<Message>);
    const entries = buildChatPivotNavEntries([m]);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('My saved view');
  });

  it('still excludes a non-navigable, unpinned, unnamed pivot message', () => {
    const m = makeAssistantMessage({
      timestamp: 9,
      preview: [],
      pivotAutoShow: false,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
      },
    } as Partial<Message>);
    const entries = buildChatPivotNavEntries([m]);
    expect(entries).toHaveLength(0);
  });

  it('uses contextLabel ahead of the structural auto-name, behind customName', () => {
    const withContext = makeAssistantMessage({
      timestamp: 21,
      pivotDefaults: { contextLabel: 'Top SKUs By Q3 Value' },
      pivotState: {
        schemaVersion: 1,
        config: {
          ...baseConfig,
          rows: ['SKU'],
          values: [{ id: 'v1', field: 'Value', agg: 'sum' as const }],
        },
      },
    } as Partial<Message>);
    const userRenamed = makeAssistantMessage({
      timestamp: 22,
      pivotDefaults: { contextLabel: 'Top SKUs By Q3 Value' },
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        customName: 'My pinned view',
      },
    } as Partial<Message>);
    const [a, b] = buildChatPivotNavEntries([withContext, userRenamed]);
    expect(a.label).toBe('Top SKUs By Q3 Value'); // contextLabel beats pivotAutoName
    expect(b.label).toBe('My pinned view'); // customName beats contextLabel
  });

  it('carries messageTimestamp for handler dispatch', () => {
    const m = makeAssistantMessage({
      timestamp: 12345,
      pivotState: {
        schemaVersion: 1,
        config: { ...baseConfig },
        pinned: true,
      },
    } as Partial<Message>);
    const [entry] = buildChatPivotNavEntries([m]);
    expect(entry.messageTimestamp).toBe(12345);
    expect(entry.pinned).toBe(true);
  });
});
