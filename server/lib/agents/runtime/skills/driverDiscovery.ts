/**
 * driver_discovery — for "what impacts my [metric] the most?" shapes.
 *
 * Collects both sides of the driver picture in one plan:
 *   1. run_correlation on the outcome metric — surfaces the numeric
 *      features most correlated with it.
 *   2. run_breakdown_ranking for each candidateDriverDimension (cap 2) —
 *      surfaces the categorical dimensions whose values produce the
 *      largest per-segment variation in the outcome.
 *   3. build_chart — bar chart of the first breakdown as a visual anchor.
 *
 * The synthesiser then ranks drivers by effect size across the two
 * evidence types and explains the top 3 with magnitudes.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import { registerSkill } from "./index.js";

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
