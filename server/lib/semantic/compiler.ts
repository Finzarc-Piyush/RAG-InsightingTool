/**
 * Wave W58 · Semantic-layer compiler.
 *
 * `compileMetricQuery({ model, metric, breakdownBy?, filters?, sortBy?,
 * limit? })` translates a semantic query — speak about *metrics* + *named
 * dimensions* — into a `QueryPlanBody` (the existing
 * `execute_query_plan` tool's input). The agentic loop's planner (W59)
 * will be told to prefer this shape over raw column refs; the
 * `execute_metric_query` tool (W60) dispatches through here.
 *
 * Compiles two metric expression shapes:
 *
 *   1. **Simple single-aggregation metrics** matching the whole
 *      expression: `SUM(col)`, `AVG(col)`, `MIN(col)`, `MAX(col)`,
 *      `COUNT(*)`, `COUNT(col)`, `COUNT(DISTINCT col)`, `MEDIAN(col)`,
 *      `MEAN(col)`. These emit a single `aggregationEntry` named with
 *      the metric's `name`.
 *
 *   2. **Composite arithmetic metrics** like `SUM(a) - SUM(b)` or
 *      `SUM(value_sales) / SUM(units)`. The compiler extracts each
 *      `<OP>(<col>)` occurrence, emits one auto-aliased
 *      `aggregationEntry` per occurrence, and rewrites the expression
 *      to reference those aliases. The result is one
 *      `computedAggregation` carrying the rewritten expression with the
 *      metric's `name` as its alias.
 *
 * **Limitations** (intentional for W58, documented for downstream
 * waves):
 *   - The rewritten expression must conform to the existing
 *     `computedAggregationSchema`'s `ALLOWED_EXPRESSION_CHARS_RE`
 *     (a-z A-Z 0-9 underscore space and `+ - x / ( )`). No `NULLIF`,
 *     no `CASE`, no commas, no string functions. Expressions outside
 *     this grammar return `{ ok: false }` with a clear error.
 *     Widening the executor schema is a future wave.
 *   - Breakdown / filter dimensions must exist in the semantic model's
 *     `dimensions` array; unknown names return error.
 *   - Sort can target the compiled metric or any breakdown dimension.
 *
 * Pure function — no I/O, no LLM calls. Safe to call inline from
 * tests, the planner prompt builder, or the runtime tool.
 */

import type { SemanticModel, SemanticMetric } from "../../shared/schema.js";

// Local types — exported so callers + tests can compose against them.

/** Filter shape consumed by the compiler. Mirrors the agent-runtime
 *  `dimensionFilterSchema` ops; the compiler emits the dimensionFilter
 *  itself after dimension-name → column resolution. */
export interface SemanticFilter {
  dimension: string;
  op: "in" | "not_in" | "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "between";
  values: string[];
  match?: "exact" | "case_insensitive" | "contains";
}

export interface CompileMetricQueryInput {
  model: SemanticModel;
  /** Metric name (semantic, snake_case). Must exist in `model.metrics`. */
  metric: string;
  /** Breakdown dimension names (semantic). Must exist in `model.dimensions`. */
  breakdownBy?: string[];
  /** Filter conditions referencing dimension names. */
  filters?: SemanticFilter[];
  /** Sort by either the compiled metric alias or a breakdown dimension column. */
  sortBy?: { by: string; direction: "asc" | "desc" };
  /** Row limit (passed through to QueryPlanBody.limit). */
  limit?: number;
}

export interface CompiledAggregation {
  column: string;
  operation: AggOp;
  alias: string;
}

export interface CompiledComputedAggregation {
  alias: string;
  expression: string;
}

export interface CompiledDimensionFilter {
  column: string;
  op: SemanticFilter["op"];
  values: string[];
  match?: SemanticFilter["match"];
}

export interface CompiledQueryPlan {
  groupBy?: string[];
  aggregations: CompiledAggregation[];
  computedAggregations?: CompiledComputedAggregation[];
  dimensionFilters?: CompiledDimensionFilter[];
  sort?: Array<{ column: string; direction: "asc" | "desc" }>;
  limit?: number;
}

export type CompileMetricQueryResult =
  | { ok: true; plan: CompiledQueryPlan }
  | { ok: false; error: string };

/** Set of aggregation operations the compiler recognises. */
type AggOp =
  | "sum"
  | "mean"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "count_distinct"
  | "median";

