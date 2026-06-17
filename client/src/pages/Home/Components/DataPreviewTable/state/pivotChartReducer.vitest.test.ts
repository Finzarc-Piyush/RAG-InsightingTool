/**
 * ARCH-5 / CQ-3 / FE-2 · Exhaustive unit test for the pure pivotChartReducer.
 *
 * The reducer consolidates DataPreviewTable's chart-config sub-cluster (8 former
 * useStates). Being pure (state + action → next state) it is trivially testable:
 * each action maps to an expected next state, including the composite
 * RESET / HYDRATE / APPLY_RECOMMENDATION actions that collapse the N-setter
 * blocks in the component's reset / hydrate / auto-recommend effects.
 *
 * Each single-field action is asserted to produce a next state IDENTICAL to what
 * the corresponding `setChartX(...)` would have committed, and the identity
 * short-circuit (return same ref when the value is unchanged) is pinned so
 * dependent memos/effects don't see spurious changes.
 */
import { describe, expect, test } from 'vitest';
import {
  initialPivotChartState,
  pivotChartReducer,
  type HydratedChart,
  type PivotChartState,
  type RecommendedChartLayout,
} from './pivotChartReducer';

const INITIAL: PivotChartState = {
  type: 'bar',
  title: 'Pivot chart',
  xCol: '',
  yCol: '',
  zCol: '',
  seriesCol: '',
  barLayout: 'stacked',
  recommendationReason: null,
};

/** A non-default state so single-field updates are observable against a baseline. */
const POPULATED: PivotChartState = {
  type: 'line',
  title: 'My chart',
  xCol: 'Region',
  yCol: 'Revenue',
  zCol: 'Margin',
  seriesCol: 'Channel',
  barLayout: 'grouped',
  recommendationReason: 'because',
};

describe('initialPivotChartState', () => {
  test('matches the component boot defaults', () => {
    expect(initialPivotChartState()).toEqual(INITIAL);
  });
  test('returns a fresh object each call (no shared mutable ref)', () => {
    expect(initialPivotChartState()).not.toBe(initialPivotChartState());
  });
});

describe('single-field actions', () => {
  test('SET_CHART_TYPE updates only type', () => {
    const next = pivotChartReducer(INITIAL, { type: 'SET_CHART_TYPE', chartType: 'line' });
    expect(next).toEqual({ ...INITIAL, type: 'line' });
  });

  test('SET_TITLE updates only title', () => {
    const next = pivotChartReducer(INITIAL, { type: 'SET_TITLE', title: 'Hi' });
    expect(next).toEqual({ ...INITIAL, title: 'Hi' });
  });

  test('SET_X / SET_Y / SET_Z update only their axis', () => {
    expect(pivotChartReducer(INITIAL, { type: 'SET_X', xCol: 'A' })).toEqual({ ...INITIAL, xCol: 'A' });
    expect(pivotChartReducer(INITIAL, { type: 'SET_Y', yCol: 'B' })).toEqual({ ...INITIAL, yCol: 'B' });
    expect(pivotChartReducer(INITIAL, { type: 'SET_Z', zCol: 'C' })).toEqual({ ...INITIAL, zCol: 'C' });
  });

  test('SET_SERIES updates only seriesCol', () => {
    expect(pivotChartReducer(INITIAL, { type: 'SET_SERIES', seriesCol: 'S' })).toEqual({
      ...INITIAL,
      seriesCol: 'S',
    });
  });

  test('SET_BAR_LAYOUT updates only barLayout', () => {
    expect(pivotChartReducer(INITIAL, { type: 'SET_BAR_LAYOUT', barLayout: 'grouped' })).toEqual({
      ...INITIAL,
      barLayout: 'grouped',
    });
  });

  test('SET_RECOMMENDATION_REASON updates only the reason (incl. clearing to null)', () => {
    expect(
      pivotChartReducer(INITIAL, { type: 'SET_RECOMMENDATION_REASON', reason: 'r' })
    ).toEqual({ ...INITIAL, recommendationReason: 'r' });
    expect(
      pivotChartReducer(POPULATED, { type: 'SET_RECOMMENDATION_REASON', reason: null })
    ).toEqual({ ...POPULATED, recommendationReason: null });
  });
});

