/**
 * ============================================================================
 * breakdownRankingTool.ts — the "run_breakdown_ranking" analytical tool
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines a tool that answers "who is on top?" questions. It takes a
 *   categorical column (e.g. Brand, Salesperson, Region) and a numeric metric
 *   (e.g. Sales), groups the rows by category, adds up (or averages, or
 *   counts) the metric per group, then sorts the groups into a leaderboard.
 *   Used for "top contributors", "top N salespeople", "who has the highest X",
 *   "who drove the decline", etc.
 *
 *   It has two ranking modes:
 *     • Simple: rank by one metric + one aggregation (sum / mean / count).
 *     • Composite: rank by a weighted FORMULA combining several aggregations,
 *       e.g. "(growth_pct * 0.6) + (share_pct * 0.4)". The formula uses a tiny
 *       safe arithmetic mini-language (+ - * / and parentheses and numbers and
 *       the metric aliases — NO SQL functions), the same one used elsewhere for
 *       computed aggregations.
 *
 *   It also runs a quick statistical sanity check: Welch's t-test compares the
 *   #1 group's individual row values against everyone else combined, producing
 *   a "(p = X; n = N)" evidence tag. (A t-test asks "is this difference likely
 *   real, or could it be random noise?"; p is the chance it's just noise, so
 *   small p = more convincing.)
 *
 * WHY IT MATTERS
 *   Ranking/contribution analysis is one of the most common analytical asks.
 *   The deterministic, in-Node computation gives the agent a trustworthy table
 *   plus real statistical evidence, instead of the answer-writer guessing.
 *
 * KEY PIECES
 *   - breakdownRankingArgsSchema — Zod schema for the tool arguments (metric
 *     column OR a composite rankBy formula, breakdown column, filters, topN,
 *     sort direction).
 *   - registerBreakdownRankingTool — registers the tool as "run_breakdown_ranking".
 *   - aggregate / aggregateComposite — group-and-reduce helpers (simple and
 *     formula-based).
 *   - buildBreakdownRankingEvidence — runs Welch's t-test (top group vs rest)
 *     and formats the evidence suffix.
 *
 * HOW IT CONNECTS
 *   Registered into the ToolRegistry (../toolRegistry.js). Filtering uses
 *   filterRowsByDimensionFilters (../../../dataTransform.js); the formula
 *   parser is parseComputedAggregationExpression (../../../queryPlanExecutor.js);
 *   the t-test is runSignificanceTest (../../../significanceTests.js); the
 *   evidence formatting comes from ../formatFindingEvidence.js. Row cap comes
 *   from diagnosticSliceRowCap (../../../diagnosticPipelineConfig.js).
 */
import { z } from "zod";
import type { ToolRegistry, ToolRunContext } from "../toolRegistry.js";
import { filterRowsByDimensionFilters } from "../../../dataTransform.js";
import { diagnosticSliceRowCap } from "../../../diagnosticPipelineConfig.js";
import { parseComputedAggregationExpression } from "../../../queryPlanExecutor.js";
import type { DimensionFilter } from "../../../../shared/queryTypes.js";
import { runSignificanceTest } from "../../../significanceTests.js";
import { composeFindingDetail } from "../formatFindingEvidence.js";
import type { FindingEvidence } from "../scaleNarrativeByConfidence.js";

