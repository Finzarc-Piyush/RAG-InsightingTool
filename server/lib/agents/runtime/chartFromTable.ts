/**
 * ============================================================================
 * chartFromTable.ts — turn a result table into a ready-to-render chart
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the agent runs a data query (`execute_query_plan`) it gets back a
 *   table (rows + column names). This file looks at that table and, using
 *   simple rules, decides whether it can become a sensible chart — and if so,
 *   builds the full chart specification ("ChartSpec": chart type, x/y axes,
 *   processed data, axis scaling). The rules: pick a category column for the
 *   x-axis (preferring a time/period column), pick the most "measure-like"
 *   numeric column for the y-axis (names ending in _sum, _avg, _count rank
 *   higher), use a line chart when x is a date else a bar chart. It bails out
 *   (returns null) when there's no clean chart to make — e.g. a single-row
 *   scalar result, no category column, no numeric column, or too many x labels.
 *
 * WHY IT MATTERS
 *   Charts are first-class output in this product. Without this "promotion"
 *   step, only charts the planner EXPLICITLY asked to build would appear — so a
 *   turn that quietly ran five breakdowns would surface just one chart. This
 *   file auto-promotes those intermediate query results into real charts so the
 *   user sees the full visual story. It mirrors the deterministic fallback in
 *   visualPlanner.ts so auto-built charts look the same as planner-built ones.
 *
 * KEY PIECES
 *   - buildChartFromAnalyticalTable — the main builder: table in, ChartSpec or
 *       null out.
 *   - chartAxisSignature — a stable `(type|x|y|series)` key used to dedupe
 *       charts so the same breakdown isn't shown twice.
 *
 * HOW IT CONNECTS
 *   Called by the agent loop when assembling the final message's charts. Relies
 *   on chartSpecCompiler (compileChartSpec), chartGenerator (processChartData),
 *   axisScaling (calculateSmartDomainsForChart), and the period / facts-metric
 *   resolvers to pick coherent axes for time-series and narrow-format data.
 *
 * Returns `null` when the table doesn't lend itself to a clean chart (no
 * dimension column, no numeric measure, too many X labels, or compile-time
 * validation fails).
 */
import type { ChartSpec, DataSummary } from "../../../shared/schema.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { compileChartSpec } from "../../chartSpecCompiler.js";
import { processChartData } from "../../chartGenerator.js";
import { calculateSmartDomainsForChart } from "../../axisScaling.js";
import { resolvePeriodAxis } from "../../periodColumnResolver.js";
import { resolveFactsMetric } from "../../factsMetricResolver.js";

const TEMPORAL_FACET_PREFIX_RE = /^(Day|Week|Month|Quarter|Half-year|Year) · /;
const X_LABEL_CARDINALITY_CAP = 60;
const ROW_COUNT_CAP = 200;
const MIN_UNIQUE_X_FOR_CARDINALITY_PRUNE = 2;

export interface AnalyticalTable {
  rows: Record<string, unknown>[];
  columns: string[];
}

export interface ChartFromTableInput {
  table: AnalyticalTable;
  summary: DataSummary;
  question: string;
  /** Optional title override; falls back to "{Y} by {X}". */
  title?: string;
}

function isNumericishOnSample(
  col: string,
  sample: Record<string, unknown>[]
): boolean {
  const cap = Math.min(20, sample.length);
  for (let i = 0; i < cap; i++) {
    const v = sample[i]?.[col];
    if (v == null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) return true;
    if (typeof v === "string") {
      const cleaned = v.replace(/[%,]/g, "").trim();
      if (cleaned && Number.isFinite(Number(cleaned))) return true;
    }
  }
  return false;
}

function scoreMeasure(col: string): number {
  const n = col.toLowerCase();
  return (
    (/_sum\b/.test(n) ? 5 : 0) +
    (/_avg\b/.test(n) || /_mean\b/.test(n) ? 4 : 0) +
    (/_count\b/.test(n) ? 3 : 0) +
    (/_min\b/.test(n) || /_max\b/.test(n) ? 2 : 0) +
    (/_total\b/.test(n) ? 1 : 0)
  );
}

/**
 * Stable axis signature for chart-list deduplication.
 * Two charts with the same `(type, x, y, seriesColumn)` are treated as
 * equivalent regardless of title or computed data.
 */
export function chartAxisSignature(
  c: Pick<ChartSpec, "type" | "x" | "y" | "seriesColumn">
): string {
  return `${c.type}|${c.x ?? ""}|${c.y ?? ""}|${c.seriesColumn ?? ""}`;
}

