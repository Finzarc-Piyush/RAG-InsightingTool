/**
 * Wave W57 · Semantic model inference.
 *
 * Pure deterministic function that builds an initial `SemanticModel` from
 * upload-time signals: `DataSummary`, optional `DatasetProfile`, optional
 * `dimensionHierarchies` carried on `sessionAnalysisContext.dataset`.
 *
 * The compiler (W58) consumes the model; the admin UI (W61) lets the
 * data team override. Auto-inferred entries carry `source: "auto"` so
 * subsequent merges preserve user edits via a generation-counter pattern
 * (planned in W64).
 *
 * Heuristics (ordered by precedence):
 *
 *   1. **Wide-format melted datasets** (signalled by
 *      `dataSummary.wideFormatTransform` per the wide-format ingest plan)
 *      emit:
 *        - one generic `value` metric (`SUM(value)`)
 *        - `_metric` as a categorical dimension (measure splitter)
 *        - `_period` as a temporal dimension (auto-grained)
 *        - id columns (everything else) as categorical dimensions
 *      Per-`_metric` synthetic metrics ("value_sales = SUM(value) FILTER
 *      WHERE _metric='Value Sales'") are deferred to W58 because they
 *      need column-value enumeration the compiler already does.
 *
 *   2. **Long-form datasets** emit:
 *        - one `SUM(col)` metric per numeric column that is NOT an
 *          indicator. Currency-tagged columns get `format: "currency"`
 *          and `currencyCode` from `dataSummary.columns[i].currency`.
 *        - one `row_count` metric (`COUNT(*)`) — always present, cheap.
 *        - one categorical dimension per low-cardinality string column
 *          (`topValues` present).
 *        - one temporal dimension per date column. Grain inferred from
 *          `dataSummary.columns[i].temporalDisplayGrain` when set;
 *          otherwise omitted (compiler will pick).
 *        - one categorical dimension per indicator column.
 *
 *   3. **Hierarchies** stay empty by default. Multi-level chains (Country
 *      → Region → City) require either explicit user declaration or
 *      LLM detection; the upload-time heuristic isn't reliable on column
 *      names alone. The existing `dimensionHierarchies` in
 *      `sessionAnalysisContext.dataset` represent in-column ROLLUP totals,
 *      not multi-level CHAINS — orthogonal concept; the compiler reads
 *      both.
 *
 * Snake-case name collisions (e.g., "Sales (USD)" and "Sales (EUR)" both
 * → `sales`) are resolved with a numeric suffix (`sales`, `sales_2`).
 *
 * Pure function. No I/O. Safe to call in any context including tests.
 */

import type {
  DataSummary,
  DatasetProfile,
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
  SemanticModel,
} from "../../shared/schema.js";
import { classifyMetric } from "../financeMetricAuthority.js";

interface InferModelInput {
  /** Dataset summary as persisted on ChatDocument after upload. */
  summary: DataSummary;
  /** Optional LLM-enriched profile from the upload pipeline. */
  datasetProfile?: DatasetProfile;
  /** Free-text label that shows in the admin UI. Defaults to "Default model". */
  modelName?: string;
}

const SNAKE_FALLBACK = "field";

/**
 * Convert a free-form column name to a snake_case identifier suitable
 * for `SemanticMetric.name` / `SemanticDimension.name`.
 *
 *   "Total Sales"  → "total_sales"
 *   "Sales (USD)"  → "sales_usd"
 *   "Region/City"  → "region_city"
 *   "__tf_year"    → "tf_year"        (leading underscores stripped)
 *   "123_metric"   → "field_123_metric" (lead-with-digit guard)
 *   "_period"      → "period"
 */
export function toSnakeCase(input: string): string {
  if (!input) return SNAKE_FALLBACK;
  let s = input
    // Normalise whitespace + separators to underscore
    .replace(/[^A-Za-z0-9]+/g, "_")
    // camelCase / PascalCase → camel_case
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  // Collapse repeated underscores
  s = s.replace(/_+/g, "_");
  // Strip leading + trailing underscores
  s = s.replace(/^_+|_+$/g, "");
  if (!s) return SNAKE_FALLBACK;
  // Schema requires `^[a-z][a-z0-9_]*$` — guard against leading digit
  if (/^[0-9]/.test(s)) s = `${SNAKE_FALLBACK}_${s}`;
  return s;
}

