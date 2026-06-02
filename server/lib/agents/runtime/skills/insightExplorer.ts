/**
 * ============================================================================
 * insightExplorer.ts — the "show me something interesting" exploration skill
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines the skill that handles open-ended prompts with no specific metric,
 *   like "show me something surprising about my data". Such prompts normally
 *   confuse the planner into picking one tool and giving a shallow answer. This
 *   skill instead reads the dataset summary and auto-builds a cheap exploration
 *   plan:
 *     1. get_schema_summary — quick overview + top values to ground the answer.
 *     2. run_correlation on the primary numeric column (the first numeric, which
 *        is usually a sales/revenue metric).
 *     3. run_breakdown_ranking of that numeric by the first usable categorical
 *        dimension (skipping ID-like columns such as id/uuid/code/key).
 *     4. build_chart — a bar chart of that breakdown (depends on step 3).
 *
 * WHY IT MATTERS
 *   It turns a vague "surprise me" request into a structured, multi-angle
 *   exploration so the user gets a substantive first answer instead of a
 *   one-tool guess. It is a broad fallback skill (default priority 0), so it
 *   only fires when the question is genuinely an open exploration.
 *
 * KEY PIECES
 *   - ID_LIKE_PATTERN — regex used to skip identifier columns when choosing a
 *     dimension to break down by (breaking down sales by a UUID is useless).
 *   - firstCategoricalDimension — picks the first non-numeric, non-date,
 *     non-ID column from the summary.
 *   - skill (exported as insightExplorerSkill) — the AnalysisSkill object;
 *     appliesTo() requires an "exploration" shape with at least some usable
 *     column; plan() bails (returns a non-skill plan) if it can't build >=2
 *     meaningful steps.
 *
 * HOW IT CONNECTS
 *   Self-registers via registerSkill (registry.ts) when imported from
 *   skills/index.ts; chosen/run via selectSkill / expandSkill. Steps call the
 *   low-level tools get_schema_summary, run_correlation, run_breakdown_ranking,
 *   and build_chart. DataSummary type comes from the shared schema.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief, DataSummary } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./registry.js";

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