const OP_REGEX =
  /\b(SUM|AVG|MEAN|MIN|MAX|COUNT|MEDIAN)\s*\(\s*(\*|(?:DISTINCT\s+[A-Za-z_][A-Za-z0-9_]*)|[A-Za-z_][A-Za-z0-9_]*)\s*\)/gi;

/** Allowed character set for the final post-alias-substituted computed
 *  expression. Must match `computedAggregationSchema`'s validator in
 *  [`queryPlanExecutor.ts`](../queryPlanExecutor.ts). */
const ALLOWED_EXPRESSION_CHARS_RE = /^[A-Za-z0-9_\s+\-*/().]+$/;

/** Sanitise a column or expression token into a safe alias suffix. */
function aliasifyToken(s: string): string {
  return s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Map a SQL-ish op token to the executor's enum. */
function normaliseOp(op: string, hasDistinct: boolean): AggOp | null {
  const u = op.toUpperCase();
  if (u === "SUM") return "sum";
  if (u === "AVG" || u === "MEAN") return "mean";
  if (u === "MIN") return "min";
  if (u === "MAX") return "max";
  if (u === "MEDIAN") return "median";
  if (u === "COUNT") return hasDistinct ? "count_distinct" : "count";
  return null;
}

interface ParsedAggregation {
  /** Original `<OP>(<col>)` substring as it appeared in the expression. */
  raw: string;
  op: AggOp;
  /** Column name. `"*"` for COUNT(*). */
  column: string;
  /** Synthetic alias `_<op>_<col>`. */
  alias: string;
}

/**
 * Walk the expression, capturing every `<OP>(col)` / `<OP>(*)` /
 * `<OP>(DISTINCT col)` occurrence. Returns the list in source order
 * (left-to-right) so caller can replace deterministically.
 */
function extractAggregations(expression: string): ParsedAggregation[] {
  const out: ParsedAggregation[] = [];
  // Reset regex state since OP_REGEX is global.
  OP_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OP_REGEX.exec(expression)) !== null) {
    const raw = m[0];
    const opToken = m[1];
    let columnRaw = m[2].trim();
    let hasDistinct = false;
    if (/^DISTINCT\s+/i.test(columnRaw)) {
      hasDistinct = true;
      columnRaw = columnRaw.replace(/^DISTINCT\s+/i, "");
    }
    const op = normaliseOp(opToken, hasDistinct);
    if (!op) continue;
    const alias =
      columnRaw === "*"
        ? "_row_count"
        : `_${op}_${aliasifyToken(columnRaw)}`;
    out.push({
      raw,
      op,
      column: columnRaw,
      alias,
    });
  }
  return out;
}

/**
 * Returns the metric in `model.metrics` whose `name` matches, or null.
 */
function findMetric(model: SemanticModel, name: string): SemanticMetric | null {
  return model.metrics.find((m) => m.name === name) ?? null;
}

/** Build a Map<dimension name, column name> for fast lookup. */
function buildDimensionIndex(model: SemanticModel): Map<string, string> {
  const idx = new Map<string, string>();
  for (const d of model.dimensions) idx.set(d.name, d.column);
  return idx;
}

/**
 * Detect whether an expression is "just one aggregation" — i.e. the
 * entire expression IS a single `<OP>(<col>)`. In that case the
 * compiler emits an aggregationEntry directly under the metric's name
 * without going through computedAggregations (simpler plan + better
 * downstream SQL).
 */
function isPureSingleAggregation(expression: string): boolean {
  const trimmed = expression.trim();
  OP_REGEX.lastIndex = 0;
  const m = OP_REGEX.exec(trimmed);
  if (!m) return false;
  return m[0] === trimmed;
}

