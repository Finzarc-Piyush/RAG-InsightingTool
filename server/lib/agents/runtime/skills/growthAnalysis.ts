/**
 * ============================================================================
 * growthAnalysis.ts — the "trend / growth over time" analysis skill
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines the skill that answers period-over-period growth questions: trends,
 *   "fastest growing market", "biggest decliner", YoY/QoQ/MoM/WoW change, CAGR,
 *   momentum, etc. It fires when the user's wording matches growth keywords (or
 *   the brief is tagged as a "trend" shape) AND the dataset has a time axis —
 *   either a raw date column or a "wide-format" PeriodIso column (a normalised
 *   period label like 2024-Q3 derived when each row holds many period columns).
 *   It does not do the math itself; it composes existing tools:
 *     - retrieve_semantic_context — pulls background RAG context (round 1).
 *     - compute_growth — the actual growth math. Three routes:
 *         * rankByGrowth mode for "fastest/slowest" questions (one call, the
 *           ranked segments ARE the headline).
 *         * series + summary pair for open-ended trends when the data spans ≥2
 *           CALENDAR periods (per-segment AND total YoY/QoQ/MoM/WoW growth).
 *         * trend mode for a single contiguous span (e.g. one month of daily
 *           rows) where calendar period-over-period is impossible — a
 *           sequential consecutive-delta trajectory (direction, start→end
 *           change, peak/trough, slope/R²). The chart then plots the metric
 *           LEVEL over time ("X over time") rather than growth_pct.
 *     - detect_seasonality — auto-added only when the data has enough history
 *       (>=2 years and either >=6 months or >=4 quarters in a year), so the
 *       answer says "Q4 peaks every year" rather than "Nov 2018 was the peak".
 *     - build_chart — a line or bar chart of the growth.
 *
 * WHY IT MATTERS
 *   Growth/trend is a top question shape and the most error-prone to narrate.
 *   The seasonality guard and the series+summary pairing exist specifically to
 *   stop the final answer from over-reading a single spike or computing growth
 *   across only two periods. It sits at priority 5: above the broad fallback
 *   skills (0) but below time_window_diff (10), which wins when the user names
 *   two explicit periods to compare.
 *
 * KEY PIECES
 *   - GROWTH_KEYWORD_REGEX / RANK_BY_GROWTH_PATTERN — wording detectors that
 *     decide activation and which compute_growth mode to use.
 *   - pickPeriodColumns — finds the time axis (wide-format PeriodIso first,
 *     else first raw date column).
 *   - scanCalendarCoverage / hasMultiPeriodCalendarCoverage / hasSeasonalityCoverage
 *     (shared pure helpers in server/lib/growth/temporalCoverage.ts) — decide
 *     trend-vs-calendar routing and whether there is enough history for
 *     seasonality. Shared with the tool layer; cycle-safe (same tier as
 *     periodShift.ts).
 *   - pickDimensionColumn / pickGrainFromBrief / resolveDimensionFiltersFromBrief
 *     — translate the brief into a segment dimension, a growth grain
 *     (yoy/qoq/mom/wow/auto), and tool-shaped filters.
 *   - skill (exported as growthAnalysisSkill) — the AnalysisSkill object.
 *
 * HOW IT CONNECTS
 *   Self-registers via registerSkill (registry.ts) when imported from
 *   skills/index.ts; selected/expanded by selectSkill / expandSkill. GrowthGrain
 *   type comes from server/lib/growth/periodShift.js. The seasonality coverage
 *   check intentionally duplicates a small helper from computeGrowthTool.ts to
 *   avoid an import cycle through the tools layer.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./registry.js";
import type { GrowthGrain } from "../../../growth/periodShift.js";
import {
  scanCalendarCoverage,
  hasMultiPeriodCalendarCoverage,
  hasSeasonalityCoverage,
} from "../../../growth/temporalCoverage.js";

const SKILL_NAME = "growth_analysis";

const GROWTH_KEYWORD_REGEX =
  /\b(growth|growing|grew|grow|declin|decline|declining|trend|over time|year[\s-]?over[\s-]?year|y\.?o\.?y|q\.?o\.?q|m\.?o\.?m|w\.?o\.?w|fastest|slowest|biggest decline|cagr|momentum|accelerat|deceler|change over)\b/i;

const RANK_BY_GROWTH_PATTERN =
  /\b(fastest|slowest|biggest decline|biggest declin|top growing|leading grow|top declin|biggest growth|highest growth|lowest growth|worst declin)\b/i;

/** Detect period column from wide-format transform OR first dateColumn. */
function pickPeriodColumns(ctx: AgentExecutionContext): {
  periodIsoColumn?: string;
  dateColumn?: string;
} {
  const wft = ctx.summary?.wideFormatTransform;
  if (wft?.detected && wft.periodIsoColumn) {
    return { periodIsoColumn: wft.periodIsoColumn };
  }
  const dateCol = ctx.summary?.dateColumns?.[0];
  if (dateCol) return { dateColumn: dateCol };
  return {};
}

