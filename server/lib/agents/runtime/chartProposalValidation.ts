import type { AgentExecutionContext } from "./types.js";

export type ChartProposalXY = {
  x: string;
  y: string;
  type: string;
  z?: string;
  seriesColumn?: string;
  barLayout?: "stacked" | "grouped";
};

function rowHasKeys(
  first: Record<string, unknown> | undefined,
  x: string,
  y: string
): boolean {
  return Boolean(
    first &&
      Object.prototype.hasOwnProperty.call(first, x) &&
      Object.prototype.hasOwnProperty.call(first, y)
  );
}

function yIsNumericishOnFrame(rows: Record<string, unknown>[], y: string): boolean {
  const cap = Math.min(20, rows.length);
  for (let i = 0; i < cap; i++) {
    const v = rows[i][y];
    if (v == null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) return true;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return true;
  }
  return false;
}

function rowHasKey(
  first: Record<string, unknown> | undefined,
  key: string
): boolean {
  return Boolean(first && Object.prototype.hasOwnProperty.call(first, key));
}

export function validateChartProposal(ctx: AgentExecutionContext, p: ChartProposalXY): boolean {
  const lat = ctx.lastAnalyticalTable;
  const rows = lat?.rows;
  const first = rows?.[0] as Record<string, unknown> | undefined;

  if (p.type === "heatmap" && p.z) {
    if (
      rows?.length &&
      rowHasKeys(first, p.x, p.y) &&
      rowHasKey(first, p.z)
    ) {
      return yIsNumericishOnFrame(rows as Record<string, unknown>[], p.z);
    }
    const names = new Set(ctx.summary.columns.map((c) => c.name));
    return (
      names.has(p.x) && names.has(p.y) && names.has(p.z) &&
      (ctx.summary.numericColumns.includes(p.z) || yIsNumericishOnFrame(ctx.data as Record<string, unknown>[], p.z))
    );
  }

  if (p.seriesColumn) {
    if (
      rows?.length &&
      rowHasKeys(first, p.x, p.y) &&
      rowHasKey(first, p.seriesColumn)
    ) {
      return yIsNumericishOnFrame(rows as Record<string, unknown>[], p.y);
    }
    const names = new Set(ctx.summary.columns.map((c) => c.name));
    return (
      names.has(p.x) &&
      names.has(p.y) &&
      names.has(p.seriesColumn) &&
      (ctx.summary.numericColumns.includes(p.y) || yIsNumericishOnFrame(ctx.data as Record<string, unknown>[], p.y))
    );
  }

  if (rows?.length && rowHasKeys(first, p.x, p.y)) {
    if (ctx.summary.numericColumns.includes(p.y)) return true;
    if (yIsNumericishOnFrame(rows as Record<string, unknown>[], p.y)) return true;
    return false;
  }

  const names = new Set(ctx.summary.columns.map((c) => c.name));
  if (!names.has(p.x) || !names.has(p.y)) return false;
  if (!ctx.summary.numericColumns.includes(p.y)) return false;
  return true;
}

export function chartRowsForProposal(
  ctx: AgentExecutionContext,
  p: ChartProposalXY
): { rows: Record<string, unknown>[]; useAnalyticalOnly: boolean } {
  const lat = ctx.lastAnalyticalTable;
  const first = lat?.rows?.[0] as Record<string, unknown> | undefined;
  if (!lat?.rows?.length || !rowHasKeys(first, p.x, p.y)) {
    return { rows: ctx.data as Record<string, unknown>[], useAnalyticalOnly: false };
  }
  if (p.type === "heatmap" && p.z && !rowHasKey(first, p.z)) {
    return { rows: ctx.data as Record<string, unknown>[], useAnalyticalOnly: false };
  }
  if (p.seriesColumn && !rowHasKey(first, p.seriesColumn)) {
    return { rows: ctx.data as Record<string, unknown>[], useAnalyticalOnly: false };
  }
  return { rows: lat.rows as Record<string, unknown>[], useAnalyticalOnly: true };
}