/**
 * Disambiguate when multiple inferred entries collapse to the same
 * snake_case name. Appends `_2`, `_3`, ... in registration order.
 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let i = 2;
  while (used.has(`${name}_${i}`)) i += 1;
  const final = `${name}_${i}`;
  used.add(final);
  return final;
}

/**
 * True for column types our metric inference treats as numeric (sum-able).
 * `DataSummary.numericColumns` is the authoritative list; this is a
 * type-string fallback.
 */
function isNumericType(type: string): boolean {
  const t = (type || "").toLowerCase();
  return (
    t === "number" ||
    t === "numeric" ||
    t === "integer" ||
    t === "float" ||
    t === "double" ||
    t === "bigint"
  );
}

function isDateType(type: string): boolean {
  const t = (type || "").toLowerCase();
  return t === "date" || t === "datetime" || t === "timestamp";
}

function isStringType(type: string): boolean {
  const t = (type || "").toLowerCase();
  return t === "string" || t === "text" || t === "varchar" || t === "char";
}

/**
 * Map DataSummary's coarse `temporalDisplayGrain` enum
 * (`'dayOrWeek' | 'monthOrQuarter' | 'year'`) to SemanticDimension's
 * finer-grained `temporalGrain` enum. The coarse pairs collapse to the
 * finer end (day, month) by convention; downstream consumers can drill
 * up. `year` round-trips exactly. Anything unrecognised stays
 * undefined so the compiler picks per data span.
 */
function mapTemporalGrain(
  grain: DataSummary["columns"][number]["temporalDisplayGrain"],
): SemanticDimension["temporalGrain"] | undefined {
  if (!grain) return undefined;
  if (grain === "year") return "year";
  if (grain === "monthOrQuarter") return "month";
  if (grain === "dayOrWeek") return "day";
  return undefined;
}

interface ColumnEntry {
  name: string;
  type: string;
  hasTopValues: boolean;
  isIndicator: boolean;
  isHiddenFacet: boolean;
  currencyIso?: string;
  grain?: SemanticDimension["temporalGrain"];
  /** Authoritative per-column semantic classification (name + values). */
  semantics?: DataSummary["columns"][number]["semantics"];
}

function summariseColumn(
  col: DataSummary["columns"][number],
): ColumnEntry {
  return {
    name: col.name,
    type: col.type,
    hasTopValues: Array.isArray(col.topValues) && col.topValues.length > 0,
    isIndicator: !!col.indicator,
    // __tf_* are derived buckets — exclude them from the catalog
    isHiddenFacet: col.name.startsWith("__tf_"),
    currencyIso: col.currency?.isoCode,
    // Prefer the semantic display grain (name/type-aware) over the raw
    // value-derived temporalDisplayGrain.
    grain: mapTemporalGrain(col.semantics?.temporalGrain ?? col.temporalDisplayGrain),
    semantics: col.semantics,
  };
}

/**
 * Build an aggregation metric for a numeric column. Currency-tagged columns
 * get `format: "currency"` + `currencyCode`. A NON-additive column (GC%, margin %,
 * realization …) gets `AVG(col)` + `format: "percent"|"ratio"` instead of
 * `SUM(col)` — summing a ratio is meaningless, and the old code wrongly emitted
 * `SUM(GC%)` with `format:number`. Additivity is decided by financeMetricAuthority.
 * Indicator columns are skipped at the caller.
 */