function pickDimensionColumn(brief: AnalysisBrief): string | undefined {
  // Prefer the first segmentation dimension the user named, then fall back
  // to the first candidate driver. Mirrors the timeWindowDiff convention.
  const seg = brief.segmentationDimensions?.[0];
  if (seg) return seg;
  return brief.candidateDriverDimensions?.[0];
}

function pickGrainFromBrief(brief: AnalysisBrief): GrowthGrain | "auto" {
  // brief.timeWindow.grainPreference: daily | weekly | monthly | yearly | unspecified
  const pref = brief.timeWindow?.grainPreference;
  if (pref === "yearly") return "yoy";
  if (pref === "monthly") return "mom";
  if (pref === "weekly") return "wow";
  // QoQ has no direct preference label. Daily has no calendar grain (there is
  // no day-over-day enum), and mapping it to "wow" only produced all-null
  // growth (priorPeriodKey can't week-shift a YYYY-MM-DD label). Defer to
  // "auto": on multi-period data the tool picks a coarse grain; on a single
  // contiguous daily span the skill routes to compute_growth mode "trend"
  // (consecutive deltas, grain-free).
  return "auto";
}

function resolveDimensionFiltersFromBrief(
  brief: AnalysisBrief
): Array<{
  column: string;
  op: "in" | "not_in";
  values: string[];
  match?: "case_insensitive";
}> {
  if (!Array.isArray(brief.filters)) return [];
  return brief.filters
    .filter((f) => Array.isArray(f.values) && f.values.length > 0)
    .map((f) => ({
      column: f.column,
      op: f.op === "not_in" ? "not_in" : "in",
      values: f.values.map((v) => String(v)),
      match: "case_insensitive" as const,
    }));
}

