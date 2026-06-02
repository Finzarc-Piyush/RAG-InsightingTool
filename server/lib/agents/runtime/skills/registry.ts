/**
 * ============================================================================
 * registry.ts — the in-memory catalog of skills + the picker logic
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Holds the live list of registered skills and provides the functions to
 *   register, list, advertise, choose, and expand them. A "skill" is a named
 *   analytical routine (driver discovery, growth analysis, etc.); this file is
 *   the bookkeeping around them. The picker (selectSkill) asks every registered
 *   skill "do you apply to this question?", keeps the matches, and returns the
 *   best one — sorted by `priority` (higher = narrower/more specific wins),
 *   with ties broken by registration order so the result is deterministic.
 *
 * WHY IT MATTERS
 *   This is how the planner decides whether a canned skill should handle a
 *   question instead of free-form tool selection. It is deliberately kept FREE
 *   of side-effect imports: skills import { registerSkill } from here, while
 *   index.ts imports the skills. If this file imported index.ts too, the
 *   resulting cycle crashed every skill test with "Cannot access 'registry'
 *   before initialization" at load time (see docs/architecture/skills.md).
 *
 * KEY PIECES
 *   - registerSkill — adds/overwrites a skill in the registry (idempotent, so
 *     hot-reload and test re-imports don't throw).
 *   - listRegisteredSkills — current skills as an array.
 *   - formatSkillsManifestForPlanner — one line per eligible skill for the
 *     planner prompt; empty string when the feature flag is off (keeps the
 *     prompt byte-identical so prompt cache holds).
 *   - selectSkill — picks the best applicable skill (priority desc, insertion
 *     order tiebreak), honouring the enable flag and allowlist.
 *   - expandSkill — turns a chosen skill into a concrete SkillInvocation (the
 *     ordered plan steps) by calling skill.plan().
 *
 * HOW IT CONNECTS
 *   Imported by every skill file (for registerSkill) and by skills/index.ts
 *   (which re-exports these and triggers registration). Feature-flag helpers
 *   isDeepAnalysisSkillsEnabled / skillAllowlist come from ./types.js. Brief
 *   and context types come from the shared schema and ../types.js.
 */
import type { AgentExecutionContext } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import {
  isDeepAnalysisSkillsEnabled,
  skillAllowlist,
} from "./types.js";

const registry = new Map<string, AnalysisSkill>();

export function registerSkill(skill: AnalysisSkill): void {
  // Idempotent by design: HMR and test re-imports should not throw.
  // Boot-time duplicate detection is the planner's responsibility via
  // `registerSkills`, not this primitive.
  registry.set(skill.name, skill);
}

export function listRegisteredSkills(): AnalysisSkill[] {
  return Array.from(registry.values());
}

/**
 * Skills manifest line-items for the planner prompt. One line per
 * eligible skill so the planner can pick a composite when appropriate.
 * Empty string when deep-analysis is off — keeps the existing prompt
 * identical.
 */
export function formatSkillsManifestForPlanner(): string {
  if (!isDeepAnalysisSkillsEnabled()) return "";
  const allow = skillAllowlist();
  const eligible = listRegisteredSkills().filter(
    (s) => !allow || allow.has(s.name)
  );
  if (eligible.length === 0) return "";
  const lines = eligible
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");
  return `\nAvailable analysis skills (composites over existing tools; prefer when the user asks the matching question shape):\n${lines}\n`;
}

/**
 * Pick the best skill for the current brief + context, or null if none
 * applies. Every matching skill is collected, then sorted by
 * `priority` descending (narrow skills that require more of the brief
 * outrank broader ones that match loosely). Ties break on registry
 * insertion order so the behaviour is deterministic.
 */
export function selectSkill(
  brief: AnalysisBrief,
  ctx: AgentExecutionContext
): AnalysisSkill | null {
  if (!isDeepAnalysisSkillsEnabled()) return null;
  const allow = skillAllowlist();
  const matches: Array<{ skill: AnalysisSkill; order: number }> = [];
  const registered = listRegisteredSkills();
  for (let i = 0; i < registered.length; i += 1) {
    const skill = registered[i];
    if (allow && !allow.has(skill.name)) continue;
    if (skill.appliesTo(brief, ctx)) {
      matches.push({ skill, order: i });
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const priorityDelta = (b.skill.priority ?? 0) - (a.skill.priority ?? 0);
    if (priorityDelta !== 0) return priorityDelta;
    return a.order - b.order;
  });
  return matches[0].skill;
}

/** Expand the selected skill into a concrete invocation (plan steps). */
export function expandSkill(
  skill: AnalysisSkill,
  brief: AnalysisBrief,
  ctx: AgentExecutionContext
): SkillInvocation | null {
  return skill.plan(brief, ctx);
}
