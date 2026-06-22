import { describe, expect, it } from 'vitest';
import {
  maxXAxisLabels,
  xAxisTickBudget,
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
      avgLabelChars: 2,
      fontSizePx: 11,
      rotationDeg: 0,
      dataPointCount: 50,
    });
    expect(n).toBeGreaterThan(DEFAULT_MAX_X_AXIS_LABELS);
    expect(n).toBeLessThanOrEqual(ABS_MAX_X_AXIS_LABELS);
  });

  it('has no magic-number ceiling — a wide axis can exceed the old fixed 60', () => {
    const n = maxXAxisLabels({
      axisWidthPx: 4000,
      avgLabelChars: 2,
      fontSizePx: 10,
      rotationDeg: 0,
      dataPointCount: 500,
    });
    // The old hard cap was 60; the budget must be free to go well above it,
    // bounded only by the (high) pathological-DOM guard.
    expect(n).toBeGreaterThan(60);
    expect(n).toBeLessThanOrEqual(ABS_MAX_X_AXIS_LABELS);
  });

  it('never labels more buckets than exist (data-point cap)', () => {
    // Huge width would fit hundreds of 1-char labels, but only 7 data points
    // exist, so the budget is 7 — you can not label buckets that aren't there.
    expect(
      maxXAxisLabels({ axisWidthPx: 100000, fontSizePx: 10, dataPointCount: 7 }),
    ).toBe(7);
    // `labels.length` acts as the data cap when `dataPointCount` is omitted.
    expect(
      maxXAxisLabels({
        axisWidthPx: 100000,
        fontSizePx: 10,
        labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      }),
    ).toBe(7);
  });

  it('width governs when it is the tighter bound (fewer than the data count)', () => {
    // 500 points but a narrow axis -> width wins, far below the data cap.
    const n = maxXAxisLabels({
      axisWidthPx: 300,
      avgLabelChars: 3,
      fontSizePx: 11,
      rotationDeg: 0,
      dataPointCount: 500,
    });
    expect(n).toBeLessThan(500);
    expect(n).toBeGreaterThanOrEqual(MIN_X_AXIS_LABELS);
  });

  it('shows fewer labels when the labels are long (horizontal)', () => {
    const short = maxXAxisLabels({
      axisWidthPx: 600,
      labels: ['2021'],
      fontSizePx: 11,
      dataPointCount: 50,
    });
    const long = maxXAxisLabels({
      axisWidthPx: 600,
      labels: ['North-East Premium Segment'],
      fontSizePx: 11,
      dataPointCount: 50,
    });
    expect(long).toBeLessThan(short);
    expect(long).toBeGreaterThanOrEqual(MIN_X_AXIS_LABELS);
  });

  it('never returns fewer than MIN or more than the absolute guard', () => {
    // Very narrow axis + very long labels -> clamps up to MIN.
    expect(
      maxXAxisLabels({
        axisWidthPx: 120,
        labels: ['a very long category label here'],
        fontSizePx: 12,
        dataPointCount: 50,
      }),
    ).toBe(MIN_X_AXIS_LABELS);
    // Very wide axis + 1-char labels + plenty of data -> clamps down to the guard.
    expect(
      maxXAxisLabels({
        axisWidthPx: 100000,
        avgLabelChars: 1,
        fontSizePx: 10,
        dataPointCount: 1000,
      }),
    ).toBe(ABS_MAX_X_AXIS_LABELS);
  });

  it('is monotonic in width (wider axis => at least as many labels)', () => {
    const narrow = maxXAxisLabels({
      axisWidthPx: 400,
      labels: ['Jan'],
      fontSizePx: 11,
      dataPointCount: 50,
    });
    const wide = maxXAxisLabels({
      axisWidthPx: 800,
      labels: ['Jan'],
      fontSizePx: 11,
      dataPointCount: 50,
    });
    expect(wide).toBeGreaterThanOrEqual(narrow);
    expect(wide).toBeGreaterThan(narrow);
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
      { axisWidthPx: 600, dataPointCount: NaN },
      { axisWidthPx: 600, dataPointCount: -5 },
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
        dataPointCount: 50,
      });
      const huge = maxXAxisLabels({
        axisWidthPx: 600,
        fontSizePx: 10,
        rotationDeg: -45,
        labels: ['an extremely long rotated category label'],
        dataPointCount: 50,
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

describe('xAxisTickBudget (rotate-to-fit)', () => {
  it('keeps short, few labels horizontal', () => {
    const plan = xAxisTickBudget({
      axisWidthPx: 800,
      labels: ['2021', '2022', '2023'],
      dataPointCount: 3,
    });
    expect(plan.rotateDeg).toBe(0);
    expect(plan.max).toBe(3); // never more labels than data points
  });

  it('tilts -45° when labels are long', () => {
    const plan = xAxisTickBudget({
      axisWidthPx: 800,
      labels: ['North-East Premium Segment'],
      dataPointCount: 30,
    });
    expect(plan.rotateDeg).toBe(-45);
  });

  it('tilts -45° when there are many categories', () => {
    const many = Array.from({ length: 20 }, (_, i) => `C${i}`);
    const plan = xAxisTickBudget({ axisWidthPx: 800, labels: many, dataPointCount: 20 });
    expect(plan.rotateDeg).toBe(-45);
  });

  it('tilting fits more labels than horizontal for the same long-label wide axis', () => {
    const longLabels = Array.from({ length: 100 }, (_, i) => `Category-Name-${i}`);
    const horizontal = maxXAxisLabels({
      axisWidthPx: 1000,
      labels: longLabels,
      dataPointCount: 100,
      fontSizePx: 11,
      rotationDeg: 0,
    });
    const plan = xAxisTickBudget({
      axisWidthPx: 1000,
      labels: longLabels,
      dataPointCount: 100,
      fontSizePx: 11,
    });
    expect(plan.rotateDeg).toBe(-45);
    expect(plan.max).toBeGreaterThan(horizontal);
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
