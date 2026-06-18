import { describe, expect, test } from 'vitest';
import { cleanEvidenceNumbers } from './cleanEvidenceNumbers';

describe('cleanEvidenceNumbers', () => {
  test('rounds a long repr() decimal to 4 dp', () => {
    expect(cleanEvidenceNumbers('survival_rate = 0.6296296296296297')).toBe(
      'survival_rate = 0.6296'
    );
  });

  test('leaves percentages, short decimals, integers, years and IDs alone', () => {
    const s = 'Rate 62.96% across 891 rows in 2024 for SKU 12.5; id 100345';
    expect(cleanEvidenceNumbers(s)).toBe(s);
  });

  test('handles multiple long decimals and negatives', () => {
    expect(cleanEvidenceNumbers('a -0.123456789 and 1.999999999')).toBe('a -0.1235 and 2');
  });

  test('is a no-op on empty / undefined-ish input', () => {
    expect(cleanEvidenceNumbers('')).toBe('');
  });
});
