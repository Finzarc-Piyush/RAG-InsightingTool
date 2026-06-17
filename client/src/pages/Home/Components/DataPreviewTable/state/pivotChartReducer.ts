/**
 * ARCH-5 / CQ-3 / FE-2 · Typed reducer for DataPreviewTable's cohesive
 * CHART-CONFIG sub-cluster.
 *
 * Prior waves extracted every cleanly-separable slice of the DataPreviewTable
 * state web (the two session hooks, pure column/cell helpers, sub-components).
 * What remained was the coupled `pivotConfig` ↔ `filterSelections` ↔ chart-config
 * web sharing reset / hydration / debounced-PATCH effects.
 *
 * This reducer consolidates the chart-config CORNER of that web — the 8 useStates
 * that are ALWAYS mutated together (reset-on-data-shape, hydrate-from-persisted,
 * auto-recommend, manual reset-to-recommended, and the dropdown picks):
 *
 *   chartType, chartTitle, chartXCol, chartYCol, chartZCol, chartSeriesCol,
 *   chartBarLayout, chartRecommendationReason
 *
 * It is a PURE function (state + discriminated-union action → next state), so it
 * is exhaustively unit-testable without a DOM. Every existing `setChartX(...)`
 * call in the component maps to a `dispatch({ type, ... })` producing the
 * IDENTICAL next state; the composite RESET / HYDRATE / APPLY_RECOMMENDATION
 * actions collapse the N-setter blocks in the reset/hydrate/auto-recommend
 * effects into one dispatch — same resulting state, same effect timing.
 *
 * `pivotConfig` and `filterSelections` are intentionally LEFT as their own
 * useStates: they have many independent functional-update call sites and feed
 * async memos, so folding them in risks changing setState batching/timing. This
 * reducer owns only the provably-cohesive chart-config cluster — see
 * docs/decisions/datapreviewtable-chart-config-reducer.md.
 */
import type { PivotChartKind } from '@/lib/pivot/chartRecommendation';

export type BarLayout = 'stacked' | 'grouped';

/** The cohesive chart-config slice formerly held in 8 separate useStates. */
export interface PivotChartState {
  type: PivotChartKind;
  title: string;
  xCol: string;
  yCol: string;
  zCol: string;
  seriesCol: string;
  barLayout: BarLayout;
  /** Human-readable reason from the recommender; null when none applied. */
  recommendationReason: string | null;
}

/**
 * Axis fields applied together by both the auto-recommend effect and the
 * manual reset-to-recommended handler. Mirrors the recommender's output
 * (`recommendPivotChartForType` → `{ x, y, z, seriesColumn, barLayout, reason }`)
 * after the component's `?? ''` / `?? null` coercions.
 */
export interface RecommendedChartLayout {
  x: string | null | undefined;
  y: string | null | undefined;
  z: string | null | undefined;
  seriesColumn: string | null | undefined;
  barLayout: BarLayout;
  reason: string | null;
}

/** Chart fields restored from a persisted PivotState.chart. */
export interface HydratedChart {
  type: PivotChartKind;
  xCol: string;
  yCol: string;
  zCol?: string;
  seriesCol: string;
  barLayout: BarLayout;
}

export type PivotChartAction =
  // 1:1 with the existing single setters.
  | { type: 'SET_CHART_TYPE'; chartType: PivotChartKind }
  | { type: 'SET_TITLE'; title: string }
  | { type: 'SET_X'; xCol: string }
  | { type: 'SET_Y'; yCol: string }
  | { type: 'SET_Z'; zCol: string }
  | { type: 'SET_SERIES'; seriesCol: string }
  | { type: 'SET_BAR_LAYOUT'; barLayout: BarLayout }
  | { type: 'SET_RECOMMENDATION_REASON'; reason: string | null }
  // Composite actions (collapse the N-setter blocks).
  | { type: 'RESET' }
  | { type: 'HYDRATE'; chart: HydratedChart }
  | { type: 'APPLY_RECOMMENDATION'; layout: RecommendedChartLayout };