const skill: AnalysisSkill = {
  name: SKILL_NAME,
  description:
    "For trend / growth / 'fastest growing' / 'biggest decliner' questions: compute YoY/QoQ/MoM/WoW growth across all available periods (not just Year-1 vs Year-2) and, when a dimension is at hand, rank segments by growth so the synthesiser can name the fastest-growing / fastest-declining markets.",
  handles: ["trend", "comparison", "exploration", "descriptive"],
  // Above varianceDecomposer (0) and below timeWindowDiff (10) — explicit
  // A-vs-B questions still win.
  priority: 5,

  appliesTo(brief, ctx): boolean {
    // 1. Outcome metric required so we know what to grow.
    if (!brief.outcomeMetricColumn) return false;
    // 2. Some temporal axis must exist.
    const { periodIsoColumn, dateColumn } = pickPeriodColumns(ctx);
    if (!periodIsoColumn && !dateColumn) return false;
    // 3. timeWindowDiff wins on explicit comparisonPeriods.
    if (brief.comparisonPeriods?.a?.length && brief.comparisonPeriods?.b?.length) {
      return false;
    }
    // 4. Activate on questionShape="trend" OR keyword match in the question text.
    if (brief.questionShape === "trend") return true;
    const q = ctx.question ?? "";
    if (GROWTH_KEYWORD_REGEX.test(q)) return true;
    return false;
  },

  plan(brief, ctx): SkillInvocation | null {
    const outcome = brief.outcomeMetricColumn;
    if (!outcome) return null;

    const { periodIsoColumn, dateColumn } = pickPeriodColumns(ctx);
    if (!periodIsoColumn && !dateColumn) return null;

    // Decide trend-vs-calendar routing. When the data is a single contiguous
    // span (e.g. one month of daily rows), calendar period-over-period growth
    // is impossible — route the open-ended trend to compute_growth mode
    // "trend" (sequential consecutive deltas) instead of summary/series, which
    // would otherwise return all-null growth and a defeatist "no pairs" answer.
    const periodCol = periodIsoColumn ?? dateColumn!;
    const cov = scanCalendarCoverage(ctx.data ?? [], periodCol);
    const useSequentialTrend = !hasMultiPeriodCalendarCoverage(cov);

    const dimension = pickDimensionColumn(brief);
    const grain = pickGrainFromBrief(brief);
    const filters = resolveDimensionFiltersFromBrief(brief);
    const isRankByGrowth =
      RANK_BY_GROWTH_PATTERN.test(ctx.question ?? "") && Boolean(dimension);

    // Compound-shape datasets: surface a Metric filter from the brief
    // when present; otherwise the planner's WPF2 guard or the tool's
    // own defense-in-depth refusal will redirect.
    const wft = ctx.summary?.wideFormatTransform;
    const compoundMetricCol =
      wft?.detected && wft.shape === "compound" ? wft.metricColumn : undefined;
    const briefHasMetricFilter =
      compoundMetricCol && filters.some((f) => f.column === compoundMetricCol);

    const baseGrowthArgs: Record<string, unknown> = {
      metricColumn: outcome,
      ...(periodIsoColumn ? { periodIsoColumn } : {}),
      ...(dateColumn && !periodIsoColumn ? { dateColumn } : {}),
      grain,
      ...(filters.length > 0 ? { dimensionFilters: filters } : {}),
    };

    const steps: PlanStep[] = [];

    // Step 1 — RAG round-1.
    steps.push({
      id: "ga_rag",
      tool: "retrieve_semantic_context",
      args: {
        query:
          (ctx.question ?? "").slice(0, 500) ||
          `Background context for trend / growth analysis on ${outcome}`,
      },
    });

    if (isRankByGrowth) {
      // "Fastest growing market" — single rankByGrowth call; that's the
      // headline. Skip the redundant series step (the rank rows already
      // contain the latest growth_pct per segment).
      steps.push({
        id: "ga_rank",
        tool: "compute_growth",
        args: {
          ...baseGrowthArgs,
          dimensionColumn: dimension,
          mode: "rankByGrowth",
          topN: 10,
        },
      });
      // Bar chart of the rank.
      steps.push({
        id: "ga_chart",
        tool: "build_chart",
        args: {
          type: "bar",
          x: "dimension",
          y: "growth_pct",
          title: `${outcome} — fastest-growing ${dimension} (latest period growth)`,
          aggregate: "none",
        },
        dependsOn: "ga_rank",
      });
    } else {
      // Open-ended trend — surface the time series with growth pairs.
      // Add an aggregate "summary" pass so the synthesiser sees both
      // per-segment and total growth.
      if (dimension) {
        steps.push({
          id: "ga_series",
          tool: "compute_growth",
          args: {
            ...baseGrowthArgs,
            dimensionColumn: dimension,
            mode: useSequentialTrend ? "trend" : "series",
          },
          parallelGroup: "ga_parallel",
        });
      }
      steps.push({
        id: "ga_summary",
        tool: "compute_growth",
        args: {
          ...baseGrowthArgs,
          mode: useSequentialTrend ? "trend" : "summary",
        },
        parallelGroup: "ga_parallel",
      });
      // Seasonality step — surfaces recurring within-year peaks
      // (Q4 holiday spike, Q1 summer peak, etc.). Auto-emitted when the
      // dataset has ≥2 years × ≥6 months OR ≥4 quarters; otherwise the
      // tool would refuse anyway. Critical for trend questions: stops
      // the narrator from reporting "Nov 2018 was the peak" when the
      // truth is "Q4 consistently peaks every year".
      const supportsSeasonality = hasSeasonalityCoverage(cov);
      if (supportsSeasonality) {
        const seasonalityArgs: Record<string, unknown> = {
          metricColumn: outcome,
          ...(periodIsoColumn ? { periodIsoColumn } : {}),
          ...(dateColumn && !periodIsoColumn ? { dateColumn } : {}),
          granularity: "auto",
          ...(filters.length > 0 ? { dimensionFilters: filters } : {}),
        };
        steps.push({
          id: "ga_seasonality",
          tool: "detect_seasonality",
          args: seasonalityArgs,
          parallelGroup: "ga_parallel",
        });
      }
      // Line chart of the time series. In trend mode plot the metric LEVEL
      // over time (the "X over time" line the user wants); in calendar mode
      // plot the growth_pct series. Both source the ga_summary rows, which
      // carry both `value` and `growth_pct`.
      steps.push({
        id: "ga_chart",
        tool: "build_chart",
        args: {
          type: "line",
          x: "period",
          ...(useSequentialTrend
            ? { y: "value", title: `${outcome} over time` }
            : { y: "growth_pct", title: `${outcome} — growth over time` }),
          aggregate: "none",
        },
        dependsOn: "ga_summary",
      });
    }

    return {
      id: `ga-${Date.now().toString(36)}`,
      label: isRankByGrowth
        ? `${outcome} · fastest-growing ${dimension ?? "segments"}`
        : `${outcome} · growth over time`,
      steps,
      // RAG / two compute_growth calls are independent of each other and
      // of the chart (which dependsOn ga_summary). Parallel runner respects
      // dependsOn so the chart waits for its source.
      parallelizable: true,
      rationale: `growth_analysis expanded into ${steps.length} step(s). Outcome=${outcome}, grain=${grain}, dimension=${dimension ?? "(none)"}, mode=${
        isRankByGrowth
          ? "rankByGrowth"
          : useSequentialTrend
            ? "trend(sequential)"
            : "series+summary(calendar)"
      }, calendar_coverage=${hasMultiPeriodCalendarCoverage(cov)}, seasonality_emitted=${
        !isRankByGrowth && hasSeasonalityCoverage(cov)
      }, ${briefHasMetricFilter ? "metric_filter_present" : "no_metric_filter"}.`,
    };
  },
};

registerSkill(skill);

export { skill as growthAnalysisSkill };
