import type { SessionAnalysisContext } from "../../shared/schema.js";

const MAX = 6000;

/** Compact JSON slice for prompts (dataset roles, facts, user constraints). */
export function formatSessionAnalysisContextForInsight(
  sac: SessionAnalysisContext | undefined
): string {
  if (!sac) return "";
  try {
    return JSON.stringify(sac).slice(0, MAX);
  } catch {
    return "";
  }
}
