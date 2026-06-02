/**
 * ============================================================================
 * hierarchicalDrillTool.ts — "top-N + Other" rollup (the `run_hierarchical_drill` tool)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `run_hierarchical_drill` tool. "High-cardinality" means a
 *   column with lots of distinct values (e.g. 50 regions, 200 SKUs); charting
 *   all of them at once is unreadable. This tool aggregates a numeric metric by
 *   that column, keeps the top-N biggest (or smallest) groups, and rolls every
 *   remaining group into a single "Other" bucket. ("Drill-down" is the broader
 *   idea of starting at a summary level and zooming into detail; here we keep
 *   the summary clean while preserving the Other group as a summable total.)
 *   Each output row carries a `_rank` (1, 2, 3 ... and `-1` for the Other
 *   bucket) and a `_share` (its fraction of the grand total, 0..1) so chart
 *   renderers can label slices without recomputing percentages.
 *
 * WHY IT MATTERS
 *   It turns an unreadable 50-category chart into a clean "top 10 + Other"
 *   view. Pure JavaScript, no Python — fast and runs on the in-memory working
 *   dataset.
 *
 * KEY PIECES
 *   - hierarchicalDrillArgsSchema — validates the request (dimension, metric
 *     column, aggregation, topN, direction, otherLabel, optional row filters).
 *   - registerHierarchicalDrillTool — registers the tool wrapper.
 *   - runHierarchicalDrill — the pure transform: filter → bucket → aggregate →
 *     sort → split into keep + Other → build the table. Exported for tests and
 *     reuse from skills; does no I/O.
 *
 * HOW IT CONNECTS
 *   Called by the agent act loop via the tool registry (toolRegistry.ts).
 *   Operates on `ctx.exec.data` (the post-active-filter working dataset).
 *   Often paired with `execute_query_plan` when raw rows need shaping first.
 */

import { z } from "zod";
import type { ToolRegistry, ToolResult, ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";

/** Schema mirrors the existing dimensionFilter shape (limited to categorical
 *  ops since row-level numeric range filtering belongs to `execute_query_plan`). */
const dimensionFilterSchema = z
  .object({
    column: z.string().min(1),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()).min(1),
    match: z.enum(["exact", "case_insensitive"]).optional(),
  })
  .strict();

export const hierarchicalDrillArgsSchema = z
  .object({
    /** Dimension column to roll up (the high-cardinality breakdown). */
    dimension: z.string().min(1),
    /** Numeric column to aggregate. */
    metricColumn: z.string().min(1),
    /** Aggregation operation applied to `metricColumn` within each bucket. */
    aggregation: z.enum(["sum", "mean", "count", "min", "max"]).default("sum"),
    /** Number of top buckets to keep before rolling up the remainder. 2..50. */
    topN: z.number().int().min(2).max(50).default(10),
    /** Sort direction. `desc` → top contributors first; `asc` → smallest first. */
    direction: z.enum(["asc", "desc"]).default("desc"),
    /** Label for the rolled-up bucket. Renderers can override. */
    otherLabel: z.string().min(1).max(60).default("Other"),
    /** Optional row-level filtering applied before rollup. */
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
  })
  .strict();

export type HierarchicalDrillArgs = z.infer<typeof hierarchicalDrillArgsSchema>;