/**
 * The boot/reset default — identical to the per-state initialisers and the
 * reset-on-data-shape-change block:
 *   chartType 'bar', title 'Pivot chart', empty axes, 'stacked', null reason.
 */
export function initialPivotChartState(): PivotChartState {
  return {
    type: 'bar',
    title: 'Pivot chart',
    xCol: '',
    yCol: '',
    zCol: '',
    seriesCol: '',
    barLayout: 'stacked',
    recommendationReason: null,
  };
}

/** Field-wise equality for the composite actions' bail-out (all fields shallow). */
function sameChartState(a: PivotChartState, b: PivotChartState): boolean {
  return (
    a.type === b.type &&
    a.title === b.title &&
    a.xCol === b.xCol &&
    a.yCol === b.yCol &&
    a.zCol === b.zCol &&
    a.seriesCol === b.seriesCol &&
    a.barLayout === b.barLayout &&
    a.recommendationReason === b.recommendationReason
  );
}

export function pivotChartReducer(
  state: PivotChartState,
  action: PivotChartAction
): PivotChartState {
  switch (action.type) {
    case 'SET_CHART_TYPE':
      // Identity short-circuit mirrors React's bail-out when setState receives
      // an equal primitive — keeps reference stable so dependent memos/effects
      // don't see a spurious change.
      if (state.type === action.chartType) return state;
      return { ...state, type: action.chartType };
    case 'SET_TITLE':
      if (state.title === action.title) return state;
      return { ...state, title: action.title };
    case 'SET_X':
      if (state.xCol === action.xCol) return state;
      return { ...state, xCol: action.xCol };
    case 'SET_Y':
      if (state.yCol === action.yCol) return state;
      return { ...state, yCol: action.yCol };
    case 'SET_Z':
      if (state.zCol === action.zCol) return state;
      return { ...state, zCol: action.zCol };
    case 'SET_SERIES':
      if (state.seriesCol === action.seriesCol) return state;
      return { ...state, seriesCol: action.seriesCol };
    case 'SET_BAR_LAYOUT':
      if (state.barLayout === action.barLayout) return state;
      return { ...state, barLayout: action.barLayout };
    case 'SET_RECOMMENDATION_REASON':
      if (state.recommendationReason === action.reason) return state;
      return { ...state, recommendationReason: action.reason };
    case 'RESET':
      return initialPivotChartState();
    case 'HYDRATE': {
      // Mirrors the persisted-state hydration block: restore type + axes; zCol
      // falls back to '' when absent. title/recommendationReason are NOT touched
      // by the original hydrate block, so preserve them.
      const next: PivotChartState = {
        ...state,
        type: action.chart.type,
        xCol: action.chart.xCol,
        yCol: action.chart.yCol,
        zCol: action.chart.zCol ?? '',
        seriesCol: action.chart.seriesCol,
        barLayout: action.chart.barLayout,
      };
      return sameChartState(state, next) ? state : next;
    }
    case 'APPLY_RECOMMENDATION': {
      // Mirrors BOTH the auto-recommend effect and resetChartMappingToRecommended:
      // title is forced to 'Pivot chart', axes from the recommendation with the
      // same `?? ''` coercions, barLayout + reason copied through.
      //
      // The original per-field setters relied on React's per-setState bail-out
      // to avoid a spurious re-render when the recommendation matched the
      // current state; the all-fields-equal short-circuit reproduces that.
      const next: PivotChartState = {
        ...state,
        title: 'Pivot chart',
        xCol: action.layout.x ?? '',
        yCol: action.layout.y ?? '',
        zCol: action.layout.z ?? '',
        seriesCol: action.layout.seriesColumn ?? '',
        barLayout: action.layout.barLayout,
        recommendationReason: action.layout.reason,
      };
      return sameChartState(state, next) ? state : next;
    }
    default: {
      // Exhaustiveness guard.
      const _never: never = action;
      return state;
    }
  }
}
