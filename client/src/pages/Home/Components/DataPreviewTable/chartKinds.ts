// Pure chart-kind UI ordering / labels / persistence-coercion helpers extracted
// verbatim from DataPreviewTable.tsx (god-file decomposition, behaviour-preserving
// code motion). Module-level constants + one pure function — no React, no state.
import type { PivotChartKind } from '@/lib/pivot/chartRecommendation';

// PV4 · UI ordering + display labels for the Change Chart Type dropdown.
// Order: Compare → Trend → Distribution → Composition → Multi-measure → Flow.
export const CHART_KIND_DROPDOWN_ORDER: ReadonlyArray<PivotChartKind> = [
  'bar',
  'line',
  'area',
  'scatter',
  'pie',
  'donut',
  'heatmap',
  'radar',
  'bubble',
  'waterfall',
];

export const CHART_KIND_LABEL: Record<PivotChartKind, string> = {
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie',
  donut: 'Donut',
  heatmap: 'Heatmap',
  radar: 'Radar',
  bubble: 'Bubble',
  waterfall: 'Waterfall',
};

export type V1ChartType = 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'heatmap';

const V2_TO_V1_FALLBACK: Record<'donut' | 'radar' | 'bubble' | 'waterfall', V1ChartType> = {
  donut: 'pie',
  radar: 'bar',
  bubble: 'scatter',
  waterfall: 'bar',
};

export function coerceChartTypeForPersistence(kind: PivotChartKind): V1ChartType {
  if (kind === 'donut' || kind === 'radar' || kind === 'bubble' || kind === 'waterfall') {
    return V2_TO_V1_FALLBACK[kind];
  }
  return kind;
}