export function buildChartFromAnalyticalTable(
  input: ChartFromTableInput
): ChartSpec | null {
  const { table, summary, question, title } = input;
  const rows = table.rows ?? [];
  const columns = table.columns ?? [];

  if (rows.length === 0 || rows.length > ROW_COUNT_CAP) return null;
  if (columns.length < 2) return null;

  // Pure scalars (1 row) don't have a meaningful x-axis. A ratio shape like
  // `[{ total_visits: 104870, num_days: 30, avg_per_day: 3495.67 }]` — three
  // numerics, zero dimensions — would promote to a bar chart that picks one
  // numeric as x (e.g. num_days=30) and the other as y (avg=3.5K), producing
  // a single bar with a number on the x-axis the user can't interpret. Skip;
  // the user sees the AnswerCard text + the pivot's flat 3-column row instead.
  if (rows.length === 1) return null;

  const sample = rows.slice(0, 80);
  const numericCols = columns.filter((c) => isNumericishOnSample(c, sample));
  const dimCols = columns.filter((c) => !isNumericishOnSample(c, sample));

  if (numericCols.length < 1 || dimCols.length < 1) return null;

  // Pick a coherent time x-axis when periods are present, else fall back to
  // the first non-numeric column with cardinality ≥ 2 (skip
  // single-value dims like Products = MARICO that produce useless one-bar
  // charts). When the period resolver returns a multi-kind column with a
  // PeriodKind discriminator filter, apply that filter to the rows so the
  // downstream chart only sees one coherent kind.
  const periodAxis = resolvePeriodAxis(columns, sample, summary, question);

  let x: string;
  let workingRows = rows;
  let axisReason: string | undefined;

  if (periodAxis.pickedColumn) {
    x = periodAxis.pickedColumn;
    axisReason = periodAxis.reason;
    if (periodAxis.injectedFilter) {
      const f = periodAxis.injectedFilter;
      const filtered = rows.filter(
        (r) => String(r?.[f.column] ?? "").trim() === f.value
      );
      if (filtered.length > 0) workingRows = filtered;
    }
  } else {
    const usableDim = dimCols.find((c) => {
      const distinct = new Set<string>();
      for (const r of sample) {
        const v = r?.[c];
        if (v == null || v === "") continue;
        distinct.add(String(v));
        if (distinct.size >= MIN_UNIQUE_X_FOR_CARDINALITY_PRUNE) break;
      }
      return distinct.size >= MIN_UNIQUE_X_FOR_CARDINALITY_PRUNE;
    });
    if (!usableDim) return null;
    x = usableDim;
  }

  // Facts/Metric awareness — when the result table carries a narrow-format
  // metric discriminator (e.g. `Facts` with values "Value
  // Sales", "Volume Sales", "Distribution") summing across kinds produces
  // nonsense. Pick one Facts value (question-matched or dominant), filter
  // rows to it, and use the value as the measure name in the chart title.
  const factsMetric = resolveFactsMetric(columns, sample, summary, question);
  if (factsMetric.metricColumn && factsMetric.injectedFilter) {
    const f = factsMetric.injectedFilter;
    const filtered = workingRows.filter(
      (r) => String(r?.[f.column] ?? "").trim() === f.value
    );
    if (filtered.length > 0) {
      workingRows = filtered;
      axisReason = axisReason
        ? `${axisReason} · ${factsMetric.reason}`
        : factsMetric.reason;
    }
  }

  const y = numericCols
    .slice()
    .sort((a, b) => scoreMeasure(b) - scoreMeasure(a))[0]!;

  const xTemporal =
    summary.dateColumns.includes(x) ||
    TEMPORAL_FACET_PREFIX_RE.test(x) ||
    x.startsWith("__tf_") ||
    Boolean(periodAxis.pickedColumn);

  const workingSample = workingRows.slice(0, 80);
  const xUnique = new Set(workingSample.map((r) => String(r?.[x] ?? ""))).size;
  if (xUnique > X_LABEL_CARDINALITY_CAP) return null;

  const chartType: "line" | "bar" = xTemporal ? "line" : "bar";

  let compiled: ReturnType<typeof compileChartSpec>;
  try {
    compiled = compileChartSpec(
      workingRows as Record<string, unknown>[],
      {
        numericColumns: summary.numericColumns,
        dateColumns: summary.dateColumns,
      },
      { type: chartType, x, y },
      { columnOrder: columns }
    );
  } catch {
    return null;
  }
  const mp = compiled.merged;

  let spec: ChartSpec;
  try {
    spec = chartSpecSchema.parse({
      type: mp.type,
      title:
        title ??
        (mp.type === "heatmap"
          ? `${mp.z} (${mp.x} × ${mp.y})`
          : factsMetric.metricValue
            ? `${factsMetric.metricValue} by ${mp.x}`
            : `${mp.y} by ${mp.x}`),
      x: mp.x,
      y: mp.y,
      ...(mp.z ? { z: mp.z } : {}),
      ...(mp.seriesColumn ? { seriesColumn: mp.seriesColumn } : {}),
      ...(mp.barLayout ? { barLayout: mp.barLayout } : {}),
      aggregate:
        mp.aggregate ??
        (mp.seriesColumn &&
        (mp.type === "bar" || mp.type === "line" || mp.type === "area")
          ? ("sum" as const)
          : ("none" as const)),
      ...(axisReason ? { axisReason } : {}),
    });
  } catch {
    return null;
  }

  let processed: Record<string, unknown>[];
  try {
    processed = processChartData(workingRows, spec, summary.dateColumns, {
      chartQuestion: question,
    }) as Record<string, unknown>[];
  } catch {
    return null;
  }

  const smartDomains =
    spec.type === "heatmap"
      ? {}
      : calculateSmartDomainsForChart(
          processed as any,
          spec.x as any,
          spec.y as any,
          (spec.y2 as any) || undefined,
          {
            yOptions: {
              useIQR: true,
              paddingPercent: 5,
              includeOutliers: true,
            },
            y2Options: spec.y2
              ? {
                  useIQR: true,
                  paddingPercent: 5,
                  includeOutliers: true,
                }
              : undefined,
          }
        );

  return {
    ...spec,
    xLabel: spec.x,
    yLabel: spec.y,
    data: processed,
    ...smartDomains,
  } as ChartSpec;
}
