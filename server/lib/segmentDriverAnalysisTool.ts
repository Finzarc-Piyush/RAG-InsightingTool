import { z } from "zod";
import type { AgentExecutionContext } from "./agents/runtime/types.js";
import type { ToolResult } from "./agents/runtime/toolRegistry.js";
import type { ChartSpec, Insight } from "../shared/schema.js";
import type { DimensionFilter } from "../shared/queryTypes.js";
import { filterRowsByDimensionFilters } from "./dataTransform.js";
import { analyzeCorrelations } from "./correlationAnalyzer.js";
import {
  diagnosticMaxParallelBranches,
  diagnosticSliceRowCap,
} from "./diagnosticPipelineConfig.js";
import { findMatchingColumn } from "./agents/utils/columnMatcher.js";

export const segmentDriverArgsSchema = z
  .object({
    outcomeColumn: z.string(),
    dimensionFilters: z
      .array(
        z.object({
          column: z.string(),
          op: z.enum(["in", "not_in"]),
          values: z.array(z.string()),
          match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
        })
      )
      .min(1)
      .max(12),
    breakdownColumns: z.array(z.string()).max(6).optional(),
  })
  .strict();

export type SegmentDriverArgs = z.infer<typeof segmentDriverArgsSchema>;

function capRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  const cap = diagnosticSliceRowCap();
  if (rows.length <= cap) return rows;
  return rows.slice(0, cap);
}

function sumColumn(rows: Record<string, unknown>[], col: string): number {
  let s = 0;
  for (const r of rows) {
    const v = Number(r[col]);
    if (Number.isFinite(v)) s += v;
  }
  return s;
}

function aggregateSumByDimension(
  rows: Record<string, unknown>[],
  dim: string,
  measure: string
): Record<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const key = r[dim] == null ? "" : String(r[dim]).trim();
    const v = Number(r[measure]);
    if (!Number.isFinite(v)) continue;
    m.set(key, (m.get(key) ?? 0) + v);
  }
  return Object.fromEntries(m);
}

function formatAggTable(title: string, agg: Record<string, number>, limit = 12): string {
  const entries = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, limit);
  return `${title}\n${top.map(([k, v]) => `  ${k}: ${v.toFixed(2)}`).join("\n")}`;
}

type BranchOutcome =
  | { kind: "text"; text: string }
  | { kind: "correlation"; text: string; charts: ChartSpec[]; insights: Insight[] };

/**
 * Parallel-friendly segment driver analysis (benchmark + breakdowns + correlation on slice).
 */
export async function runSegmentDriverAnalysisTool(
  exec: AgentExecutionContext,
  args: SegmentDriverArgs
): Promise<ToolResult> {
  const source =
    exec.turnStartDataRef && exec.turnStartDataRef.length > 0
      ? exec.turnStartDataRef
      : exec.data;
  if (!source.length) {
    return { ok: false, summary: "No row-level data available for segment driver analysis." };
  }

  const cols = exec.summary.columns.map((c) => c.name);
  const resolve = (name: string) => findMatchingColumn(name, cols) ?? name;
  const outcome = resolve(args.outcomeColumn);
  if (!cols.includes(outcome)) {
    return { ok: false, summary: `outcomeColumn "${args.outcomeColumn}" not found in schema.` };
  }

  const filters: DimensionFilter[] = args.dimensionFilters.map((f) => ({
    column: resolve(f.column),
    op: f.op,
    values: f.values,
    match: f.match,
  }));

  for (const f of filters) {
    if (!cols.includes(f.column)) {
      return { ok: false, summary: `Unknown filter column "${f.column}".` };
    }
  }

  const full = capRows(source as Record<string, unknown>[]);
  const slice = capRows(
    filterRowsByDimensionFilters(full as Record<string, any>[], filters) as Record<
      string,
      unknown
    >[]
  );

  if (!slice.length) {
    return {
      ok: false,
      summary: "Dimension filters produced zero rows. Check literal values against the dataset.",
    };
  }

  const numericCols = (exec.summary.numericColumns || []).filter((c) => cols.includes(c));
  const preferredBreakdowns = ["Sub-Category", "Segment", "Ship Mode", "State", "City"];
  const requested =
    args.breakdownColumns?.map((c) => resolve(c)).filter((c) => cols.includes(c)) ?? [];
  const breakdownDims = (
    requested.length ?
      requested
    : preferredBreakdowns.filter((c) => cols.includes(c) && !filters.some((f) => f.column === c))
  ).slice(0, 3);

  const sumSlice = sumColumn(slice, outcome);
  const sumFull = sumColumn(full, outcome);
  const share = sumFull > 0 ? (100 * sumSlice) / sumFull : 0;

  const branches: Array<() => Promise<BranchOutcome>> = [];

  branches.push(async () => ({
    kind: "text" as const,
    text: `Benchmark (${outcome}): segment sum=${sumSlice.toFixed(2)} (n=${slice.length} rows; frame cap applied=${full.length < source.length}), global sum=${sumFull.toFixed(2)} (n=${full.length}), segment share of global≈${share.toFixed(1)}%.`,
  }));

  for (const dim of breakdownDims) {
    branches.push(async () => ({
      kind: "text" as const,
      text: formatAggTable(
        `Segment breakdown by ${dim} (${outcome} sum)`,
        aggregateSumByDimension(slice, dim, outcome)
      ),
    }));
  }

  branches.push(async () => {
    if (!numericCols.includes(outcome)) {
      return {
        kind: "text" as const,
        text: "(skipped correlation: outcome not in numeric columns)",
      };
    }
    const { charts, insights } = await analyzeCorrelations(
      slice as Record<string, any>[],
      outcome,
      numericCols,
      "all",
      "descending",
      exec.chatInsights,
      20,
      undefined,
      exec.sessionId,
      true
    );
    return {
      kind: "correlation" as const,
      text: `Correlation scan on filtered slice (n=${slice.length}) for **${outcome}**.`,
      charts,
      insights,
    };
  });

  const maxP = diagnosticMaxParallelBranches();
  const textParts: string[] = [];
  let mergedCharts: ChartSpec[] | undefined;
  let mergedInsights: Insight[] | undefined;

  for (let i = 0; i < branches.length; i += maxP) {
    const chunk = branches.slice(i, i + maxP);
    const part = await Promise.all(chunk.map((fn) => fn()));
    for (const p of part) {
      if (p.kind === "text") {
        textParts.push(p.text);
      } else {
        textParts.push(p.text);
        if (p.charts?.length) mergedCharts = [...(mergedCharts ?? []), ...p.charts];
        if (p.insights?.length) mergedInsights = [...(mergedInsights ?? []), ...p.insights];
      }
    }
  }

  const summary = `run_segment_driver_analysis\n${textParts.join("\n\n")}`;

  const tableRows = [
    {
      metric: `${outcome}_segment_sum`,
      value: sumSlice,
      rows_in_segment: slice.length,
    },
    {
      metric: `${outcome}_global_sum`,
      value: sumFull,
      rows_in_frame: full.length,
    },
  ];

  return {
    ok: true,
    summary: summary.slice(0, 12_000),
    charts: mergedCharts,
    insights: mergedInsights,
    table: {
      rows: tableRows,
      columns: Object.keys(tableRows[0]!),
      rowCount: tableRows.length,
    },
  };
}