const dimensionFilterSchema = z
  .object({
    column: z.string(),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

/**
 * Composite-ranking entry. Used inside `rankBy.metrics[]` to declare each
 * aggregation that the ranking expression references. Aliases are validated
 * against the expression's identifier list at tool-arg parse time via
 * `parseComputedAggregationExpression`.
 */
const compositeMetricSchema = z
  .object({
    column: z.string().min(1).max(200),
    operation: z.enum(["sum", "mean", "count"]),
    alias: z.string().min(1).max(64),
  })
  .strict();

/**
 * Composite ranking. When set, overrides the simple
 * `metricColumn + aggregation` shape. The breakdown column is still
 * required for the group-by; `metrics[]` declares each aggregation,
 * `expression` combines them via the restricted arithmetic mini-language
 * (same one `computedAggregations` uses — `+ - * /` + parens +
 * numeric literals + alias identifiers, no SQL functions, no string
 * ops). Ranking sorts groups by the expression's evaluated value.
 *
 * Example for "rank brands by combined growth and share":
 *   {
 *     metrics: [
 *       { column: "Sales",       operation: "sum",  alias: "share_pct" },
 *       { column: "GrowthRate",  operation: "mean", alias: "growth_pct" }
 *     ],
 *     expression: "(growth_pct * 0.6) + (share_pct * 0.4)"
 *   }
 *
 * Caps: max 4 metrics per expression — keeps the planner prompt small
 * and the per-group compute bounded.
 */
const rankByCompositeSchema = z
  .object({
    metrics: z.array(compositeMetricSchema).min(1).max(4),
    expression: z.string().min(1).max(240),
  })
  .strict()
  .superRefine((data, ctx) => {
    const parsed = parseComputedAggregationExpression(data.expression);
    if (!parsed.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rankBy.expression: ${parsed.error}`,
        path: ["expression"],
      });
      return;
    }
    const known = new Set(data.metrics.map((m) => m.alias));
    for (const id of parsed.aliasesReferenced) {
      if (!known.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rankBy.expression: identifier '${id}' is not an alias from rankBy.metrics`,
          path: ["expression"],
        });
      }
    }
  });

export const breakdownRankingArgsSchema = z
  .object({
    metricColumn: z.string().optional(),
    breakdownColumn: z.string(),
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
    aggregation: z.enum(["sum", "mean", "count"]).default("sum"),
    /**
     * No upper cap on topN so "top 300 salespeople" works. Safety against
     * runaway prose comes from the observation slimmer below (only top-K=10
     * rows are stringified into the narrator's observation context — the full
     * table rides on `ToolResult.table` and bypasses the 40k/20k char
     * observation caps).
     */
    topN: z.number().int().min(1).default(20),
    direction: z.enum(["desc", "asc"]).default("desc"),
    /**
     * Composite-ranking expression. When set, overrides the simple
     * `metricColumn + aggregation` ranking with a multi-metric weighted
     * formula. See `rankByCompositeSchema` above for shape.
     */
    rankBy: rankByCompositeSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Either rankBy OR metricColumn must be present (legacy simple
    // path needs metricColumn; composite path provides metrics inside
    // rankBy and ignores the top-level metricColumn).
    if (!data.rankBy && !data.metricColumn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "run_breakdown_ranking requires either `metricColumn` (simple ranking) or `rankBy` (composite expression ranking)",
        path: ["metricColumn"],
      });
    }
  });

/** Number of rows surfaced in the textual observation summary that the
 *  narrator and replans see. The full table is always returned on
 *  `ToolResult.table`; this only caps the JSON snippet inside `summary`. */
const OBSERVATION_TOP_K = 10;

type BreakdownArgs = z.infer<typeof breakdownRankingArgsSchema>;

function numericValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Split row-level metric values into the headline (top-ranked) group vs.
 * all other groups, then run Welch's t-test to assess whether the headline
 * group's row-level metric values differ significantly from the rest of the
 * universe.
 *
 * Two-pass over the frame: the existing `aggregate` reduces sum/count per
 * group (cheap), and this collects values for exactly two buckets (top +
 * other). For high-cardinality breakdowns the second pass is the only
 * extra work — values per group would explode memory.
 *
 * Returns the canonical FindingEvidence suffix (` (p = X; n = N)`) or `""`
 * on skip (count aggregation, composite ranking, insufficient n, or only
 * one group present). Safe to concatenate onto an existing summary.
 */