function buildSumMetric(
  col: ColumnEntry,
  used: Set<string>,
): SemanticMetric {
  const name = uniqueName(toSnakeCase(col.name), used);
  const isCurrency = !!col.currencyIso;
  const cls = classifyMetric(col.name);
  // The semantic classifier and financeMetricAuthority both flag ratios/per-unit
  // as non-additive; honour either so a % is never SUMmed even if the finance
  // catalog missed the name (e.g. "Primary Scheme").
  const nonAdditive =
    cls.additivity === "non_additive" || col.semantics?.aggregation === "avg";
  const isRatioPercent =
    cls.kind === "ratio_percent" ||
    col.semantics?.semanticType === "measure_ratio_percent";
  const format = nonAdditive
    ? isRatioPercent
      ? ("percent" as const)
      : ("ratio" as const)
    : isCurrency
      ? ("currency" as const)
      : ("number" as const);
  const metric: SemanticMetric = {
    name,
    label: col.name,
    expression: nonAdditive ? `AVG(${col.name})` : `SUM(${col.name})`,
    references: [col.name],
    format,
    exposed: true,
    source: "auto",
    description: nonAdditive
      ? `Average of \`${col.name}\` — a non-additive ${cls.kind} metric (never summed); auto-inferred.`
      : `Sum of \`${col.name}\` — auto-inferred from upload.`,
  };
  if (isCurrency && col.currencyIso && !nonAdditive) {
    metric.currencyCode = col.currencyIso;
  }
  return metric;
}

function buildRowCountMetric(used: Set<string>): SemanticMetric {
  const name = uniqueName("row_count", used);
  return {
    name,
    label: "Row Count",
    expression: "COUNT(*)",
    references: [],
    format: "number",
    decimals: 0,
    exposed: true,
    source: "auto",
    description: "Number of rows after current filters — auto-inferred.",
  };
}

function buildCategoricalDimension(
  col: ColumnEntry,
  used: Set<string>,
): SemanticDimension {
  return {
    name: uniqueName(toSnakeCase(col.name), used),
    label: col.name,
    column: col.name,
    kind: "categorical",
    exposed: true,
    source: "auto",
  };
}

function buildTemporalDimension(
  col: ColumnEntry,
  used: Set<string>,
): SemanticDimension {
  const dim: SemanticDimension = {
    name: uniqueName(toSnakeCase(col.name), used),
    label: col.name,
    column: col.name,
    kind: "temporal",
    exposed: true,
    source: "auto",
  };
  if (col.grain) dim.temporalGrain = col.grain;
  return dim;
}

function buildIndicatorDimension(
  col: ColumnEntry,
  used: Set<string>,
): SemanticDimension {
  return {
    name: uniqueName(toSnakeCase(col.name), used),
    label: col.name,
    column: col.name,
    kind: "categorical",
    description: "Indicator column — boolean-like or short-shortlist values.",
    exposed: true,
    source: "auto",
  };
}

/**
 * Wide-format datasets carry synthetic `_metric`, `_period`, `value`
 * columns post-melt. Emit a model that treats them as first-class.
 * The compiler (W58) can later expand per-`_metric` synthetic metrics
 * by enumerating distinct values of the `_metric` column.
 */
function inferWideFormatModel(
  summary: DataSummary,
  modelName: string,
): SemanticModel {
  const metricNames = new Set<string>();
  const dimensionNames = new Set<string>();
  const metrics: SemanticMetric[] = [];
  const dimensions: SemanticDimension[] = [];

  const hasValueCol = summary.columns.some((c) => c.name === "value");
  if (hasValueCol) {
    metrics.push({
      name: uniqueName("value", metricNames),
      label: "Value",
      expression: "SUM(value)",
      references: ["value"],
      format: "number",
      exposed: true,
      source: "auto",
      description:
        "Generic sum of the melted value column. Filter by `_metric` (e.g. 'Value Sales') to isolate a specific measure.",
    });
  }
  metrics.push(buildRowCountMetric(metricNames));

  for (const raw of summary.columns) {
    const col = summariseColumn(raw);
    if (col.isHiddenFacet) continue;
    if (col.name === "value") continue; // promoted to a metric, not a dim
    if (col.name === "_metric") {
      dimensions.push({
        name: uniqueName("metric", dimensionNames),
        label: "Metric",
        column: "_metric",
        kind: "categorical",
        description: "Wide-format measure-name splitter (e.g. 'Value Sales', 'Volume Sales').",
        exposed: true,
        source: "auto",
      });
      continue;
    }
    if (col.name === "_period") {
      dimensions.push({
        name: uniqueName("period", dimensionNames),
        label: "Period",
        column: "_period",
        kind: "temporal",
        temporalGrain: col.grain,
        description: "Wide-format canonical period label (ISO-ish, e.g. '2024-Q2').",
        exposed: true,
        source: "auto",
      });
      continue;
    }
    // Remaining columns are id-vars — categorical dimensions. Same
    // "low-cardinality only" rule as the long-form path: high-cardinality
    // identifiers stay out of the catalog.
    if (col.hasTopValues) {
      dimensions.push(buildCategoricalDimension(col, dimensionNames));
    } else if (isDateType(col.type)) {
      dimensions.push(buildTemporalDimension(col, dimensionNames));
    }
  }

  return {
    version: 1,
    name: modelName,
    metrics,
    dimensions,
    hierarchies: [],
  };
}