interface BucketRow {
  /** The dimension value as a string (or otherLabel for the rolled-up bucket). */
  label: string;
  count: number;
  /** Sum / mean / etc. tracked progressively. */
  total: number;
  /** Min seen — used by aggregation:"min". */
  min: number;
  /** Max seen — used by aggregation:"max". */
  max: number;
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function passesFilter(
  row: Record<string, unknown>,
  filter: { column: string; op: "in" | "not_in"; values: string[]; match?: "exact" | "case_insensitive" },
): boolean {
  const cell = row[filter.column];
  const cellStr = cell === null || cell === undefined ? "" : String(cell);
  const eq =
    filter.match === "case_insensitive"
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  const matched = filter.values.some((v) => eq(cellStr, v));
  return filter.op === "in" ? matched : !matched;
}

function applyAggregation(bucket: BucketRow, op: HierarchicalDrillArgs["aggregation"]): number {
  switch (op) {
    case "sum":
      return bucket.total;
    case "mean":
      return bucket.count === 0 ? 0 : bucket.total / bucket.count;
    case "count":
      return bucket.count;
    case "min":
      return bucket.count === 0 ? 0 : bucket.min;
    case "max":
      return bucket.count === 0 ? 0 : bucket.max;
  }
}

export function registerHierarchicalDrillTool(registry: ToolRegistry) {
  registry.register(
    "run_hierarchical_drill",
    hierarchicalDrillArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_hierarchical_drill is only available in analysis mode.",
        };
      }
      const parsed = hierarchicalDrillArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_hierarchical_drill: ${parsed.error.message}`,
        };
      }
      const result = runHierarchicalDrill(ctx.exec.data, parsed.data);
      if (!result.ok) return result;
      agentLog("run_hierarchical_drill.done", {
        dimension: parsed.data.dimension,
        topN: parsed.data.topN,
        bucketsReturned: result.table?.rows.length ?? 0,
      });
      return result;
    },
    {
      description:
        "Roll a high-cardinality dimension into top-N + Other for readable breakdown charts. Pure aggregation; pairs with execute_query_plan when you need raw rows but want to chart the rollup.",
      argsHelp:
        '{"dimension":"<col>","metricColumn":"<col>","aggregation":"sum"|"mean"|"count"|"min"|"max","topN":10,"direction":"desc"|"asc","otherLabel":"Other","dimensionFilters":[{"column":"<col>","op":"in"|"not_in","values":["..."]}]}',
    },
  );
}

/**
 * Pure transform — exported for direct tests + reuse from skills.
 * Takes raw rows + args, returns the bucket table OR a failure
 * ToolResult. No I/O.
 */
export function runHierarchicalDrill(
  rows: Array<Record<string, unknown>>,
  args: HierarchicalDrillArgs,
): ToolResult {
  if (!rows || rows.length === 0) {
    return {
      ok: false,
      summary: "run_hierarchical_drill: dataset is empty.",
    };
  }

  // 1. Pre-filter rows.
  const filtered = rows.filter((row) =>
    (args.dimensionFilters ?? []).every((f) => passesFilter(row, f)),
  );
  if (filtered.length === 0) {
    return {
      ok: false,
      summary: `run_hierarchical_drill: no rows match the supplied filters.`,
    };
  }

  // 2. Bucket by dimension.
  const buckets = new Map<string, BucketRow>();
  for (const row of filtered) {
    const dimValueRaw = row[args.dimension];
    if (dimValueRaw === null || dimValueRaw === undefined || dimValueRaw === "") {
      continue; // skip nulls — they shouldn't dominate the chart
    }
    const dimValue = String(dimValueRaw);
    const metric = toNumberOrNull(row[args.metricColumn]);
    if (metric === null && args.aggregation !== "count") {
      continue; // non-numeric cells skipped for sum/mean/min/max
    }
    let bucket = buckets.get(dimValue);
    if (!bucket) {
      bucket = {
        label: dimValue,
        count: 0,
        total: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
      };
      buckets.set(dimValue, bucket);
    }
    bucket.count += 1;
    if (metric !== null) {
      bucket.total += metric;
      if (metric < bucket.min) bucket.min = metric;
      if (metric > bucket.max) bucket.max = metric;
    }
  }

  if (buckets.size === 0) {
    return {
      ok: false,
      summary: `run_hierarchical_drill: no rows had a non-null value for dimension '${args.dimension}'${args.aggregation === "count" ? "" : ` and metric '${args.metricColumn}'`}.`,
    };
  }

  // 3. Compute aggregation per bucket.
  const ranked = Array.from(buckets.values()).map((b) => ({
    label: b.label,
    value: applyAggregation(b, args.aggregation),
  }));

  // 4. Sort + cleave into keep + rollup.
  ranked.sort((a, b) =>
    args.direction === "desc" ? b.value - a.value : a.value - b.value,
  );

  const keep = ranked.slice(0, args.topN);
  const rollup = ranked.slice(args.topN);

  // 5. Aggregate the rollup remainder. `mean` of means is NOT itself a mean
  //    of underlying rows — so for mean we recompute over the remainder
  //    rows directly. For sum/count/min/max the simple aggregation works.
  let otherValue: number;
  if (rollup.length === 0) {
    otherValue = 0;
  } else if (args.aggregation === "mean") {
    let total = 0;
    let count = 0;
    for (const r of rollup) {
      const original = buckets.get(r.label);
      if (!original) continue;
      total += original.total;
      count += original.count;
    }
    otherValue = count === 0 ? 0 : total / count;
  } else if (args.aggregation === "min") {
    otherValue = rollup.reduce(
      (acc, r) => (r.value < acc ? r.value : acc),
      Number.POSITIVE_INFINITY,
    );
  } else if (args.aggregation === "max") {
    otherValue = rollup.reduce(
      (acc, r) => (r.value > acc ? r.value : acc),
      Number.NEGATIVE_INFINITY,
    );
  } else {
    // sum / count are additive
    otherValue = rollup.reduce((sum, r) => sum + r.value, 0);
  }

  // 6. Build the final table. Share-of-total computed across ALL buckets
  //    (keep + rollup) so the percentages add to 100 even when "Other" is
  //    invisible (rollup.length === 0).
  const grandTotal = ranked.reduce((s, r) => s + r.value, 0);
  const tableRows: Array<Record<string, unknown>> = keep.map((b, i) => ({
    [args.dimension]: b.label,
    [args.metricColumn]: b.value,
    _rank: i + 1,
    _share: grandTotal === 0 ? 0 : b.value / grandTotal,
  }));
  if (rollup.length > 0) {
    tableRows.push({
      [args.dimension]: args.otherLabel,
      [args.metricColumn]: otherValue,
      _rank: -1,
      _share: grandTotal === 0 ? 0 : otherValue / grandTotal,
    });
  }

  const summary =
    `${keep.length} top + ${rollup.length} rolled into "${args.otherLabel}" ` +
    `· ${args.aggregation}(${args.metricColumn}) by ${args.dimension} ` +
    `· grand total ${grandTotal.toLocaleString()}`;

  return {
    ok: true,
    summary,
    table: {
      columns: [args.dimension, args.metricColumn, "_rank", "_share"],
      rows: tableRows,
    },
    // numericPayload is a `string` per the ToolResult contract (verifier
    // replay reads it as opaque text); we JSON-stringify the structured
    // metadata so downstream consumers can parse if they need the shape.
    numericPayload: JSON.stringify({
      kind: "hierarchical_drill",
      dimension: args.dimension,
      metricColumn: args.metricColumn,
      aggregation: args.aggregation,
      topN: args.topN,
      otherLabel: args.otherLabel,
      bucketsKept: keep.length,
      bucketsRolled: rollup.length,
      grandTotal,
    }),
  };
}
