import { z } from "zod";
import type { ToolRegistry, ToolRunContext } from "../toolRegistry.js";
import { filterRowsByDimensionFilters } from "../../../dataTransform.js";
import { diagnosticSliceRowCap } from "../../../diagnosticPipelineConfig.js";
import type { DimensionFilter } from "../../../shared/queryTypes.js";

const dimensionFilterSchema = z
  .object({
    column: z.string(),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

export const breakdownRankingArgsSchema = z
  .object({
    metricColumn: z.string(),
    breakdownColumn: z.string(),
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
    aggregation: z.enum(["sum", "mean", "count"]).default("sum"),
    topN: z.number().int().min(2).max(50).default(20),
  })
  .strict();

type BreakdownArgs = z.infer<typeof breakdownRankingArgsSchema>;

function numericValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function aggregate(
  rows: Record<string, unknown>[],
  breakdownColumn: string,
  metricColumn: string,
  mode: BreakdownArgs["aggregation"]
): Map<string, { sum: number; count: number; nRows: number }> {
  const m = new Map<string, { sum: number; count: number; nRows: number }>();
  for (const row of rows) {
    const keyRaw = row[breakdownColumn];
    const key =
      keyRaw === null || keyRaw === undefined ? "(null)" : String(keyRaw);
    const cur = m.get(key) ?? { sum: 0, count: 0, nRows: 0 };
    cur.nRows += 1;
    if (mode === "count") {
      m.set(key, cur);
      continue;
    }
    const nv = numericValue(row[metricColumn]);
    if (nv === null) {
      m.set(key, cur);
      continue;
    }
    cur.sum += nv;
    cur.count += 1;
    m.set(key, cur);
  }
  return m;
}

export function registerBreakdownRankingTool(registry: ToolRegistry) {
  registry.register(
    "run_breakdown_ranking",
    breakdownRankingArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_breakdown_ranking is only available in analysis mode.",
        };
      }
      const parsed = breakdownRankingArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_breakdown_ranking: ${parsed.error.message}`,
        };
      }
      const { metricColumn, breakdownColumn, dimensionFilters, aggregation, topN } =
        parsed.data;
      const allow = new Set(ctx.exec.summary.columns.map((c) => c.name));
      if (!allow.has(metricColumn) || !allow.has(breakdownColumn)) {
        return {
          ok: false,
          summary: "metricColumn and breakdownColumn must exist in schema.",
        };
      }
      const base =
        ctx.exec.turnStartDataRef && ctx.exec.turnStartDataRef.length > 0
          ? ctx.exec.turnStartDataRef
          : ctx.exec.data;
      const cap = diagnosticSliceRowCap();
      let frame = base.length > cap ? base.slice(0, cap) : base;
      if (dimensionFilters?.length) {
        frame = filterRowsByDimensionFilters(
          frame as Record<string, any>[],
          dimensionFilters as DimensionFilter[]
        );
      }
      if (!frame.length) {
        return { ok: false, summary: "run_breakdown_ranking: zero rows after filters." };
      }
      const aggMap = aggregate(
        frame as Record<string, unknown>[],
        breakdownColumn,
        metricColumn,
        aggregation
      );
      const rowsOut: Record<string, unknown>[] = [];
      for (const [label, { sum, count, nRows }] of aggMap) {
        const value =
          aggregation === "mean" && count > 0 ? sum / count
          : aggregation === "count" ? nRows
          : sum;
        rowsOut.push({
          [breakdownColumn]: label,
          [`${metricColumn}_${aggregation}`]: value,
          _numericCount: count,
          _rowCount: nRows,
        });
      }
      rowsOut.sort(
        (a, b) =>
          Number(b[`${metricColumn}_${aggregation}`]) -
          Number(a[`${metricColumn}_${aggregation}`])
      );
      const trimmed = rowsOut.slice(0, topN);
      const cols =
        trimmed.length > 0 ?
          Object.keys(trimmed[0] as Record<string, unknown>)
        : [breakdownColumn, `${metricColumn}_${aggregation}`];
      const sample = JSON.stringify(trimmed, null, 2);
      return {
        ok: true,
        summary: `run_breakdown_ranking: ${aggregation} of ${metricColumn} by ${breakdownColumn}, top ${topN} (n_input=${frame.length}${base.length > cap ? `, capped_from=${base.length}` : ""}).\n${sample.slice(0, 4500)}`,
        table: {
          rows: trimmed,
          columns: cols,
          rowCount: trimmed.length,
        },
        memorySlots: {
          breakdown_ranking: `${breakdownColumn}:${metricColumn}`,
        },
      };
    },
    {
      description:
        "Deterministic segment breakdown: aggregate a numeric metric by a categorical column after optional dimensionFilters (uses row-level turn-start frame, capped). Use for 'top contributors', 'who drove the decline', mix analysis. Prefer after slicing the cohort.",
      argsHelp:
        '{"metricColumn": string, "breakdownColumn": string, "dimensionFilters"?: [{"column","op":"in"|"not_in","values":[]}], "aggregation"?: "sum"|"mean"|"count", "topN"?: number}',
    }
  );
}
