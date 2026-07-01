/**
 * Wave W6 (data-bound cards) · pick the top few decision-relevant measures for
 * the Executive-Summary KPI scorecard band. PURE (no I/O) — it produces
 * scorecard DEFINITIONS (measure + default aggregation + PoP comparison);
 * `computeScorecard` fills the snapshots afterwards.
 *
 * Priority (deduped by measure column): the measures the featured charts are
 * ABOUT (highest signal) → exposed semantic-model metrics → additive/ratio
 * numeric columns. Whole-dataset (no filters) — the exec band is the headline.
 */

import type {
  ChartSpec,
  DataSummary,
  SemanticModel,
  DashboardScorecardSpec,
} from "../../shared/schema.js";
import {
  resolveAllowedAggregations,
  resolveMeasureAdditivity,
  deriveScorecardFormat,
} from "../dashboardTileCompose.js";
import { resolveMetricPolarity } from "../financeMetricAuthority.js";

export interface SelectScorecardMetricsArgs {
  summary: DataSummary;
  charts?: ChartSpec[];
  model?: SemanticModel | null;
  /** Max scorecards to emit (executive bands stay legible). */
  max?: number;
}

const DEFAULT_MAX = 6;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "m";
}

function buildDef(
  ref: string,
  label: string,
  kind: "metric" | "column",
  summary: DataSummary,
  model: SemanticModel | null | undefined,
  index: number
): DashboardScorecardSpec {
  const { defaultAggregation } = resolveAllowedAggregations(ref, summary, model);
  const fmt = deriveScorecardFormat(ref, summary);
  return {
    id: `sc_${slug(ref)}_${index}`,
    title: label,
    metricPolarity: resolveMetricPolarity(ref),
    format: fmt.format,
    ...(fmt.currencyCode ? { currencyCode: fmt.currencyCode } : {}),
    cardDefinition: {
      cardType: "scorecard",
      measure: { kind, ref, label },
      aggregation: defaultAggregation,
      comparison: { mode: "period_over_period" },
    },
  };
}

export function selectScorecardMetrics(
  args: SelectScorecardMetricsArgs
): DashboardScorecardSpec[] {
  const { summary, charts, model } = args;
  const max = args.max ?? DEFAULT_MAX;
  const colNames = new Set(summary.columns.map((c) => c.name));
  const seen = new Set<string>();
  const out: DashboardScorecardSpec[] = [];

  const push = (ref: string, label: string, kind: "metric" | "column") => {
    const key = ref.toLowerCase();
    if (seen.has(key) || out.length >= max) return;
    // Only real measures (a dimension/temporal column can't be a KPI value).
    if (kind === "column" && resolveMeasureAdditivity(ref, summary, model) === "none") return;
    seen.add(key);
    out.push(buildDef(ref, label, kind, summary, model, out.length));
  };

  // 1. Measures the featured charts are about (chart Y that maps to a column).
  for (const c of charts ?? []) {
    if (c.y && colNames.has(c.y)) push(c.y, c.y, "column");
  }

  // 2. Exposed curated semantic-model metrics.
  for (const m of model?.metrics ?? []) {
    if (m.exposed === false) continue;
    push(m.name, m.label ?? m.name, "metric");
  }

  // 3. Additive / ratio numeric columns (a real measure, not an id/ordinal).
  for (const name of summary.numericColumns ?? []) {
    if (resolveMeasureAdditivity(name, summary, model) !== "none") push(name, name, "column");
  }

  return out;
}
