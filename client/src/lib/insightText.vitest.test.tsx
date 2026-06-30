import { describe, expect, test } from 'vitest';
import { isValidElement } from 'react';
import {
  renderInsightText,
  plainInsightText,
  splitInsightHeadlineDetail,
  normalizeInsightText,
} from './insightText';

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

describe('splitInsightHeadlineDetail', () => {
  test('splits once at the first em-dash into headline + detail', () => {
    const { headline, detail } = splitInsightHeadlineDetail(
      '**CSD** has the lowest **GC %** at **28.1%** — **CSD** is the bottom channel at **28.05**',
    );
    expect(headline).toBe('**CSD** has the lowest **GC %** at **28.1%**');
    expect(detail).toBe('**CSD** is the bottom channel at **28.05**');
  });

  test('only the FIRST em-dash splits — later ones stay in the detail', () => {
    const { headline, detail } = splitInsightHeadlineDetail('Headline — part a — part b');
    expect(headline).toBe('Headline');
    expect(detail).toBe('part a — part b');
  });

  test('strips a leading bullet glyph the model sometimes emits', () => {
    expect(splitInsightHeadlineDetail('* GT has the highest GC %').headline).toBe(
      'GT has the highest GC %',
    );
    expect(splitInsightHeadlineDetail('- a — b')).toEqual({ headline: 'a', detail: 'b' });
  });

  test('no separator → whole string is the headline, no detail', () => {
    expect(splitInsightHeadlineDetail('GT leads at 63.4%')).toEqual({
      headline: 'GT leads at 63.4%',
    });
  });

  test('a fully-bolded insight never yields more than two parts (fragmentation regression)', () => {
    const heavy =
      '**CSD** has the lowest **GC %** at **28.1%** — **CSD** is the bottom **channel** below **GT** and **MT B2C**';
    const { headline, detail } = splitInsightHeadlineDetail(heavy);
    // Exactly two render lines, regardless of how many bold tokens are present.
    expect(headline.length).toBeGreaterThan(0);
    expect(detail && detail.length).toBeGreaterThan(0);
  });

  test('is safe on nullish input', () => {
    expect(splitInsightHeadlineDetail('')).toEqual({ headline: '' });
    expect(splitInsightHeadlineDetail(undefined)).toEqual({ headline: '' });
  });
});

describe('normalizeInsightText', () => {
  test('two strings differing only in bold markers / whitespace / case are equal', () => {
    expect(normalizeInsightText('**GT** leads  at 63.4%')).toBe(
      normalizeInsightText('gt leads at 63.4%'),
    );
  });

  test('genuinely different insights normalize differently', () => {
    expect(normalizeInsightText('GT leads')).not.toBe(normalizeInsightText('CSD trails'));
  });
});
