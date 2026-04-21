/**
 * Skills registry — storage + selection. Kept free of side-effect
 * imports so skills (varianceDecomposer.ts, timeWindowDiff.ts, etc.)
 * can `import { registerSkill } from "./registry.js"` without forming
 * a cycle with `./index.ts`, which is the consumer entry point that
 * triggers auto-registration. The cycle caused a
 * `ReferenceError: Cannot access 'registry' before initialization` in
 * every skill-related test at module-load time — see
 * `docs/architecture/skills.md` "Known pitfalls".
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
