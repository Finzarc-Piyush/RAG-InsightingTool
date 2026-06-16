import { describe, expect, it } from 'vitest';
import {
  inferNumericColumns,
  isIdLikeColumn,
  inferDateLikeColumns,
} from './columnHelpers';
import { coerceChartTypeForPersistence } from './chartKinds';

/**
 * Characterization tests pinning the behaviour of the pure helpers carved out
 * of DataPreviewTable.tsx during the god-file decomposition. They lock the
 * EXACT classification thresholds so the relocation stays behaviour-preserving.
 */
describe('inferNumericColumns', () => {
  it('classifies a column numeric when >=75% of >=2 non-empty cells parse', () => {
    const rows = [
      { qty: '10', name: 'a' },
      { qty: '20', name: 'b' },
      { qty: '30', name: 'c' },
      { qty: 'x', name: 'd' }, // 3/4 = 0.75 -> numeric
    ];
    expect(inferNumericColumns(rows, ['qty', 'name'])).toEqual(['qty']);
  });

  it('requires at least 2 non-empty samples', () => {
    const rows = [{ v: '5' }, { v: null }, { v: '' }, { v: undefined }];
    expect(inferNumericColumns(rows, ['v'])).toEqual([]);
  });

  it('drops columns just under the 0.75 ratio', () => {
    const rows = [
      { v: '1' },
      { v: '2' },
      { v: 'a' },
      { v: 'b' }, // 2/4 = 0.5
    ];
    expect(inferNumericColumns(rows, ['v'])).toEqual([]);
  });
});

describe('isIdLikeColumn', () => {
  it('matches id-shaped names case/space-insensitively', () => {
    expect(isIdLikeColumn('id')).toBe(true);
    expect(isIdLikeColumn('Customer_ID')).toBe(true);
    expect(isIdLikeColumn('Order Id')).toBe(true);
    expect(isIdLikeColumn('Product ID')).toBe(true);
  });

  it('does not match ordinary dimension names', () => {
    expect(isIdLikeColumn('Region')).toBe(false);
    expect(isIdLikeColumn('Revenue')).toBe(false);
  });
});

describe('inferDateLikeColumns', () => {
  it('classifies date columns at >=70% of >=3 samples, excluding numeric + id-like', () => {
    const rows = [
      { d: '2024-01-01', n: '1', 'Order Id': '2024-01-01' },
      { d: '2024-02-01', n: '2', 'Order Id': '2024-02-01' },
      { d: '2024-03-01', n: '3', 'Order Id': '2024-03-01' },
      { d: 'notadate', n: '4', 'Order Id': '2024-04-01' },
    ];
    const out = inferDateLikeColumns(rows, ['d', 'n', 'Order Id'], new Set(['n']));
    expect(out).toContain('d'); // 3/4 = 0.75 >= 0.7
    expect(out).not.toContain('n'); // excluded: numeric
    expect(out).not.toContain('Order Id'); // excluded: id-like name
  });

  it('requires at least 3 non-empty samples', () => {
    const rows = [{ d: '2024-01-01' }, { d: '2024-02-01' }];
    expect(inferDateLikeColumns(rows, ['d'], new Set())).toEqual([]);
  });
});

describe('coerceChartTypeForPersistence', () => {
  it('maps v2-only marks to their nearest v1 equivalent', () => {
    expect(coerceChartTypeForPersistence('donut')).toBe('pie');
    expect(coerceChartTypeForPersistence('radar')).toBe('bar');
    expect(coerceChartTypeForPersistence('bubble')).toBe('scatter');
    expect(coerceChartTypeForPersistence('waterfall')).toBe('bar');
  });

  it('passes v1 marks through unchanged', () => {
    for (const k of ['bar', 'line', 'area', 'scatter', 'pie', 'heatmap'] as const) {
      expect(coerceChartTypeForPersistence(k)).toBe(k);
    }
  });
});
