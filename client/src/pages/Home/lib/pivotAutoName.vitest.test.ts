import { describe, expect, it } from 'vitest';
import { pivotAutoName } from '@/pages/Home/lib/pivotAutoName';

type Cfg = NonNullable<Parameters<typeof pivotAutoName>[0]>;

const make = (over: Partial<Cfg> = {}): Cfg => ({
  rows: [],
  columns: [],
  values: [],
  filters: [],
  unused: [],
  ...over,
});

describe('pivotAutoName', () => {
  it('returns null for null/undefined config', () => {
    expect(pivotAutoName(null)).toBeNull();
    expect(pivotAutoName(undefined)).toBeNull();
  });

  it('"Empty pivot" when nothing is set', () => {
    expect(pivotAutoName(make())).toBe('Empty pivot');
  });

  it('counts when only dimensions are set', () => {
    expect(
      pivotAutoName(make({ rows: ['Brand'], columns: ['Quarter'] }))
    ).toBe('Count by Brand × Quarter');
  });

  it('formats single value with no dims', () => {
    expect(
      pivotAutoName(
        make({ values: [{ id: 'v1', field: 'Sales', agg: 'sum' }] })
      )
    ).toBe('Sum of Sales');
  });

  it('formats single value by rows', () => {
    expect(
      pivotAutoName(
        make({
          rows: ['Brand'],
          values: [{ id: 'v1', field: 'Sales', agg: 'sum' }],
        })
      )
    ).toBe('Sum of Sales by Brand');
  });

  it('formats single value by rows × columns', () => {
    expect(
      pivotAutoName(
        make({
          rows: ['Brand'],
          columns: ['Quarter'],
          values: [{ id: 'v1', field: 'Sales', agg: 'sum' }],
        })
      )
    ).toBe('Sum of Sales by Brand × Quarter');
  });

  it('formats single value with columns only (no rows)', () => {
    expect(
      pivotAutoName(
        make({
          columns: ['Quarter'],
          values: [{ id: 'v1', field: 'Sales', agg: 'mean' }],
        })
      )
    ).toBe('Avg of Sales × Quarter');
  });

  it('multi-value with dims uses N-measures shape', () => {
    expect(
      pivotAutoName(
        make({
          rows: ['Brand'],
          values: [
            { id: 'v1', field: 'Sales', agg: 'sum' },
            { id: 'v2', field: 'Volume', agg: 'sum' },
          ],
        })
      )
    ).toBe('2 measures by Brand');
  });

  it('multi-value with no dims lists fields', () => {
    expect(
      pivotAutoName(
        make({
          values: [
            { id: 'v1', field: 'Sales', agg: 'sum' },
            { id: 'v2', field: 'Volume', agg: 'sum' },
            { id: 'v3', field: 'Margin', agg: 'mean' },
          ],
        })
      )
    ).toBe('Sales, Volume, +1 more');
  });

  it('truncates very long names with ellipsis', () => {
    const longField = 'A'.repeat(100);
    const out = pivotAutoName(
      make({ values: [{ id: 'v1', field: longField, agg: 'sum' }] })
    );
    expect(out!.length).toBeLessThanOrEqual(64);
    expect(out!.endsWith('…')).toBe(true);
  });
});
