/**
 * Wave W-GMK4 · resolveFactsMetric
 *
 * Pure helper that recognises a narrow-format Facts/Metric/KPI discriminator
 * column at chart-build time. When the result table contains a column whose
 * values name MEASURES (e.g. Nielsen-style "Value Sales", "Volume Sales",
 * "Distribution" all in a `Facts` column with a single numeric `Value`),
 * the chart layer must:
 *
 *   1. Pick ONE Facts value (matched to the user question if possible,
 *      else most-common) and filter rows to that value before charting.
 *   2. Surface the chosen Facts value in the chart title instead of a
 *      generic `<numericCol>_sum by <xField>` heading.
 *
 * Without this, the chart system summed across mixed metric types
 * (Sales + Volume + Distribution + ...) producing zero / nonsense, OR
 * tried to project a literal column named `Sales Value_sum` that doesn't
 * exist in the data — the cause of the "Sales Value_sum by Products = 0"
 * symptom in the Marico FMCG screenshots.
 *
 * Pure: no IO, no LLM, no side effects.
 */
import type { DataSummary } from "../shared/schema.js";

export interface FactsMetricDecision {
  /** The metric discriminator column, or null when no Facts handling applies. */
  metricColumn: string | null;
  /** The chosen Facts value (e.g. "Value Sales") — used for chart title. */
  metricValue?: string;
  /** Filter to inject so the chart only sees rows for this metric. */
  injectedFilter?: { column: string; op: "eq"; value: string };
  /** Human-readable explanation appended to axisReason / title hint. */
  reason: string;
}

/** Column names heuristically recognised as Facts discriminators. */
const FACTS_COLUMN_NAME_RE = /^(facts?|metric|kpi|measure_name|metric_name)$/i;

/** Words that suggest the user-question is asking about a specific Facts value. */
const SALES_VALUE_HINTS = ["value sales", "sales value", "revenue", "turnover", "gmv"];
const SALES_VOLUME_HINTS = ["volume sales", "sales volume", "units", "volume"];
const DISTRIBUTION_HINTS = ["distribution", "weighted distribution", "numeric distribution", "acv", "tdp"];
const SHARE_HINTS = ["share", "value share", "volume share", "market share"];

function detectMetricColumn(
  columns: string[],
  summary: DataSummary
): string | null {
  const fromTransform = summary.wideFormatTransform?.metricColumn;
  if (fromTransform && columns.includes(fromTransform)) return fromTransform;
  for (const col of columns) {
    if (FACTS_COLUMN_NAME_RE.test(col)) return col;
  }
  return null;
}

function distinctValuesInSample(
  col: string,
  sample: Record<string, unknown>[],
  cap = 32
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of sample) {
    const v = r?.[col];
    if (typeof v !== "string") continue;
    const norm = v.trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= cap) break;
  }
  return out;
}

function dominantValue(
  col: string,
  sample: Record<string, unknown>[]
): string | null {
  const counts = new Map<string, number>();
  for (const r of sample) {
    const v = r?.[col];
    if (typeof v !== "string") continue;
    const norm = v.trim();
    if (!norm) continue;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }
  let best: { value: string; count: number } | null = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count) best = { value, count };
  }
  return best?.value ?? null;
}

function matchFromQuestion(
  values: string[],
  question: string
): string | null {
  const q = question.toLowerCase();
  // Pass 1: literal case-insensitive substring of the value itself.
  for (const v of values) {
    if (q.includes(v.toLowerCase())) return v;
  }
  // Pass 2: synonym buckets. Pick the first value whose lowered form
  // matches any keyword in a bucket the question also matches.
  const buckets: Array<{ hints: string[]; needles: string[] }> = [
    { hints: SALES_VALUE_HINTS, needles: ["value sales", "value_sales", "sales value", "sales_value"] },
    { hints: SALES_VOLUME_HINTS, needles: ["volume sales", "volume_sales", "sales volume", "sales_volume"] },
    { hints: DISTRIBUTION_HINTS, needles: ["distribution", "acv", "tdp"] },
    { hints: SHARE_HINTS, needles: ["share"] },
  ];
  for (const b of buckets) {
    if (!b.hints.some((h) => q.includes(h))) continue;
    const hit = values.find((v) =>
      b.needles.some((n) => v.toLowerCase().includes(n))
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Decide whether (and how) to apply Facts/Metric-value filtering for a chart.
 *
 * Returns `{ metricColumn: null }` when:
 *   - no metric-discriminator column is present, OR
 *   - the metric column has 0/1 distinct values (no choice to make).
 *
 * Returns a populated decision when ≥2 distinct values exist:
 *   - `metricValue` is the question-matched value if any, else the dominant
 *     (highest-row-count) value in the sample.
 *   - `injectedFilter` constrains rows to that metric value.
 *   - `reason` describes the choice for the chart card subtitle.
 */
export function resolveFactsMetric(
  columns: string[],
  sample: Record<string, unknown>[],
  summary: DataSummary,
  question?: string
): FactsMetricDecision {
  const metricColumn = detectMetricColumn(columns, summary);
  if (!metricColumn) {
    return { metricColumn: null, reason: "" };
  }
  const values = distinctValuesInSample(metricColumn, sample);
  if (values.length < 2) {
    return { metricColumn: null, reason: "" };
  }

  const fromQuestion = question
    ? matchFromQuestion(values, question)
    : null;
  const metricValue =
    fromQuestion ?? dominantValue(metricColumn, sample) ?? values[0]!;

  const reason = fromQuestion
    ? `Showing ${metricColumn} = ${metricValue} (matched from your question)`
    : `Showing ${metricColumn} = ${metricValue} (most common value in this slice)`;

  return {
    metricColumn,
    metricValue,
    injectedFilter: { column: metricColumn, op: "eq", value: metricValue },
    reason,
  };
}
