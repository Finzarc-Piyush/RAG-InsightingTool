import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import { renderInsightText, plainInsightText } from './insightText';

describe('renderInsightText', () => {
  test('bolds **data** tokens and clamps decimals to ≤2 dp', () => {
    const nodes = renderInsightText('**GT** leads at 75.86126417319149');
    const strong = nodes.find((n) => isValidElement(n));
    expect(strong).toBeTruthy();
    // The bold span wraps the data token, without the ** markers.
    expect((strong as any).props.children).toBe('GT');
    const plain = nodes.filter((n) => typeof n === 'string').join('');
    expect(plain).toContain('75.86');
    expect(plain).not.toContain('75.8612');
  });

  test('plain text passes through with decimals clamped', () => {
    const nodes = renderInsightText('value 0.6296296296296297 here');
    expect(nodes.join('')).toBe('value 0.63 here');
  });

  test('returns an empty array for nullish input', () => {
    expect(renderInsightText('')).toEqual([]);
    expect(renderInsightText(undefined)).toEqual([]);
    expect(renderInsightText(null)).toEqual([]);
  });

  test('strips an orphaned trailing asterisk', () => {
    const nodes = renderInsightText('done.*');
    expect(nodes.join('')).toBe('done.');
  });
});

describe('plainInsightText', () => {
  test('clamps decimals and strips bold markers (for already-emphasized chrome)', () => {
    expect(plainInsightText('**+12.456% YoY**')).toBe('+12.46% YoY');
  });

  test('is a no-op on nullish input', () => {
    expect(plainInsightText('')).toBe('');
    expect(plainInsightText(undefined)).toBe('');
  });
});
