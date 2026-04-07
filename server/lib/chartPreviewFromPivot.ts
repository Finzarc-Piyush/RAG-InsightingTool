import { findMatchingColumn } from "./agents/utils/columnMatcher.js";
import { compileChartSpec } from "./chartSpecCompiler.js";
import { processChartData } from "./chartGenerator.js";
import { normalizePivotValueFieldForBaseTable } from "./pivotDefaultsFromPreview.js";
import { executePivotQuery } from "./pivotQueryService.js";
import {
  pivotQueryRequestSchema,
  type ChartSpec,
  type DataSummary,
  type PivotModel,
  type PivotValueSpec,
} from "../shared/schema.js";

type PivotTreeNode = PivotModel["tree"]["nodes"][number];

function collectLeaves(
  nodes: PivotModel["tree"]["nodes"]
): Array<Extract<PivotTreeNode, { type: "leaf" }>> {
  const out: Array<Extract<PivotTreeNode, { type: "leaf" }>> = [];
  function walk(ns: PivotModel["tree"]["nodes"]) {
    for (const n of ns) {
      if (n.type === "leaf") out.push(n);
      else walk(n.children);
    }
  }
  walk(nodes);
  return out;
}

function resolveRowFieldIndex(model: PivotModel, fieldSpec: string): number {
  const exact = model.rowFields.indexOf(fieldSpec);
  if (exact >= 0) return exact;
  for (let i = 0; i < model.rowFields.length; i++) {
    const rf = model.rowFields[i]!;
    if (findMatchingColumn(fieldSpec, [rf]) === rf) return i;
  }
  return -1;
}

/**
 * Sets `seriesColumn` from the pivot model before flattening so multi-row layouts stay long-format
 * (matches client {@link resolveSeriesColumnForPivotChart} when column pivot is empty).
 */
export function applyPivotSeriesColumnFromModel(
  model: PivotModel,
  spec: ChartSpec,
  colFieldsLength: number
): ChartSpec {
  const next: ChartSpec = { ...spec };
  if (
    next.type !== "bar" &&
    next.type !== "line" &&
    next.type !== "area"
  ) {
    return next;
  }
  if (next.seriesColumn?.trim()) return next;

  if (model.colField && colFieldsLength === 1) {
    next.seriesColumn = model.colField;
    return next;
  }

  if (model.rowFields.length >= 2) {
    const xIdx = resolveRowFieldIndex(model, next.x);
    if (xIdx >= 0) {
      for (let i = 0; i < model.rowFields.length; i++) {
        if (i !== xIdx) {
          next.seriesColumn = model.rowFields[i]!;
          break;
        }
      }
    }
  }
  return next;
}

/**
 * Map chart Y (e.g. analytical alias `Sales_sum`) to a pivot value spec on the base table (`Sales`).
 */
export function resolvePivotValueSpecForChartY(
  y: string | undefined,
  valueSpecs: PivotValueSpec[],
  numericColumns: string[]
): { valueSpec: PivotValueSpec; canonicalY: string } | null {
  if (!y?.trim()) return null;
  const summary = {
    numericColumns,
    columns: (numericColumns ?? []).map((name) => ({ name })),
  } as DataSummary;
  const tryMatch = (candidate: string) =>
    valueSpecs.find(
      (v) =>
        v.field === candidate ||
        findMatchingColumn(candidate, [v.field]) === v.field
    );

  const trimmed = y.trim();
  let vs = tryMatch(trimmed);
  if (!vs) {
    const base = normalizePivotValueFieldForBaseTable(trimmed, summary);
    if (base !== trimmed) vs = tryMatch(base);
  }
  if (!vs) return null;
  return { valueSpec: vs, canonicalY: vs.field };
}

/**
 * Flatten pivot leaf aggregates into rows for `processChartData`.
 * - No column pivot: rolls up multiple row dimensions so each X appears once (sums Y across outer dims).
 * - With seriesColumn matching a row field: long rows (x, series, y) per leaf.
 * - With column pivot: long rows (x, colField label, y) per leaf × col key when seriesColumn matches col field.
 */
