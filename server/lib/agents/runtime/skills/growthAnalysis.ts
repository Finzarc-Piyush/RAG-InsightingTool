/**
 * WGR4 · growth_analysis skill — period-over-period growth narratives.
 *
 * Activates when the user asks about trend / growth / "fastest growing" /
 * "biggest decliner" and the dataset has a temporal column (raw date OR
 * wide-format PeriodIso). Composes existing tools — `compute_growth`
 * for the math, `build_chart` for the line/bar, `retrieve_semantic_context`
 * for the RAG round-1.
 *
 * Selection priority (per F1 / CLAUDE.md skill convention):
 *   - timeWindowDiff   = 10  (highest — explicit A vs B periods)
 *   - growthAnalysis   = 5   (this — open-ended growth)
 *   - varianceDecomposer / driverDiscovery / insightExplorer = 0
 *
 * The "fastest growing" / "biggest decliner" pattern routes the
 * compute_growth call into `mode: "rankByGrowth"` automatically;
 * otherwise it emits a series + summary pair so the synthesiser has
 * both per-segment and aggregate growth to cite.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./registry.js";
import type { GrowthGrain } from "../../../growth/periodShift.js";

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

/**
 * WSE4 · detect whether the dataset has the temporal coverage required
 * to compute seasonality. We need ≥2 distinct years AND either ≥6
 * distinct months in a single year (monthly cadence) OR ≥4 distinct
 * quarters in a single year (quarterly cadence). Without that, the
 * seasonality tool refuses; emitting the step would be wasted work.
 *
 * Heuristic only — works on either wide-format PeriodIso labels or
 * raw date strings. Mirrors the in-memory `detectTemporalCoverage`
 * helper in computeGrowthTool.ts (kept inline here to avoid a new
 * import cycle through the tools layer; the shape is small).
 */
function hasSeasonalityTemporalCoverage(ctx: AgentExecutionContext): boolean {
  const data = ctx.data ?? [];
  if (data.length === 0) return false;
  const wft = ctx.summary?.wideFormatTransform;
  const periodCol = wft?.detected ? wft.periodIsoColumn : ctx.summary?.dateColumns?.[0];
  if (!periodCol) return false;
  const years = new Set<string>();
  const monthsByYear: Record<string, Set<string>> = {};
  const quartersByYear: Record<string, Set<string>> = {};
  // Cap scan so this never dominates plan time on huge in-memory frames.
  const SCAN_CAP = 5000;
  for (let i = 0; i < Math.min(data.length, SCAN_CAP); i++) {
    const v = (data[i] as Record<string, unknown>)[periodCol];
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    const yearMatch = s.match(/^(\d{4})/);
    if (yearMatch) years.add(yearMatch[1]);
    if (/^\d{4}-\d{2}$/.test(s)) {
      const y = s.slice(0, 4);
      monthsByYear[y] ??= new Set();
      monthsByYear[y].add(s);
    } else if (/^\d{4}-Q[1-4]$/.test(s)) {
      const y = s.slice(0, 4);
      quartersByYear[y] ??= new Set();
      quartersByYear[y].add(s);
    } else {
      // Raw date — try to parse first 7 chars as YYYY-MM, then bucket.
      const ymMatch = s.match(/^(\d{4})-(\d{1,2})/);
      if (ymMatch) {
        const y = ymMatch[1];
        monthsByYear[y] ??= new Set();
        monthsByYear[y].add(`${y}-${ymMatch[2].padStart(2, "0")}`);
      }
    }
  }
  if (years.size < 2) return false;
  const maxM = Math.max(0, ...Object.values(monthsByYear).map((s) => s.size));
  const maxQ = Math.max(0, ...Object.values(quartersByYear).map((s) => s.size));
  return maxM >= 6 || maxQ >= 4;
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
  // QoQ has no direct preference label; daily/unspecified → auto.
  if (pref === "daily") return "wow";
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
  // A-vs-B questions still win. See skillSelectionPriority.test.ts.
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
            mode: "series",
          },
          parallelGroup: "ga_parallel",
        });
      }
      steps.push({
        id: "ga_summary",
        tool: "compute_growth",
        args: {
          ...baseGrowthArgs,
          mode: "summary",
        },
        parallelGroup: "ga_parallel",
      });
      // WSE4 · seasonality step — surfaces recurring within-year peaks
      // (Q4 holiday spike, Q1 summer peak, etc.). Auto-emitted when the
      // dataset has ≥2 years × ≥6 months OR ≥4 quarters; otherwise the
      // tool would refuse anyway. Critical for trend questions: stops
      // the narrator from reporting "Nov 2018 was the peak" when the
      // truth is "Q4 consistently peaks every year".
      const supportsSeasonality = hasSeasonalityTemporalCoverage(ctx);
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
      // Line chart of the aggregated growth series.
      steps.push({
        id: "ga_chart",
        tool: "build_chart",
        args: {
          type: "line",
          x: "period",
          y: "growth_pct",
          title: `${outcome} — growth over time`,
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
      rationale: `growth_analysis expanded into ${steps.length} step(s). Outcome=${outcome}, grain=${grain}, dimension=${dimension ?? "(none)"}, mode=${isRankByGrowth ? "rankByGrowth" : "series+summary"}, seasonality_emitted=${
        !isRankByGrowth && hasSeasonalityTemporalCoverage(ctx)
      }, ${briefHasMetricFilter ? "metric_filter_present" : "no_metric_filter"}.`,
    };
  },
};

registerSkill(skill);

export { skill as growthAnalysisSkill };
