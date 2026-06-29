import { describe, expect, test } from 'vitest';
import { clampInsightDecimals, cleanEvidenceNumbers } from './cleanEvidenceNumbers';

describe('clampInsightDecimals', () => {
  test('clamps a long repr() decimal to 2 dp', () => {
    expect(clampInsightDecimals('survival_rate = 0.6296296296296297')).toBe(
      'survival_rate = 0.63'
    );
  });

  test('clamps a machine-precision currency leak to 2 dp', () => {
    expect(clampInsightDecimals('PCNO(R) contributes 75.86126417319149 Rs Cr')).toBe(
      'PCNO(R) contributes 75.86 Rs Cr'
    );
  });

  test('leaves percentages, short decimals, integers and years alone', () => {
    const s = 'Rate 62.96% across 891 rows in 2024 for SKU 12.5; id 100345';
    expect(clampInsightDecimals(s)).toBe(s);
  });

  test('does not rewrite dotted IDs / versions', () => {
    expect(clampInsightDecimals('session_1.23456 on v1.2.345')).toBe('session_1.23456 on v1.2.345');
  });

  test('handles multiple long decimals and negatives', () => {
    expect(clampInsightDecimals('a -0.123456789 and 1.999999999')).toBe('a -0.12 and 2');
  });

  test('is a no-op on empty input', () => {
    expect(clampInsightDecimals('')).toBe('');
  });

  test('cleanEvidenceNumbers alias points at the same clamp', () => {
    expect(cleanEvidenceNumbers('x = 0.6296296296296297')).toBe('x = 0.63');
  });
});
