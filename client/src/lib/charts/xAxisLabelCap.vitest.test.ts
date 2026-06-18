import { describe, expect, it } from 'vitest';
import {
  maxXAxisLabels,
  pickEvenlySpacedTicks,
  echartsLabelInterval,
  MIN_X_AXIS_LABELS,
  ABS_MAX_X_AXIS_LABELS,
  DEFAULT_MAX_X_AXIS_LABELS,
} from './xAxisLabelCap';

describe('maxXAxisLabels', () => {
  it('falls back to the default budget when width is unknown/invalid', () => {
    expect(maxXAxisLabels()).toBe(DEFAULT_MAX_X_AXIS_LABELS);
    expect(maxXAxisLabels({})).toBe(DEFAULT_MAX_X_AXIS_LABELS);
    expect(maxXAxisLabels({ axisWidthPx: 0 })).toBe(DEFAULT_MAX_X_AXIS_LABELS);
    expect(maxXAxisLabels({ axisWidthPx: -100 })).toBe(DEFAULT_MAX_X_AXIS_LABELS);
    expect(maxXAxisLabels({ axisWidthPx: NaN })).toBe(DEFAULT_MAX_X_AXIS_LABELS);
    expect(maxXAxisLabels({ axisWidthPx: Infinity })).toBe(DEFAULT_MAX_X_AXIS_LABELS);
  });

  it('is NOT a fixed number — a wide axis with short labels shows well above 10', () => {
    const n = maxXAxisLabels({
      axisWidthPx: 1000,
      labels: ['Q1', 'Q2', 'Q3', 'Q4'],
      fontSizePx: 11,
      rotationDeg: 0,
    });
    expect(n).toBeGreaterThan(DEFAULT_MAX_X_AXIS_LABELS);
    expect(n).toBeLessThanOrEqual(ABS_MAX_X_AXIS_LABELS);
  });

  it('shows fewer labels when the labels are long (horizontal)', () => {
    const short = maxXAxisLabels({ axisWidthPx: 600, labels: ['2021'], fontSizePx: 11 });
    const long = maxXAxisLabels({
      axisWidthPx: 600,
      labels: ['North-East Premium Segment'],
      fontSizePx: 11,
    });
    expect(long).toBeLessThan(short);
    expect(long).toBeGreaterThanOrEqual(MIN_X_AXIS_LABELS);
  });

  it('never returns fewer than MIN or more than the absolute guard', () => {
    // Very narrow axis + very long labels -> clamps up to MIN.
    expect(
      maxXAxisLabels({ axisWidthPx: 120, labels: ['a very long category label here'], fontSizePx: 12 }),
    ).toBe(MIN_X_AXIS_LABELS);
    // Very wide axis + 1-char labels -> clamps down to the absolute guard.
    expect(
      maxXAxisLabels({ axisWidthPx: 100000, labels: ['x'], fontSizePx: 10 }),
    ).toBe(ABS_MAX_X_AXIS_LABELS);
  });

  it('is monotonic in width (wider axis => at least as many labels)', () => {
    const narrow = maxXAxisLabels({ axisWidthPx: 400, labels: ['Jan'], fontSizePx: 11 });
    const wide = maxXAxisLabels({ axisWidthPx: 800, labels: ['Jan'], fontSizePx: 11 });
    expect(wide).toBeGreaterThanOrEqual(narrow);
  });

  it('never returns NaN/out-of-range for invalid numeric inputs (contract holds)', () => {
    const cases = [
      { axisWidthPx: 600, avgLabelChars: NaN },
      { axisWidthPx: 600, avgLabelChars: -5 },
      { axisWidthPx: 600, avgLabelChars: Infinity },
      { axisWidthPx: 600, fontSizePx: NaN },
      { axisWidthPx: 600, fontSizePx: Infinity },
      { axisWidthPx: 600, minGapPx: NaN },
      { axisWidthPx: 600, rotationDeg: NaN },
      { axisWidthPx: 600, rotationDeg: Infinity },
    ];
    for (const opts of cases) {
      const n = maxXAxisLabels(opts);
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(MIN_X_AXIS_LABELS);
      expect(n).toBeLessThanOrEqual(ABS_MAX_X_AXIS_LABELS);
    }
  });

  describe('rotated labels', () => {
    it('fits more than the old fixed 10 on a wide modal axis', () => {
      const n = maxXAxisLabels({ axisWidthPx: 900, fontSizePx: 10, rotationDeg: -45 });
      expect(n).toBeGreaterThan(DEFAULT_MAX_X_AXIS_LABELS);
    });

    it('footprint is independent of label text length (rotation, not width, governs)', () => {
      const tiny = maxXAxisLabels({
        axisWidthPx: 600,
        fontSizePx: 10,
        rotationDeg: -45,
        labels: ['a'],
      });
      const huge = maxXAxisLabels({
        axisWidthPx: 600,
        fontSizePx: 10,
        rotationDeg: -45,
        labels: ['an extremely long rotated category label'],
      });
      expect(huge).toBe(tiny);
    });

    it('a small tile still yields a sensible (legible) budget', () => {
      const n = maxXAxisLabels({ axisWidthPx: 250, fontSizePx: 10, rotationDeg: -45 });
      expect(n).toBeGreaterThanOrEqual(MIN_X_AXIS_LABELS);
      expect(n).toBeLessThanOrEqual(DEFAULT_MAX_X_AXIS_LABELS);
    });
  });
});

describe('pickEvenlySpacedTicks', () => {
  it('returns all values when count <= max', () => {
    expect(pickEvenlySpacedTicks([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('thins to at most `max` values, keeping the first', () => {
    const out = pickEvenlySpacedTicks([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out[0]).toBe(0);
  });

  it('handles degenerate maxes', () => {
    expect(pickEvenlySpacedTicks([], 5)).toEqual([]);
    expect(pickEvenlySpacedTicks([1, 2, 3], 1)).toEqual([1]);
  });
});

describe('echartsLabelInterval', () => {
  it('shows every label (interval 0) when within budget', () => {
    expect(echartsLabelInterval(5, 10)).toBe(0);
  });

  it('returns a positive skip interval when over budget', () => {
    expect(echartsLabelInterval(100, 10)).toBeGreaterThan(0);
  });
});