export function pivotModelRowsForChartSpec(
  model: PivotModel,
  spec: Pick<ChartSpec, "x" | "y" | "seriesColumn" | "type"> & { title?: string },
  numericColumns: string[] = []
): Record<string, unknown>[] | null {
  if (model.columnFields.length > 1) return null;

  const resolved = resolvePivotValueSpecForChartY(spec.y, model.valueSpecs, numericColumns);
  if (!resolved) return null;
  const { valueSpec } = resolved;
  const yKey = resolved.canonicalY;

  const xIdx = resolveRowFieldIndex(model, spec.x);
  if (xIdx < 0) return null;

  const leaves = collectLeaves(model.tree.nodes);

  // Column pivot → long format (one row per x × col key)
  if (model.colField && model.columnFields.length === 1 && model.colKeys.length) {
    const seriesCol = spec.seriesColumn?.trim();
    if (!seriesCol) return null;
    const colMatches =
      model.colField === seriesCol ||
      findMatchingColumn(seriesCol, [model.colField]) === model.colField;
    if (!colMatches) return null;

    const rows: Record<string, unknown>[] = [];
    for (const leaf of leaves) {
      const mv = leaf.values?.matrixValues;
      if (!mv) continue;
      const parts = leaf.pathKey.split("\x1f");
      const xVal = xIdx < parts.length ? parts[xIdx]! : leaf.label;
      if (xVal === "" || xVal == null) continue;
      for (const ck of model.colKeys) {
        const n = mv[ck]?.[valueSpec.id];
        if (typeof n !== "number" || !Number.isFinite(n)) continue;
        rows.push({
          [spec.x]: xVal,
          [seriesCol]: ck,
          [yKey]: n,
        });
      }
    }
    return rows.length ? rows : null;
  }

  if (model.colField) return null;

  const seriesSpec = spec.seriesColumn?.trim();
  if (seriesSpec) {
    const sIdx = resolveRowFieldIndex(model, seriesSpec);
    if (sIdx < 0 || sIdx === xIdx) return null;
    const rows: Record<string, unknown>[] = [];
    for (const leaf of leaves) {
      const fv = leaf.values?.flatValues;
      if (!fv) continue;
      const yNum = fv[valueSpec.id];
      if (typeof yNum !== "number" || !Number.isFinite(yNum)) continue;
      const parts = leaf.pathKey.split("\x1f");
      if (xIdx >= parts.length || sIdx >= parts.length) continue;
      const xVal = parts[xIdx]!;
      const sVal = parts[sIdx]!;
      if (xVal === "" || sVal === "") continue;
      rows.push({
        [spec.x]: xVal,
        [seriesSpec]: sVal,
        [yKey]: yNum,
      });
    }
    return rows.length ? rows : null;
  }

  const byX = new Map<string, number>();
  const order: string[] = [];
  for (const leaf of leaves) {
    const fv = leaf.values?.flatValues;
    if (!fv) continue;
    const yNum = fv[valueSpec.id];
    if (typeof yNum !== "number" || !Number.isFinite(yNum)) continue;
    const parts = leaf.pathKey.split("\x1f");
    const xVal = xIdx >= 0 && xIdx < parts.length ? parts[xIdx]! : leaf.label;
    if (xVal === "" || xVal == null) continue;
    if (!byX.has(xVal)) {
      byX.set(xVal, 0);
      order.push(xVal);
    }
    byX.set(xVal, byX.get(xVal)! + yNum);
  }
  const out = order.map((xv) => ({
    [spec.x]: xv,
    [yKey]: byX.get(xv)!,
  }));
  return out.length ? out : null;
}

/**
 * @deprecated Prefer {@link pivotModelRowsForChartSpec}; kept for tests and narrow x/y-only flattening.
 * Returns null when a column pivot is present (no implicit series column).
 */
export function pivotModelToPreAggregatedChartRows(
  model: PivotModel,
  xSpec: string,
  ySpec: string,
  numericColumns: string[] = []
): Record<string, unknown>[] | null {
  return pivotModelRowsForChartSpec(
    model,
    {
      type: "bar",
      title: "pivot",
      x: xSpec,
      y: ySpec,
    },
    numericColumns
  );
}

