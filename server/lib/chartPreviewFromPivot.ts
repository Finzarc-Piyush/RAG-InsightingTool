import { findMatchingColumn } from "./agents/utils/columnMatcher.js";
import { processChartData } from "./chartGenerator.js";
import { executePivotQuery } from "./pivotQueryService.js";
import {
  pivotQueryRequestSchema,
  type ChartSpec,
  type PivotModel,
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

/**
 * Flatten a pivot model (no column fields / matrix) into one row per leaf for chart processing.
 * Keys use the chart spec's x/y strings so `processChartData` column matching behaves like row-level mode.
 */
export function pivotModelToPreAggregatedChartRows(
  model: PivotModel,
  xSpec: string,
  ySpec: string
): Record<string, unknown>[] | null {
  if (model.colField) return null;
  if (model.columnFields.length > 0) return null;

  const valueSpec = model.valueSpecs.find(
    (v) => v.field === ySpec || findMatchingColumn(ySpec, [v.field]) === v.field
  );
  if (!valueSpec) return null;

  const rowFieldIdx = (() => {
    const exact = model.rowFields.indexOf(xSpec);
    if (exact >= 0) return exact;
    for (let i = 0; i < model.rowFields.length; i++) {
      const rf = model.rowFields[i]!;
      if (findMatchingColumn(xSpec, [rf]) === rf) return i;
    }
    return -1;
  })();

  const leaves = collectLeaves(model.tree.nodes);
  const rows: Record<string, unknown>[] = [];

  for (const leaf of leaves) {
    const fv = leaf.values?.flatValues;
    if (!fv) continue;
    const yNum = fv[valueSpec.id];
    if (typeof yNum !== "number" || !Number.isFinite(yNum)) continue;

    const parts = leaf.pathKey.split("\x1f");
    let xVal: string;
    if (rowFieldIdx >= 0 && rowFieldIdx < parts.length) {
      xVal = parts[rowFieldIdx]!;
    } else {
      xVal = leaf.label;
    }
    if (xVal === "" || xVal === null || xVal === undefined) continue;

    rows.push({ [xSpec]: xVal, [ySpec]: yNum });
  }

  return rows.length ? rows : null;
}

function chartUnsupportedForPivotPath(spec: ChartSpec): boolean {
  if (spec.type === "heatmap") return true;
  if (spec.type === "scatter") return true;
  if (spec.seriesColumn?.trim()) return true;
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
  declaredDateColumns: string[] | undefined
): Promise<Record<string, unknown>[] | null> {
  if (chartUnsupportedForPivotPath(chartSpec)) return null;

  const parsed = pivotQueryRequestSchema.safeParse(pivotBody);
  if (!parsed.success) return null;
  if (parsed.data.colFields.length > 0) return null;
  if (!parsed.data.rowFields.length || !parsed.data.valueSpecs.length) return null;

  try {
    const { model } = await executePivotQuery(sessionId, parsed.data, {
      dataVersion,
    });
    const preRows = pivotModelToPreAggregatedChartRows(
      model,
      chartSpec.x,
      chartSpec.y
    );
    if (!preRows?.length) return null;

    const specForProcess: ChartSpec = {
      ...chartSpec,
      aggregate: "none",
    };

    const processed = processChartData(
      preRows as Record<string, any>[],
      specForProcess,
      declaredDateColumns,
      { chartQuestion: "" }
    );
    return processed.length ? processed : null;
  } catch (e) {
    console.warn("tryProcessChartDataFromPivotQuery (non-fatal, falling back):", e);
    return null;
  }
}