/** Entry point. See file header for full semantics. */
export function compileMetricQuery(
  input: CompileMetricQueryInput,
): CompileMetricQueryResult {
  const { model, metric, breakdownBy, filters, sortBy, limit } = input;

  // 1. Resolve metric.
  const metricDef = findMetric(model, metric);
  if (!metricDef) {
    return {
      ok: false,
      error: `Unknown metric '${metric}'. Known: ${model.metrics.map((m) => m.name).join(", ") || "(none)"}`,
    };
  }

  // 2. Resolve breakdown + filter dimensions to columns.
  const dimIdx = buildDimensionIndex(model);
  const groupByCols: string[] = [];
  for (const dimName of breakdownBy ?? []) {
    const col = dimIdx.get(dimName);
    if (!col) {
      return {
        ok: false,
        error: `Unknown breakdown dimension '${dimName}'. Known: ${Array.from(dimIdx.keys()).join(", ") || "(none)"}`,
      };
    }
    groupByCols.push(col);
  }

  const compiledFilters: CompiledDimensionFilter[] = [];
  for (const f of filters ?? []) {
    const col = dimIdx.get(f.dimension);
    if (!col) {
      return {
        ok: false,
        error: `Unknown filter dimension '${f.dimension}'. Known: ${Array.from(dimIdx.keys()).join(", ") || "(none)"}`,
      };
    }
    const cf: CompiledDimensionFilter = {
      column: col,
      op: f.op,
      values: [...f.values],
    };
    if (f.match) cf.match = f.match;
    compiledFilters.push(cf);
  }

  // 3. Compile the metric expression.
  const expr = metricDef.expression.trim();
  const aggregations: CompiledAggregation[] = [];
  let computedAggregations: CompiledComputedAggregation[] | undefined;

  if (isPureSingleAggregation(expr)) {
    // Simple case: one aggregation, alias it directly with the metric name.
    const [parsed] = extractAggregations(expr);
    if (!parsed) {
      return {
        ok: false,
        error: `Failed to parse single aggregation from metric '${metric}' expression: ${expr}`,
      };
    }
    aggregations.push({
      column: parsed.column,
      operation: parsed.op,
      alias: metric, // exposes the metric name directly in result rows
    });
  } else {
    // Composite case: extract every aggregation, build the rewritten expression.
    const parsedList = extractAggregations(expr);
    if (parsedList.length === 0) {
      return {
        ok: false,
        error: `No aggregations found in metric '${metric}' expression: ${expr}`,
      };
    }

    // Dedupe by (op, column) so `SUM(x) + SUM(x)` doesn't emit two
    // aggregationEntries — both share the same alias.
    const dedupe = new Map<string, ParsedAggregation>();
    for (const p of parsedList) {
      const key = `${p.op}::${p.column}`;
      if (!dedupe.has(key)) dedupe.set(key, p);
    }

    for (const parsed of dedupe.values()) {
      aggregations.push({
        column: parsed.column,
        operation: parsed.op,
        alias: parsed.alias,
      });
    }

    // Rewrite expression with aliases. Walk parsedList (not dedupe) so
    // every occurrence is substituted by its canonical alias.
    let rewritten = expr;
    for (const p of parsedList) {
      // Use `split + join` for substring replace to avoid regex pitfalls.
      const aliasFor = dedupe.get(`${p.op}::${p.column}`)!.alias;
      rewritten = rewritten.split(p.raw).join(aliasFor);
    }

    if (!ALLOWED_EXPRESSION_CHARS_RE.test(rewritten)) {
      return {
        ok: false,
        error:
          `Metric '${metric}' expression contains characters not allowed in computedAggregations ` +
          `(allowed: a-z A-Z 0-9 _ space + - * / ( ) — no NULLIF / CASE / commas yet). ` +
          `Got: '${expr}', rewritten: '${rewritten}'`,
      };
    }

    computedAggregations = [
      {
        alias: metric,
        expression: rewritten.trim(),
      },
    ];
  }

  // 4. Resolve sort. `sortBy.by` can be the metric name (aliased to
  //    itself above) OR a breakdown dimension name (resolve to column).
  let sort: CompiledQueryPlan["sort"];
  if (sortBy) {
    let column: string | undefined;
    if (sortBy.by === metric) {
      column = metric;
    } else {
      const dimCol = dimIdx.get(sortBy.by);
      if (dimCol) column = dimCol;
    }
    if (!column) {
      return {
        ok: false,
        error:
          `Unknown sort target '${sortBy.by}'. Must be the metric '${metric}' or one of the breakdown dimensions.`,
      };
    }
    sort = [{ column, direction: sortBy.direction }];
  }

  const plan: CompiledQueryPlan = {
    aggregations,
  };
  if (groupByCols.length > 0) plan.groupBy = groupByCols;
  if (computedAggregations && computedAggregations.length > 0) {
    plan.computedAggregations = computedAggregations;
  }
  if (compiledFilters.length > 0) plan.dimensionFilters = compiledFilters;
  if (sort) plan.sort = sort;
  if (limit !== undefined) plan.limit = limit;

  return { ok: true, plan };
}
