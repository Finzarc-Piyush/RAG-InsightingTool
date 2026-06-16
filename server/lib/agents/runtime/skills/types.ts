/**
 * ============================================================================
 * types.ts — the shared shapes (contracts) for the analysis skills catalog
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines the TypeScript interfaces every skill must satisfy, plus the two
 *   feature-flag helpers that gate the whole subsystem. A "skill" is a named
 *   analytical competency; this file says what one looks like in code: it knows
 *   which question shapes it handles, how to expand into an ordered list of
 *   PlanSteps built from existing tools (skills add no new tool types), and
 *   whether those steps may run concurrently.
 *
 * WHY IT MATTERS
 *   Every skill file and the registry import these types, so this is the single
 *   contract that keeps them interchangeable. The flag helpers here are the
 *   on/off switch and gradual-rollout control for the entire skills feature.
 *
 * KEY PIECES
 *   - SkillInvocation — the concrete output of a skill: an id, a label for the
 *     thinking panel, the ordered PlanSteps, a parallelizable flag, and an
 *     optional rationale for traces.
 *   - AnalysisSkill — the skill itself: name, description (shown in the planner
 *     manifest), appliesTo() (gate), plan() (build steps), handles (question
 *     shapes), and priority (higher wins when several skills match — narrow,
 *     stricter skills should carry a higher number).
 *   - isDeepAnalysisSkillsEnabled — true only when DEEP_ANALYSIS_SKILLS_ENABLED
 *     === "true"; the master switch.
 *   - skillAllowlist — parses DEEP_ANALYSIS_SKILL_ALLOWLIST (comma-separated
 *     names) into a Set, or null when unset (meaning all skills eligible).
 *
 * HOW IT CONNECTS
 *   Imported by registry.ts and every skill file. PlanStep / AgentExecutionContext
 *   come from ../types.js; AnalysisBrief / QuestionShape from the shared schema.
 */
import type { AgentExecutionContext, PlanStep } from "../types.js";
import type { AnalysisBrief, QuestionShape } from "../../../../shared/schema.js";
import { isFlagOn } from "../../../featureFlags.js";

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
  return isFlagOn("DEEP_ANALYSIS_SKILLS_ENABLED");
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
