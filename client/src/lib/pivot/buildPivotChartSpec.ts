/**
 * PV3 · Build a `ChartSpecV2` for the v2-only pivot marks (donut, radar,
 * bubble, waterfall).
 *
 * Pure function. Reads the materialized `pivotFlatRows` and the
 * recommendation produced by `recommendPivotChartForType()`, returns a
 * v2 spec that `<ChartShim>` will route to `<PremiumChart>`.
 *
 * v1 marks (bar/line/area/scatter/pie/heatmap) continue to flow through
 * the existing server `/api/sessions/:sessionId/chart-preview` endpoint
 * and are NOT handled here — this helper returns null for them so the
 * caller knows to fall back to the v1 path.
 */

import type { ChartSpecV2, ChartV2Mark } from '@/shared/schema';
import type {
  PivotChartKind,
  PivotChartRecommendation,
} from '@/lib/pivot/chartRecommendation';

const V2_PIVOT_MARKS = new Set<PivotChartKind>([
  'donut',
  'radar',
  'bubble',
  'waterfall',
]);

export function isV2PivotMark(kind: PivotChartKind): boolean {
  return V2_PIVOT_MARKS.has(kind);
}

export interface BuildPivotChartSpecInput {
  chartType: PivotChartKind;
  recommendation: PivotChartRecommendation;
  /** Materialized leaf rows from the pivot — already aggregated. */
  pivotFlatRows: ReadonlyArray<Record<string, unknown>>;
  /** Field names of the pivot's value measures, in order. */
  valueFields: ReadonlyArray<string>;
  title?: string;
}

/**
 * Returns a `ChartSpecV2` for v2-only marks; returns null for v1 marks
 * so the caller can fall back to the server chart-preview path.
 */
export function buildPivotChartSpecV2(
  input: BuildPivotChartSpecInput
): ChartSpecV2 | null {
  if (!isV2PivotMark(input.chartType)) return null;
  const { chartType, recommendation, pivotFlatRows, valueFields, title } = input;
  const rows = pivotFlatRows.map((r) => ({ ...r })) as Array<
    Record<string, string | number | null | boolean>
  >;
  const config: ChartSpecV2['config'] = {
    title: title ? { text: title } : undefined,
  };

  if (chartType === 'donut') {
    if (!recommendation.x || !recommendation.y) return null;
    const spec: ChartSpecV2 = {
      version: 2,
      mark: 'arc' as ChartV2Mark,
      encoding: {
        x: { field: recommendation.x, type: 'n' },
        y: { field: recommendation.y, type: 'q' },
        color: { field: recommendation.x, type: 'n' },
      },
      source: { kind: 'inline', rows },
      config,
    };
    return spec;
  }

  if (chartType === 'waterfall') {
    if (!recommendation.x || !recommendation.y) return null;
    const spec: ChartSpecV2 = {
      version: 2,
      mark: 'waterfall' as ChartV2Mark,
      encoding: {
        x: { field: recommendation.x, type: 'n' },
        y: { field: recommendation.y, type: 'q' },
      },
      source: { kind: 'inline', rows },
      config,
    };
    return spec;
  }

  if (chartType === 'bubble') {
    // Bubble uses the `point` mark with a `size` channel — PointRenderer
    // honours size to draw the bubble radius. Three numeric value fields
    // are expected; the optional row dim becomes the color channel.
    const xField = recommendation.x ?? valueFields[0];
    const yField = recommendation.y ?? valueFields[1];
    const sizeField = recommendation.z ?? valueFields[2];
    if (!xField || !yField || !sizeField) return null;
    const spec: ChartSpecV2 = {
      version: 2,
      mark: 'point' as ChartV2Mark,
      encoding: {
        x: { field: xField, type: 'q' },
        y: { field: yField, type: 'q' },
        size: { field: sizeField, type: 'q' },
        ...(recommendation.seriesColumn
          ? { color: { field: recommendation.seriesColumn, type: 'n' } }
          : {}),
      },
      source: { kind: 'inline', rows },
      config,
    };
    return spec;
  }

  if (chartType === 'radar') {
    // Radar wants long-format `{ entity, measure, value }` rows so each
    // measure becomes a spoke. Fold the wide `valueFields` into long form.
    if (!recommendation.x || valueFields.length < 3) return null;
    const entityField = recommendation.x;
    const measureField = '__measure';
    const valueField = '__value';
    const longRows: Array<Record<string, string | number | null | boolean>> = [];
    for (const r of rows) {
      const entity = r[entityField];
      if (entity == null) continue;
      for (const m of valueFields) {
        const v = r[m];
        if (v == null || typeof v === 'boolean') continue;
        const num = typeof v === 'string' ? Number(v) : v;
        if (!Number.isFinite(num as number)) continue;
        longRows.push({
          [entityField]: entity as string | number,
          [measureField]: m,
          [valueField]: num as number,
        });
      }
    }
    const spec: ChartSpecV2 = {
      version: 2,
      mark: 'radar' as ChartV2Mark,
      encoding: {
        x: { field: measureField, type: 'n' },
        y: { field: valueField, type: 'q' },
        color: { field: entityField, type: 'n' },
      },
      source: { kind: 'inline', rows: longRows },
      config,
    };
    return spec;
  }

  return null;
}
