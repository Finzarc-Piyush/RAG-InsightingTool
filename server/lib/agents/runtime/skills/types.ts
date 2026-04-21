/**
 * Shared types for the Phase-1 analysis skills catalog.
 *
 * A Skill is a named analytical competency. Each skill knows:
 *  - the question shapes it handles,
 *  - how to expand into an ordered list of PlanSteps using the existing
 *    tool registry (no new tool types),
 *  - whether its steps can run concurrently (PR 1.E).
 *
 * Skills are flag-gated behind `DEEP_ANALYSIS_SKILLS_ENABLED=true` (see
 * isDeepAnalysisSkillsEnabled) and rolled out per-skill via a coarse
 * override flag `DEEP_ANALYSIS_SKILL_ALLOWLIST` (comma-separated names).
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief, QuestionShape } from "../../../../shared/schema.js";

export interface SkillInvocation {
  /** Stable human-readable id — logged in traces, shown in SSE events. */
  id: string;
  /** Short label rendered in the thinking panel. */
  label: string;
  /** Pre-sequenced plan steps using existing tools. */
  steps: PlanStep[];
  /** When true, the step-runner may execute independent branches in parallel. */
  parallelizable?: boolean;
  /** Optional free-text rationale for the trace. */
  rationale?: string;
}

export interface AnalysisSkill {
  /** Registry key — must match `id` in the manifest. */
  name: string;
  /** One-line description rendered in the planner prompt manifest. */
  description: string;
  /** Returns true when this skill is applicable to the brief. */
  appliesTo(brief: AnalysisBrief, ctx: AgentExecutionContext): boolean;
  /** Builds the step sequence. May return null if preconditions fail at plan time. */
  plan(brief: AnalysisBrief, ctx: AgentExecutionContext): SkillInvocation | null;
  /** Question shapes this skill nominally handles (for hinting). */
  handles: QuestionShape[];
  /**
   * Selection priority. Higher wins when multiple skills match the same
   * brief. Narrow skills (that require strictly more of the brief — e.g.
   * `comparisonPeriods` present) should carry a higher priority so they
   * shadow broader siblings when their preconditions are met. Default 0.
   */
  priority?: number;
}

export function isDeepAnalysisSkillsEnabled(): boolean {
  return process.env.DEEP_ANALYSIS_SKILLS_ENABLED === "true";
}

/**
 * Coarse rollout control: only skills whose name appears in the allowlist
 * are dispatched. When unset, all registered skills are eligible (as long as
 * DEEP_ANALYSIS_SKILLS_ENABLED=true).
 */
export function skillAllowlist(): Set<string> | null {
  const raw = process.env.DEEP_ANALYSIS_SKILL_ALLOWLIST?.trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
