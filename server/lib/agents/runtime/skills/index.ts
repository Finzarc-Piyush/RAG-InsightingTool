/**
 * Skills registry — Phase-1 analytical competencies that expand into the
 * existing tool catalog. Individual skill modules register themselves here.
 */
import type { AgentExecutionContext } from "../types.js";
import type { AnalysisBrief } from "../../../../shared/schema.js";
import type { AnalysisSkill, SkillInvocation } from "./types.js";
import {
  isDeepAnalysisSkillsEnabled,
  skillAllowlist,
} from "./types.js";

export type { AnalysisSkill, SkillInvocation } from "./types.js";
export { isDeepAnalysisSkillsEnabled, skillAllowlist } from "./types.js";

const registry = new Map<string, AnalysisSkill>();

export function registerSkill(skill: AnalysisSkill): void {
  if (registry.has(skill.name)) {
    // Idempotent — late re-register (HMR) wins.
  }
  registry.set(skill.name, skill);
}

export function listRegisteredSkills(): AnalysisSkill[] {
  return Array.from(registry.values());
}

/**
 * Skills manifest line-items for the planner prompt. One line per eligible
 * skill so the planner can pick a composite when appropriate. Empty string
 * when deep-analysis is off — keeps the existing prompt identical.
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
 * applies. Priority order: allowlist order if present, otherwise registry
 * insertion order, first-match wins.
 */
export function selectSkill(
  brief: AnalysisBrief,
  ctx: AgentExecutionContext
): AnalysisSkill | null {
  if (!isDeepAnalysisSkillsEnabled()) return null;
  const allow = skillAllowlist();
  for (const skill of listRegisteredSkills()) {
    if (allow && !allow.has(skill.name)) continue;
    if (skill.appliesTo(brief, ctx)) return skill;
  }
  return null;
}

/** Expand the selected skill into a concrete invocation (plan steps). */
export function expandSkill(
  skill: AnalysisSkill,
  brief: AnalysisBrief,
  ctx: AgentExecutionContext
): SkillInvocation | null {
  return skill.plan(brief, ctx);
}

// Auto-register Phase-1 skills on first import. Each module calls
// `registerSkill(...)` at load time; the map is idempotent so re-imports
// (HMR, tests) are safe.
import "./varianceDecomposer.js";
import "./driverDiscovery.js";
import "./insightExplorer.js";
import "./timeWindowDiff.js";
