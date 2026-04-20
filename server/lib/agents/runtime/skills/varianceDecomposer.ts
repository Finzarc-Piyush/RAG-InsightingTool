/**
 * variance_decomposer — for "why did X fall in segment Y between A and B?" shapes.
 *
 * The skill does NOT itself compute variance decomposition. Its value is
 * ensuring the *right set of evidence* is collected so the synthesiser can
 * explain the fall with magnitudes:
 *
 *  1. Time series of the outcome metric inside the user's filters — the
 *     backbone the narrative will reference.
 *  2. A breakdown on the first candidate driver dimension (e.g. Product
 *     Category) — shows who moved.
 *  3. A breakdown on the second candidate driver (e.g. Channel), if present.
 *  4. A line chart of the time series.
 *
 * No new tool types — every step calls an existing registered tool.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./index.js";

const SKILL_NAME = "variance_decomposer";

function pickDateColumn(ctx: AgentExecutionContext): string | null {
  const dateCols = ctx.summary?.dateColumns ?? [];
  return dateCols[0] ?? null;
}

function resolvedFilters(
  brief: AnalysisBrief
): Array<{ column: string; op: "in" | "not_in"; values: string[]; match?: "case_insensitive" }> {
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
    "For 'why did [metric] fall in [segment] between [A] and [B]' questions: collect time-series + top-contributor breakdowns + a line chart so the synthesiser can explain the variance.",
  handles: ["variance_diagnostic"],

  appliesTo(brief, _ctx): boolean {
    if (brief.questionShape !== "variance_diagnostic") return false;
    // Need an outcome metric to ground the analysis.
    if (!brief.outcomeMetricColumn) return false;
    return true;
  },

  plan(brief, ctx): SkillInvocation | null {
    const outcome = brief.outcomeMetricColumn;
    if (!outcome) return null;

    const dateCol = pickDateColumn(ctx);
    if (!dateCol) return null; // No temporal column to decompose against.

    const filters = resolvedFilters(brief);
    const grain =
      brief.timeWindow?.grainPreference === "daily"
        ? "day"
        : brief.timeWindow?.grainPreference === "weekly"
          ? "week"
          : brief.timeWindow?.grainPreference === "yearly"
            ? "year"
            : "month";

    const steps: PlanStep[] = [];

    // Step 1 — outcome time series within user filters.
    steps.push({
      id: "var_timeseries",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: [dateCol],
          dateAggregationPeriod: grain,
          aggregations: [
            {
              column: outcome,
              operation: "sum",
              alias: `${outcome}_sum`,
            },
          ],
          ...(filters.length > 0 ? { dimensionFilters: filters } : {}),
          sort: [{ column: dateCol, direction: "asc" }],
        },
      },
    });

    // Step 2 — breakdown by first candidate driver, if any.
    const drivers = (brief.candidateDriverDimensions ?? []).slice(0, 2);
    if (drivers.length > 0) {
      steps.push({
        id: "var_breakdown_1",
        tool: "run_breakdown_ranking",
        args: {
          metricColumn: outcome,
          breakdownColumn: drivers[0],
          aggregation: "sum",
          topN: 10,
          ...(filters.length > 0 ? { dimensionFilters: filters } : {}),
        },
      });
    }

    // Step 3 — breakdown by second candidate driver if present.
    if (drivers.length > 1) {
      steps.push({
        id: "var_breakdown_2",
        tool: "run_breakdown_ranking",
        args: {
          metricColumn: outcome,
          breakdownColumn: drivers[1],
          aggregation: "sum",
          topN: 10,
          ...(filters.length > 0 ? { dimensionFilters: filters } : {}),
        },
      });
    }

    // Step 4 — line chart of the time series, depends on step 1.
    steps.push({
      id: "var_chart",
      tool: "build_chart",
      args: {
        type: "line",
        x: dateCol,
        y: `${outcome}_sum`,
        title: `${outcome} over time${filters.length > 0 ? " (filtered)" : ""}`,
        aggregate: "none",
      },
      dependsOn: "var_timeseries",
    });

    const filterNote =
      filters.length > 0
        ? filters
            .map(
              (f) =>
                `${f.column} ${f.op} [${f.values.slice(0, 3).join(", ")}${f.values.length > 3 ? "…" : ""}]`
            )
            .join("; ")
        : "no user filters";

    return {
      id: `var-${Date.now().toString(36)}`,
      label: `Variance decomposition of ${outcome}`,
      steps,
      parallelizable: false,
      rationale: `variance_decomposer expanded into ${steps.length} step(s). Outcome=${outcome}, grain=${grain}, filters=${filterNote}, drivers=[${drivers.join(", ") || "(none)"}].`,
    };
  },
};

registerSkill(skill);

export { skill as varianceDecomposerSkill };