describe('identity short-circuit (mirrors React setState bail-out)', () => {
  test('setting a field to its current value returns the SAME reference', () => {
    expect(pivotChartReducer(POPULATED, { type: 'SET_CHART_TYPE', chartType: 'line' })).toBe(
      POPULATED
    );
    expect(pivotChartReducer(POPULATED, { type: 'SET_TITLE', title: 'My chart' })).toBe(POPULATED);
    expect(pivotChartReducer(POPULATED, { type: 'SET_X', xCol: 'Region' })).toBe(POPULATED);
    expect(pivotChartReducer(POPULATED, { type: 'SET_Y', yCol: 'Revenue' })).toBe(POPULATED);
    expect(pivotChartReducer(POPULATED, { type: 'SET_Z', zCol: 'Margin' })).toBe(POPULATED);
    expect(pivotChartReducer(POPULATED, { type: 'SET_SERIES', seriesCol: 'Channel' })).toBe(
      POPULATED
    );
    expect(pivotChartReducer(POPULATED, { type: 'SET_BAR_LAYOUT', barLayout: 'grouped' })).toBe(
      POPULATED
    );
    expect(
      pivotChartReducer(POPULATED, { type: 'SET_RECOMMENDATION_REASON', reason: 'because' })
    ).toBe(POPULATED);
  });

  test('a changing value returns a NEW reference (no accidental mutation)', () => {
    const next = pivotChartReducer(POPULATED, { type: 'SET_X', xCol: 'Other' });
    expect(next).not.toBe(POPULATED);
    expect(POPULATED.xCol).toBe('Region'); // input untouched
  });
});

describe('RESET (collapses the reset-on-data-shape-change block)', () => {
  test('RESET returns the exact boot defaults regardless of prior state', () => {
    expect(pivotChartReducer(POPULATED, { type: 'RESET' })).toEqual(INITIAL);
  });
});

describe('HYDRATE (collapses the persisted-state restore block)', () => {
  test('restores type + axes; zCol falls back to "" when absent; title/reason preserved', () => {
    const chart: HydratedChart = {
      type: 'area',
      xCol: 'Region',
      yCol: 'Revenue',
      seriesCol: 'Channel',
      barLayout: 'grouped',
      // zCol omitted
    };
    const next = pivotChartReducer(
      { ...INITIAL, title: 'kept', recommendationReason: 'kept-reason' },
      { type: 'HYDRATE', chart }
    );
    expect(next).toEqual({
      type: 'area',
      title: 'kept', // hydrate does not touch title
      xCol: 'Region',
      yCol: 'Revenue',
      zCol: '', // absent → ''
      seriesCol: 'Channel',
      barLayout: 'grouped',
      recommendationReason: 'kept-reason', // hydrate does not touch reason
    });
  });

  test('zCol provided is restored verbatim', () => {
    const chart: HydratedChart = {
      type: 'heatmap',
      xCol: 'Region',
      yCol: 'Channel',
      zCol: 'Revenue',
      seriesCol: '',
      barLayout: 'stacked',
    };
    const next = pivotChartReducer(INITIAL, { type: 'HYDRATE', chart });
    expect(next.zCol).toBe('Revenue');
    expect(next.type).toBe('heatmap');
  });
});

describe('APPLY_RECOMMENDATION (collapses auto-recommend + reset-to-recommended)', () => {
  test('forces title to "Pivot chart", applies axes with ?? "" coercions, copies layout + reason', () => {
    const layout: RecommendedChartLayout = {
      x: 'Region',
      y: 'Revenue',
      z: null,
      seriesColumn: undefined,
      barLayout: 'grouped',
      reason: 'Row and column dimensions available.',
    };
    const next = pivotChartReducer(
      { ...POPULATED, title: 'stale title' },
      { type: 'APPLY_RECOMMENDATION', layout }
    );
    expect(next).toEqual({
      ...POPULATED,
      title: 'Pivot chart',
      xCol: 'Region',
      yCol: 'Revenue',
      zCol: '', // null → ''
      seriesCol: '', // undefined → ''
      barLayout: 'grouped',
      recommendationReason: 'Row and column dimensions available.',
    });
  });

  test('does NOT change chartType (the auto-recommend type pick is a separate dispatch)', () => {
    const layout: RecommendedChartLayout = {
      x: 'A',
      y: 'B',
      z: 'C',
      seriesColumn: 'S',
      barLayout: 'stacked',
      reason: 'r',
    };
    const next = pivotChartReducer({ ...INITIAL, type: 'pie' }, { type: 'APPLY_RECOMMENDATION', layout });
    expect(next.type).toBe('pie');
    expect(next.zCol).toBe('C');
    expect(next.seriesCol).toBe('S');
  });
});

describe('action sequences (composability)', () => {
  test('reset → hydrate → manual pick produces the expected accumulated state', () => {
    let s = initialPivotChartState();
    s = pivotChartReducer(s, { type: 'RESET' });
    s = pivotChartReducer(s, {
      type: 'HYDRATE',
      chart: { type: 'line', xCol: 'Region', yCol: 'Revenue', seriesCol: '', barLayout: 'stacked' },
    });
    expect(s.type).toBe('line');
    s = pivotChartReducer(s, { type: 'SET_CHART_TYPE', chartType: 'bar' });
    expect(s.type).toBe('bar');
    expect(s.xCol).toBe('Region'); // hydrated axis survives a type pick
  });
});
