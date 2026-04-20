/**
 * insight_explorer — for "show me something interesting / surprising about my data".
 *
 * Open prompts with no specific metric usually confuse the planner: it picks
 * one tool and produces a shallow answer. This skill builds a small
 * auto-exploration plan from the dataset summary:
 *
 *   1. get_schema_summary — cheap overview with top values (grounds the synth).
 *   2. run_correlation on the primary numeric column (usually a sales / revenue
 *      metric — first numeric in summary.numericColumns).
 *   3. run_breakdown_ranking of that numeric column by the first categorical
 *      dimension we can find (skipping ID-like columns).
 *   4. build_chart: bar, metric by dimension (depends on step 3).
 *
 * Skill opts into parallelizable: steps 1/2/3 have no inter-dependencies.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief, DataSummary } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./index.js";

const SKILL_NAME = "insight_explorer";

const ID_LIKE_PATTERN = /(^|[_\s])(id|uuid|guid|code|key)(_|\s|$)/i;

function firstCategoricalDimension(summary: DataSummary): string | null {
  const numericSet = new Set(summary.numericColumns ?? []);
  const dateSet = new Set(summary.dateColumns ?? []);
  for (const col of summary.columns ?? []) {
    if (numericSet.has(col.name)) continue;
    if (dateSet.has(col.name)) continue;
    if (ID_LIKE_PATTERN.test(col.name)) continue;
    return col.name;
  }
  return null;
}

const skill: AnalysisSkill = {
  name: SKILL_NAME,
  description:
    "For open-ended 'show me surprising / interesting things' prompts: cheap auto-exploration (schema overview + top numeric driver + top categorical breakdown + bar chart).",
  handles: ["exploration"],

  appliesTo(brief, ctx): boolean {
    if (brief.questionShape !== "exploration") return false;
    const hasAny =
      (ctx.summary?.columns?.length ?? 0) > 0 &&
      ((ctx.summary?.numericColumns?.length ?? 0) > 0 ||
        firstCategoricalDimension(ctx.summary) != null);
    return hasAny;
  },

  plan(_brief, ctx): SkillInvocation | null {
    const numericCols = ctx.summary?.numericColumns ?? [];
    const primaryNumeric = numericCols[0];
    const firstDim = firstCategoricalDimension(ctx.summary);

    const steps: PlanStep[] = [];

    // Step 1 — always start with a cheap schema overview.
    steps.push({
      id: "ins_schema",
      tool: "get_schema_summary",
      args: {},
    });

    // Step 2 — correlation on the primary numeric column (if one exists).
    if (primaryNumeric) {
      steps.push({
        id: "ins_correlation",
        tool: "run_correlation",
        args: {
          targetVariable: primaryNumeric,
          filter: "all",
        },
      });
    }

    // Step 3 — breakdown of the primary numeric by the first categorical dim.
    if (primaryNumeric && firstDim) {
      steps.push({
        id: "ins_breakdown",
        tool: "run_breakdown_ranking",
        args: {
          metricColumn: primaryNumeric,
          breakdownColumn: firstDim,
          aggregation: "sum",
          topN: 10,
        },
      });

      // Step 4 — chart anchored on the breakdown.
      steps.push({
        id: "ins_chart",
        tool: "build_chart",
        args: {
          type: "bar",
          x: firstDim,
          y: `${primaryNumeric}_sum`,
          title: `${primaryNumeric} by ${firstDim}`,
          aggregate: "none",
        },
        dependsOn: "ins_breakdown",
      });
    }

    // Schema-only plans aren't worth a skill dispatch; let the planner handle them.
    if (steps.length < 2) return null;

    return {
      id: `ins-${Date.now().toString(36)}`,
      label: `Auto-exploration (${primaryNumeric ?? "schema"})`,
      steps,
      parallelizable: true,
      rationale: `insight_explorer expanded into ${steps.length} step(s). Primary numeric=${primaryNumeric ?? "(none)"}, first dim=${firstDim ?? "(none)"}.`,
    };
  },
};

registerSkill(skill);

export { skill as insightExplorerSkill };
