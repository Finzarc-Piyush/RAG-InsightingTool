/**
 * time_window_diff — for explicit "period A vs period B" comparisons.
 *
 * Activates only when the brief parser has populated `comparisonPeriods`
 * with two filter sets and the turn has an outcome metric. The skill
 * leaves the narrative math to the synthesiser (Phase-1 PR 1.G rich
 * envelope); its job is to pre-package the right evidence so the
 * synthesiser can explain the delta with magnitudes:
 *
 *   1. run_two_segment_compare on the outcome metric with
 *      segment_a_filters / segment_b_filters pulled from
 *      comparisonPeriods. Gives the headline delta.
 *   2. For each candidateDriverDimension (cap 2), a pair of
 *      run_breakdown_ranking calls — one per period — so the
 *      synthesiser can name which segments moved most.
 *   3. A bar chart on the two-segment result as a visual anchor.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./registry.js";

const SKILL_NAME = "time_window_diff";

interface Filter {
  column: string;
  op: "in" | "not_in";
  values: string[];
  match?: "exact" | "case_insensitive";
}

function resolveFilters(
  raw: ReadonlyArray<{ column: string; op: "in" | "not_in"; values: string[]; match?: "exact" | "case_insensitive" }>
): Filter[] {
  return raw
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
    "For 'period A vs period B' questions (e.g. 'Mar-22 vs Apr-25', 'Q3 vs Q4'): package a two-segment compare + per-period breakdowns + bar chart so the synthesiser can explain the delta with magnitudes.",
  handles: ["comparison", "variance_diagnostic"],
  // Narrower than variance_decomposer — needs comparisonPeriods on the
  // brief. Priority ensures we win the selection when both match.
  priority: 10,

  appliesTo(brief, _ctx): boolean {
    if (!brief.outcomeMetricColumn) return false;
    const cp = brief.comparisonPeriods;
    if (!cp || !cp.a?.length || !cp.b?.length) return false;
    return (
      brief.questionShape === "comparison" ||
      brief.questionShape === "variance_diagnostic"
    );
  },

  plan(brief, ctx): SkillInvocation | null {
    const outcome = brief.outcomeMetricColumn;
    const cp = brief.comparisonPeriods;
    if (!outcome || !cp) return null;

    const aFilters = resolveFilters(cp.a);
    const bFilters = resolveFilters(cp.b);
    if (aFilters.length === 0 || bFilters.length === 0) return null;

    const aLabel = cp.aLabel?.trim() || "Period A";
    const bLabel = cp.bLabel?.trim() || "Period B";

    const steps: PlanStep[] = [];

    // Step 1 — headline delta.
    steps.push({
      id: "twd_compare",
      tool: "run_two_segment_compare",
      args: {
        metricColumn: outcome,
        segment_a_label: aLabel.slice(0, 80),
        segment_b_label: bLabel.slice(0, 80),
        segment_a_filters: aFilters,
        segment_b_filters: bFilters,
        aggregation: "sum",
      },
    });

    // Steps 2/3 — per-period breakdowns on the first driver dimension.
    const drivers = (brief.candidateDriverDimensions ?? []).slice(0, 1);
    drivers.forEach((dim) => {
      steps.push({
        id: "twd_breakdown_a",
        tool: "run_breakdown_ranking",
        args: {
          metricColumn: outcome,
          breakdownColumn: dim,
          aggregation: "sum",
          topN: 10,
          dimensionFilters: aFilters,
        },
      });
      steps.push({
        id: "twd_breakdown_b",
        tool: "run_breakdown_ranking",
        args: {
          metricColumn: outcome,
          breakdownColumn: dim,
          aggregation: "sum",
          topN: 10,
          dimensionFilters: bFilters,
        },
      });
    });

    // Step 4 — bar chart of the compare result.
    steps.push({
      id: "twd_chart",
      tool: "build_chart",
      args: {
        type: "bar",
        x: "segment",
        y: outcome,
        title: `${outcome}: ${aLabel} vs ${bLabel}`,
        aggregate: "sum",
      },
      dependsOn: "twd_compare",
    });

    return {
      id: `twd-${Date.now().toString(36)}`,
      label: `${outcome} · ${aLabel} vs ${bLabel}`,
      steps,
      // Step 1 and the two breakdowns are read-only on row-level data;
      // only the chart depends on Step 1. The parallel runner respects
      // dependsOn so the chart waits.
      parallelizable: true,
      rationale: `time_window_diff expanded into ${steps.length} step(s). Outcome=${outcome}, periods=[${aLabel} vs ${bLabel}], driver=${drivers[0] ?? "(none)"}.`,
    };
  },
};

registerSkill(skill);

export { skill as timeWindowDiffSkill };