function buildBreakdownRankingEvidence(
  frame: ReadonlyArray<Record<string, unknown>>,
  breakdownColumn: string,
  metricColumn: string,
  topGroupLabel: string,
  aggregation: BreakdownArgs["aggregation"],
): string {
  if (aggregation === "count") return "";
  const topValues: number[] = [];
  const otherValues: number[] = [];
  for (const row of frame) {
    const keyRaw = row[breakdownColumn];
    const key =
      keyRaw === null || keyRaw === undefined ? "(null)" : String(keyRaw);
    const nv = numericValue(row[metricColumn]);
    if (nv === null) continue;
    if (key === topGroupLabel) topValues.push(nv);
    else otherValues.push(nv);
  }
  if (topValues.length < 3 || otherValues.length < 3) return "";
  const result = runSignificanceTest({
    test: "welch_t",
    sampleA: topValues,
    sampleB: otherValues,
  });
  if (!result.ok) return "";
  const evidence: FindingEvidence = {};
  if (Number.isFinite(result.pValue) && result.pValue >= 0 && result.pValue <= 1) {
    evidence.pValue = result.pValue;
  }
  const effectiveN = result.n.sampleA + (result.n.sampleB ?? 0);
  if (Number.isFinite(effectiveN) && effectiveN > 0) {
    evidence.n = effectiveN;
  }
  return composeFindingDetail("", evidence);
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

/**
 * Aggregate each metric per breakdown group, then evaluate the composite
 * expression once per group. Returns the per-group scalar score plus the raw
 * aggregated metrics (for the result table and the narrator-facing observation).
 */
function aggregateComposite(
  rows: Record<string, unknown>[],
  breakdownColumn: string,
  metrics: ReadonlyArray<z.infer<typeof compositeMetricSchema>>,
  expression: string
): Map<
  string,
  { metricValues: Record<string, number>; score: number | null; nRows: number }
> {
  // Per-group running totals for each metric. We track sum + count so
  // we can compute mean as `sum / count` at the end (matches the simple
  // path's semantics).
  const perGroup = new Map<
    string,
    { sums: Record<string, number>; counts: Record<string, number>; nRows: number }
  >();
  for (const row of rows) {
    const keyRaw = row[breakdownColumn];
    const key =
      keyRaw === null || keyRaw === undefined ? "(null)" : String(keyRaw);
    let cur = perGroup.get(key);
    if (!cur) {
      cur = {
        sums: Object.fromEntries(metrics.map((m) => [m.alias, 0])),
        counts: Object.fromEntries(metrics.map((m) => [m.alias, 0])),
        nRows: 0,
      };
      perGroup.set(key, cur);
    }
    cur.nRows += 1;
    for (const m of metrics) {
      if (m.operation === "count") {
        // count = nRows for the group; we keep this constant per metric
        // (matches the simple-path count semantics — "count distinct"
        // would be a separate op which we deliberately don't expose
        // for v1 to keep the planner's surface small).
        cur.counts[m.alias] = cur.nRows;
        continue;
      }
      const nv = numericValue(row[m.column]);
      if (nv === null) continue;
      cur.sums[m.alias] = (cur.sums[m.alias] ?? 0) + nv;
      cur.counts[m.alias] = (cur.counts[m.alias] ?? 0) + 1;
    }
  }
  const out = new Map<
    string,
    {
      metricValues: Record<string, number>;
      score: number | null;
      nRows: number;
    }
  >();
  for (const [groupKey, agg] of perGroup) {
    const metricValues: Record<string, number> = {};
    for (const m of metrics) {
      if (m.operation === "count") {
        metricValues[m.alias] = agg.counts[m.alias] ?? 0;
      } else if (m.operation === "mean") {
        const c = agg.counts[m.alias] ?? 0;
        metricValues[m.alias] = c > 0 ? (agg.sums[m.alias] ?? 0) / c : 0;
      } else {
        // sum
        metricValues[m.alias] = agg.sums[m.alias] ?? 0;
      }
    }
    // Substitute aliases with their numeric values and evaluate the
    // expression. Same pattern as `applyComputedAggregationsInMemory`
    // — restricted character set + Function constructor over no-closure
    // arithmetic.
    let score: number | null;
    try {
      const subbed = expression.replace(
        /\b[A-Za-z_][A-Za-z0-9_]*\b/g,
        (id) => {
          const v = Number(metricValues[id]);
          return Number.isFinite(v) ? `(${v})` : "(null)";
        }
      );
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${subbed});`);
      const val = fn();
      score =
        typeof val === "number" && Number.isFinite(val) ? val : null;
    } catch {
      score = null;
    }
    out.set(groupKey, { metricValues, score, nRows: agg.nRows });
  }
  return out;
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
      const {
        metricColumn,
        breakdownColumn,
        dimensionFilters,
        aggregation,
        topN,
        direction,
        rankBy,
      } = parsed.data;
      const sortDirection = direction;
      const allow = new Set(ctx.exec.summary.columns.map((c) => c.name));
      if (!allow.has(breakdownColumn)) {
        return {
          ok: false,
          summary: "breakdownColumn must exist in schema.",
        };
      }
      // Composite-ranking column validation.
      if (rankBy) {
        for (const m of rankBy.metrics) {
          if (m.operation === "count") continue; // count doesn't reference a numeric column
          if (!allow.has(m.column)) {
            return {
              ok: false,
              summary: `rankBy.metrics: column '${m.column}' not in schema.`,
            };
          }
        }
      } else if (!metricColumn || !allow.has(metricColumn)) {
        return {
          ok: false,
          summary: "metricColumn must exist in schema (or use rankBy for composite ranking).",
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
      // Composite-ranking branch. When `rankBy` is set, we aggregate each
      // declared metric per group, evaluate the expression on the per-group
      // aggregates, and rank by that score.
      if (rankBy) {
        const compositeMap = aggregateComposite(
          frame as Record<string, unknown>[],
          breakdownColumn,
          rankBy.metrics,
          rankBy.expression
        );
        const compositeRows: Record<string, unknown>[] = [];
        for (const [label, entry] of compositeMap) {
          compositeRows.push({
            [breakdownColumn]: label,
            ...entry.metricValues,
            _composite_score: entry.score,
            _rowCount: entry.nRows,
          });
        }
        // Sort by composite score; rows with null score (expression
        // failed for the group — typically division-by-zero in a per-
        // group computation) sink to the bottom regardless of direction.
        const sortMul = sortDirection === "asc" ? 1 : -1;
        compositeRows.sort((a, b) => {
          const av = a._composite_score;
          const bv = b._composite_score;
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (Number(av) - Number(bv)) * sortMul;
        });
        const trimmed = compositeRows.slice(0, topN);
        const cols =
          trimmed.length > 0
            ? Object.keys(trimmed[0] as Record<string, unknown>)
            : [breakdownColumn, "_composite_score"];
        const observationSlice = trimmed.slice(0, OBSERVATION_TOP_K);
        const sample = JSON.stringify(observationSlice, null, 2);
        const showingNote =
          trimmed.length > OBSERVATION_TOP_K
            ? ` (showing first ${OBSERVATION_TOP_K} of ${trimmed.length} ranked rows; full table available downstream)`
            : "";
        const dirNote = sortDirection === "asc" ? " ascending" : "";
        return {
          ok: true,
          summary: `run_breakdown_ranking (composite): expr=${rankBy.expression} by ${breakdownColumn}, top ${topN}${dirNote} (n_input=${frame.length}${base.length > cap ? `, capped_from=${base.length}` : ""})${showingNote}.\n${sample.slice(0, 4500)}`,
          table: {
            rows: trimmed,
            columns: cols,
            rowCount: trimmed.length,
          },
          memorySlots: {
            breakdown_ranking: `${breakdownColumn}:composite`,
          },
        };
      }
      const aggMap = aggregate(
        frame as Record<string, unknown>[],
        breakdownColumn,
        metricColumn!,
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
      const aggKey = `${metricColumn}_${aggregation}`;
      const sortMul = sortDirection === "asc" ? 1 : -1;
      rowsOut.sort(
        (a, b) =>
          (Number(a[aggKey]) - Number(b[aggKey])) * sortMul
      );
      const trimmed = rowsOut.slice(0, topN);
      const cols =
        trimmed.length > 0 ?
          Object.keys(trimmed[0] as Record<string, unknown>)
        : [breakdownColumn, aggKey];
      // Slim the narrator-facing observation to top-K rows even when the user
      // asked for top 300 — the full table rides on ToolResult.table and
      // powers the message-level pivotDefaults. Without this, a 300-row JSON
      // dump would blow the 40k/20k observation char caps and truncate other
      // tool observations from the same turn.
      const observationSlice = trimmed.slice(0, OBSERVATION_TOP_K);
      const sample = JSON.stringify(observationSlice, null, 2);
      const showingNote =
        trimmed.length > OBSERVATION_TOP_K
          ? ` (showing first ${OBSERVATION_TOP_K} of ${trimmed.length} ranked rows in this snippet; full table available downstream)`
          : "";
      const dirNote = sortDirection === "asc" ? " ascending" : "";
      // Canonical FindingEvidence suffix (p + effective n) from Welch's t-test
      // on row-level metric values: the headline (top-ranked) group's values
      // vs. all other groups combined. Lets the answer-grader judge "the top
      // group is the leader" claims by real evidence instead of a
      // medium/no-evidence default. Empty suffix when aggregation=count
      // (different test shape) or insufficient n in either bucket.
      const wq7TopLabel =
        trimmed.length > 0
          ? String(
              (trimmed[0] as Record<string, unknown>)[breakdownColumn] ??
                "(null)",
            )
          : null;
      const wq7EvidenceSuffix =
        wq7TopLabel !== null && metricColumn
          ? buildBreakdownRankingEvidence(
              frame as ReadonlyArray<Record<string, unknown>>,
              breakdownColumn,
              metricColumn,
              wq7TopLabel,
              aggregation,
            )
          : "";
      return {
        ok: true,
        summary: `run_breakdown_ranking: ${aggregation} of ${metricColumn} by ${breakdownColumn}, top ${topN}${dirNote} (n_input=${frame.length}${base.length > cap ? `, capped_from=${base.length}` : ""})${showingNote}.\n${sample.slice(0, 4500)}${wq7EvidenceSuffix}`,
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
        "Deterministic segment breakdown: aggregate a numeric metric by a categorical column after optional dimensionFilters (uses row-level turn-start frame, capped). Use for 'top contributors', 'top N salespeople', 'who has the highest/lowest X', 'who drove the decline', mix analysis. Prefer after slicing the cohort. topN is unbounded — use the literal N from the question (top 300 → topN: 300; who has the highest X → topN: 1). For ascending leaderboards (lowest, least, fewest) set direction: 'asc'. Wave W3 · For composite-criteria ranking ('rank brands by combined growth and share', 'top products weighted by margin × volume') use `rankBy: {metrics: [{column, operation, alias}], expression: \"<alias> + <alias> * 0.5\"}` instead of `metricColumn` — the expression uses + - * / + parens + numeric literals + the metric aliases (no SQL functions).",
      argsHelp:
        '{"metricColumn"?: string, "breakdownColumn": string, "dimensionFilters"?: [{"column","op":"in"|"not_in","values":[]}], "aggregation"?: "sum"|"mean"|"count", "topN"?: number, "direction"?: "desc"|"asc", "rankBy"?: {"metrics":[{"column","operation":"sum|mean|count","alias"}], "expression":"alias_a * 0.6 + alias_b * 0.4"}}',
    }
  );
}