export type PivotChartPreviewResult = {
  rows: Record<string, unknown>[];
  /** Measure column name aligned with pivot value spec (e.g. `Sales` not `Sales_sum`). */
  yField: string;
  /** Merge into API chart object so metadata matches processed `rows`. */
  resolvedSpec: Pick<
    ChartSpec,
    "type" | "x" | "y" | "z" | "seriesColumn" | "barLayout" | "aggregate"
  >;
};

function chartUnsupportedForPivotPath(spec: ChartSpec): boolean {
  if (spec.type === "heatmap") return true;
  if (spec.type === "scatter") return true;
  if (spec.y2?.trim()) return true;
  if (spec.y2Series && spec.y2Series.length > 0) return true;
  return false;
}

/**
 * When the client sends the same pivot request as the grid, run the pivot query and build chart
 * series from leaf aggregates so chart preview matches the table (temporal facets, filters, etc.).
 * Returns null to fall back to row-level `loadLatestData` + `processChartData`.
 */
export async function tryProcessChartDataFromPivotQuery(
  sessionId: string,
  dataVersion: number | string,
  chartSpec: ChartSpec,
  pivotBody: unknown,
  declaredDateColumns: string[] | undefined,
  numericColumns: string[] = []
): Promise<PivotChartPreviewResult | null> {
  if (chartUnsupportedForPivotPath(chartSpec)) return null;

  const parsed = pivotQueryRequestSchema.safeParse(pivotBody);
  if (!parsed.success) return null;
  if (parsed.data.colFields.length > 1) return null;
  if (!parsed.data.rowFields.length || !parsed.data.valueSpecs.length) return null;

  try {
    const { model } = await executePivotQuery(sessionId, parsed.data, {
      dataVersion,
    });

    const specForPivot: ChartSpec = { ...chartSpec };
    const yResolved = resolvePivotValueSpecForChartY(
      specForPivot.y,
      model.valueSpecs,
      numericColumns
    );
    if (yResolved) {
      specForPivot.y = yResolved.canonicalY;
    }
    Object.assign(
      specForPivot,
      applyPivotSeriesColumnFromModel(
        model,
        specForPivot,
        parsed.data.colFields.length
      )
    );

    const preRows = pivotModelRowsForChartSpec(model, specForPivot, numericColumns);
    if (!preRows?.length) return null;

    const preCols = preRows[0] ? Object.keys(preRows[0]) : [];
    const { merged: compiled } = compileChartSpec(
      preRows as Record<string, unknown>[],
      { numericColumns, dateColumns: declaredDateColumns },
      {
        type: specForPivot.type,
        x: specForPivot.x,
        y: specForPivot.y,
        z: specForPivot.z,
        seriesColumn: specForPivot.seriesColumn,
        barLayout: specForPivot.barLayout,
        aggregate: specForPivot.aggregate,
        y2: specForPivot.y2,
        y2Series: specForPivot.y2Series,
        seriesKeys: specForPivot.seriesKeys,
      },
      { columnOrder: preCols, disallowHeatmapUpgrade: true }
    );

    const specForProcess: ChartSpec = {
      ...specForPivot,
      ...compiled,
      aggregate: "none",
    };

    const processed = processChartData(
      preRows as Record<string, any>[],
      specForProcess,
      declaredDateColumns,
      { chartQuestion: "" }
    );
    if (!processed.length) return null;
    return {
      rows: processed,
      yField: specForProcess.y,
      resolvedSpec: {
        type: specForProcess.type,
        x: specForProcess.x,
        y: specForProcess.y,
        z: specForProcess.z,
        seriesColumn: specForProcess.seriesColumn,
        barLayout: specForProcess.barLayout,
        aggregate: specForProcess.aggregate,
      },
    };
  } catch (e) {
    console.warn("tryProcessChartDataFromPivotQuery (non-fatal, falling back):", e);
    return null;
  }
}
