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

export const twoSegmentCompareArgsSchema = z
  .object({
    metricColumn: z.string(),
    segment_a_label: z.string().max(80).default("Segment A"),
    segment_b_label: z.string().max(80).default("Segment B"),
    segment_a_filters: z.array(dimensionFilterSchema).max(12),
    segment_b_filters: z.array(dimensionFilterSchema).max(12),
    aggregation: z.enum(["sum", "mean", "count"]).default("sum"),
  })
  .strict();

function numericValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type SegmentAgg = "sum" | "mean" | "count";

function aggregateSegment(
  frame: Record<string, unknown>[],
  metricColumn: string,
  mode: SegmentAgg
): { metricValue: number; rowCount: number; numericCount: number } {
  const rowCount = frame.length;
  if (mode === "count") {
    return { metricValue: rowCount, rowCount, numericCount: rowCount };
  }
  let sum = 0;
  let numericCount = 0;
  for (const row of frame) {
    const nv = numericValue(row[metricColumn]);
    if (nv === null) continue;
    sum += nv;
    numericCount++;
  }
  const metricValue =
    mode === "mean" && numericCount > 0 ? sum / numericCount : sum;
  return { metricValue, rowCount, numericCount };
}

export function registerTwoSegmentCompareTool(registry: ToolRegistry) {
  registry.register(
    "run_two_segment_compare",
    twoSegmentCompareArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_two_segment_compare is only available in analysis mode.",
        };
      }
      const parsed = twoSegmentCompareArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_two_segment_compare: ${parsed.error.message}`,
        };
      }
      const {
        metricColumn,
        segment_a_label,
        segment_b_label,
        segment_a_filters,
        segment_b_filters,
        aggregation,
      } = parsed.data;
      const allow = new Set(ctx.exec.summary.columns.map((c) => c.name));
      if (!allow.has(metricColumn)) {
        return {
          ok: false,
          summary: "metricColumn must exist in schema.",
        };
      }
      const base =
        ctx.exec.turnStartDataRef && ctx.exec.turnStartDataRef.length > 0
          ? ctx.exec.turnStartDataRef
          : ctx.exec.data;
      const cap = diagnosticSliceRowCap();
      const frame0 = base.length > cap ? base.slice(0, cap) : base;
      if (!frame0.length) {
        return { ok: false, summary: "run_two_segment_compare: empty frame." };
      }
      const frameA = filterRowsByDimensionFilters(
        frame0 as Record<string, any>[],
        segment_a_filters as DimensionFilter[]
      ) as Record<string, unknown>[];
      const frameB = filterRowsByDimensionFilters(
        frame0 as Record<string, any>[],
        segment_b_filters as DimensionFilter[]
      ) as Record<string, unknown>[];
      if (!frameA.length || !frameB.length) {
        return {
          ok: false,
          summary: `run_two_segment_compare: segment A rows=${frameA.length}, B rows=${frameB.length} (after filters on n=${frame0.length}).`,
        };
      }
      const aggA = aggregateSegment(frameA, metricColumn, aggregation);
      const aggB = aggregateSegment(frameB, metricColumn, aggregation);
      const totalMetric = aggA.metricValue + aggB.metricValue;
      const mixA =
        totalMetric !== 0 ? aggA.metricValue / totalMetric : null;
      const mixB =
        totalMetric !== 0 ? aggB.metricValue / totalMetric : null;
      const rateRatio =
        aggB.metricValue !== 0 ? aggA.metricValue / aggB.metricValue : null;
      const rowsOut: Record<string, unknown>[] = [
        {
          segment: segment_a_label,
          metric: aggA.metricValue,
          row_count: aggA.rowCount,
          numeric_count: aggA.numericCount,
          mix_of_pair_total: mixA,
        },
        {
          segment: segment_b_label,
          metric: aggB.metricValue,
          row_count: aggB.rowCount,
          numeric_count: aggB.numericCount,
          mix_of_pair_total: mixB,
        },
      ];
      const sample = JSON.stringify(
        {
          segments: rowsOut,
          rate_ratio_A_per_B: rateRatio,
          aggregation,
          metricColumn,
        },
        null,
        2
      );
      return {
        ok: true,
        summary: `run_two_segment_compare: ${aggregation}(${metricColumn}) for "${segment_a_label}" vs "${segment_b_label}" (capped_input=${frame0.length}).\n${sample.slice(0, 4500)}`,
        table: {
          rows: rowsOut,
          columns: [
            "segment",
            "metric",
            "row_count",
            "numeric_count",
            "mix_of_pair_total",
          ],
          rowCount: rowsOut.length,
        },
        memorySlots: {
          two_segment_compare: `${segment_a_label}|${segment_b_label}:${metricColumn}`,
        },
      };
    },
    {
      description:
        "Deterministic A vs B cohort comparison on one metric after separate dimensionFilters (same capped row-level frame as breakdown). Use for explicit contrasts (e.g. East vs non-East), mix vs rate style questions, or treated vs control slices. Pair with build_chart (e.g. bar of segment vs metric) when helpful.",
      argsHelp:
        '{"metricColumn": string, "segment_a_label"?: string, "segment_b_label"?: string, "segment_a_filters": [{"column","op":"in"|"not_in","values":[]}], "segment_b_filters": [...], "aggregation"?: "sum"|"mean"|"count"}',
    }
  );
}
