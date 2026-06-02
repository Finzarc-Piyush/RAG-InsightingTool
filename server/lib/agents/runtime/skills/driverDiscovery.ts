/**
 * ============================================================================
 * driverDiscovery.ts — the "what impacts my metric the most?" analysis skill
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines one "skill": a reusable, multi-step analytical routine the agent
 *   can fire when a user asks something like "what drives my sales?" Instead of
 *   the agent guessing one tool, this skill pre-packages a small plan of tool
 *   calls so the final answer can rank the true drivers with numbers behind
 *   them. The plan it builds:
 *     1. run_correlation on the outcome metric — finds which NUMERIC columns
 *        move together with it (e.g. ad-spend correlates with sales).
 *     2. run_breakdown_ranking for up to 2 candidate CATEGORICAL dimensions —
 *        finds which category values (e.g. region, channel) show the biggest
 *        per-segment swings in the outcome.
 *     3. build_chart — a bar chart of the first breakdown as a visual anchor.
 *   The "synthesiser" (the step that writes the final answer) then ranks the
 *   drivers across both evidence types and explains the top few with magnitudes.
 *
 * WHY IT MATTERS
 *   "What drives X?" is one of the most common analytical question shapes.
 *   Without this skill the planner tends to pick a single shallow tool; the
 *   skill guarantees both numeric (correlation) and categorical (breakdown)
 *   evidence is collected in one shot, producing a far richer answer.
 *
 * KEY PIECES
 *   - resolvedFilters — converts the brief's user filters into the shape the
 *     correlation / breakdown tools expect (case-insensitive in / not_in).
 *   - skill (exported as driverDiscoverySkill) — the AnalysisSkill object:
 *     appliesTo() decides when to fire; plan() builds the tool-call steps.
 *
 * HOW IT CONNECTS
 *   Registers itself into the skill registry via registerSkill (registry.ts)
 *   on import; that import is triggered from skills/index.ts. The planner uses
 *   selectSkill / expandSkill (registry.ts) to choose and run it. Step "tools"
 *   (run_correlation, run_breakdown_ranking, build_chart) are low-level tools
 *   registered elsewhere in the agent runtime. Types come from ./types.js and
 *   the shared AnalysisBrief schema.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./registry.js";

const SKILL_NAME = "driver_discovery";

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
    "For 'what impacts / drives / affects [metric] most?' questions: run correlation on numerics + top-contributor breakdowns for categorical candidates, so the synthesiser can rank drivers with magnitudes.",
  handles: ["driver_discovery"],

  appliesTo(brief, _ctx): boolean {
    if (brief.questionShape !== "driver_discovery") return false;
    if (!brief.outcomeMetricColumn) return false;
    return true;
  },

  plan(brief, ctx): SkillInvocation | null {
    const outcome = brief.outcomeMetricColumn;
    if (!outcome) return null;

    const filters = resolvedFilters(brief);
    const numericCols = ctx.summary?.numericColumns ?? [];
    const outcomeIsNumeric = numericCols.includes(outcome);

    const steps: PlanStep[] = [];

    // Step 1 — correlation on the outcome metric (numeric drivers).
    if (outcomeIsNumeric) {
      steps.push({
        id: "drv_correlation",
        tool: "run_correlation",
        args: {
          targetVariable: outcome,
          filter: "all",
          ...(filters.length > 0 ? { dimensionFilters: filters } : {}),
        },
      });
    }

    // Step 2 / 3 — categorical driver breakdowns (up to 2).
    const drivers = (brief.candidateDriverDimensions ?? []).slice(0, 2);
    drivers.forEach((dim, idx) => {
      steps.push({
        id: `drv_breakdown_${idx + 1}`,
        tool: "run_breakdown_ranking",
        args: {
          metricColumn: outcome,
          breakdownColumn: dim,
          aggregation: "sum",
          topN: 10,
          ...(filters.length > 0 ? { dimensionFilters: filters } : {}),
        },
      });
    });

    // If we have no drivers at all, this skill can't add anything.
    if (steps.length === 0) return null;

    // Step 4 — bar chart of the first breakdown (only when at least one
    // breakdown step exists). Synthesiser uses the other evidence in
    // narrative form.
    if (drivers.length > 0) {
      const firstDim = drivers[0];
      steps.push({
        id: "drv_chart",
        tool: "build_chart",
        args: {
          type: "bar",
          x: firstDim,
          y: `${outcome}_sum`,
          title: `${outcome} by ${firstDim}`,
          aggregate: "none",
        },
        dependsOn: "drv_breakdown_1",
      });
    }

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
      id: `drv-${Date.now().toString(36)}`,
      label: `Driver discovery for ${outcome}`,
      steps,
      parallelizable: true,
      rationale: `driver_discovery expanded into ${steps.length} step(s). Outcome=${outcome}, drivers=[${drivers.join(", ") || "(none)"}], filters=${filterNote}.`,
    };
  },
};

registerSkill(skill);

export { skill as driverDiscoverySkill };