/**
 * Long-form (tidy) dataset inference path.
 */
function inferLongFormModel(
  summary: DataSummary,
  modelName: string,
): SemanticModel {
  const metricNames = new Set<string>();
  const dimensionNames = new Set<string>();
  const metrics: SemanticMetric[] = [];
  const dimensions: SemanticDimension[] = [];

  for (const raw of summary.columns) {
    const col = summariseColumn(raw);
    if (col.isHiddenFacet) continue;

    // ── Semantic-type-driven routing (the authority) ──────────────────────
    // A numeric-typed column is NOT automatically a measure: an int-encoded
    // Year / a month-index ordinal / a numeric id must become a dimension, and
    // an all-blank column must be dropped, so the planner never proposes
    // AVG(Year) / SUM(margin) / breakdown-by-empty.
    const dk = col.semantics?.displayKind;
    if (dk) {
      if (dk === "empty") continue;
      if (dk === "date") {
        dimensions.push(buildTemporalDimension(col, dimensionNames));
        continue;
      }
      if (dk === "boolean") {
        dimensions.push(buildIndicatorDimension(col, dimensionNames));
        continue;
      }
      if (dk === "ordinal") {
        dimensions.push(buildCategoricalDimension(col, dimensionNames));
        continue;
      }
      if (dk === "numeric") {
        metrics.push(buildSumMetric(col, metricNames));
        continue;
      }
      // dk === "categorical": a real breakdown dimension, UNLESS it's a
      // high-cardinality identifier (surrogate key) with no shortlist — those
      // shouldn't be offered as a breakdown axis.
      if (col.semantics?.semanticType === "identifier" && !col.hasTopValues) {
        continue;
      }
      dimensions.push(buildCategoricalDimension(col, dimensionNames));
      continue;
    }

    // ── Legacy fallback (sessions with no semantics) ──────────────────────
    if (col.isIndicator) {
      // Indicator columns are categorical signals — surface as a
      // dimension. No metric.
      dimensions.push(buildIndicatorDimension(col, dimensionNames));
      continue;
    }
    if (isNumericType(col.type)) {
      metrics.push(buildSumMetric(col, metricNames));
      continue;
    }
    if (isDateType(col.type)) {
      dimensions.push(buildTemporalDimension(col, dimensionNames));
      continue;
    }
    if (col.hasTopValues) {
      // Low-cardinality string column — a real breakdown dimension.
      dimensions.push(buildCategoricalDimension(col, dimensionNames));
      continue;
    }
    // String columns without topValues are high-cardinality identifiers
    // (TransactionId, OrderId, etc.). Don't expose them as dimensions
    // — the planner shouldn't suggest "breakdown by TransactionId". The
    // compiler can still reference them in raw query plans if asked.
    if (isStringType(col.type)) continue;
  }

  // Always include row_count for downstream tools that need it.
  metrics.push(buildRowCountMetric(metricNames));

  return {
    version: 1,
    name: modelName,
    metrics,
    dimensions,
    hierarchies: [],
  };
}

/**
 * Entry point. See file header for full semantics.
 */
export function inferModel(input: InferModelInput): SemanticModel {
  const { summary } = input;
  const modelName = input.modelName?.trim() || "Default model";
  const isWideFormat = !!summary.wideFormatTransform;
  if (isWideFormat) {
    return inferWideFormatModel(summary, modelName);
  }
  return inferLongFormModel(summary, modelName);
}

/** Re-exported for tests + downstream consumers that want the same hierarchy slot. */
export const EMPTY_HIERARCHIES: SemanticHierarchy[] = [];
