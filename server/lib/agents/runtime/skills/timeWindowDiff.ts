/**
 * ============================================================================
 * timeWindowDiff.ts — the explicit "period A vs period B" comparison skill
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines the skill for questions that name two specific time windows to
 *   compare, e.g. "Mar-22 vs Apr-25" or "Q3 vs Q4". It fires only when the
 *   brief parser has filled in `comparisonPeriods` (two filter sets, A and B)
 *   and there is an outcome metric. It does not narrate the delta itself; it
 *   pre-packages the evidence so the final answer can explain the change with
 *   numbers:
 *     1. run_two_segment_compare on the outcome metric, with segment A/B
 *        filters taken from comparisonPeriods — produces the headline delta.
 *     2. For the first candidate driver dimension, a pair of
 *        run_breakdown_ranking calls (one per period) so the answer can say
 *        which segments moved the most.
 *     3. build_chart — a bar chart of the two-segment compare as a visual anchor.
 *
 * WHY IT MATTERS
 *   "A vs B" is a sharp, common ask, and it is the most specific of the
 *   time-related skills. Its priority is 10 — higher than growth_analysis (5)
 *   and variance_decomposer (0) — so when the user explicitly names two periods
 *   this skill wins over the broader trend/variance skills.
 *
 * KEY PIECES
 *   - Filter interface + resolveFilters — normalise the brief's raw filter
 *     objects into the case-insensitive in / not_in shape the tools expect.
 *   - skill (exported as timeWindowDiffSkill) — the AnalysisSkill object;
 *     appliesTo() gates on comparisonPeriods + an outcome metric + a
 *     comparison/variance question shape; plan() builds the steps.
 *
 * HOW IT CONNECTS
 *   Self-registers via registerSkill (registry.ts) when imported from
 *   skills/index.ts; selected/expanded by selectSkill / expandSkill. Steps call
 *   the low-level tools run_two_segment_compare, run_breakdown_ranking, and
 *   build_chart. Brief type comes from the shared AnalysisBrief schema.
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
