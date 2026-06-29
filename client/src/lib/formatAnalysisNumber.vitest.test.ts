import { describe, expect, test } from 'vitest';
import { formatAnalysisNumber } from './formatAnalysisNumber';

describe('formatAnalysisNumber', () => {
  test('caps small values at 2 decimals, dropping trailing zeros', () => {
    expect(formatAnalysisNumber(5.11883)).toBe('5.12');
    expect(formatAnalysisNumber(2.557216)).toBe('2.56');
    expect(formatAnalysisNumber(2.30949)).toBe('2.31');
    expect(formatAnalysisNumber(2.5)).toBe('2.5');
  });

  test('rounds |n| ≥ 10 to whole numbers (existing behaviour)', () => {
    expect(formatAnalysisNumber(149)).toBe('149');
    expect(formatAnalysisNumber(75.86)).toBe('76');
  });

  test('handles zero and non-finite gracefully', () => {
    expect(formatAnalysisNumber(0)).toBe('0');
    expect(formatAnalysisNumber(NaN)).toBe('NaN');
  });
});
