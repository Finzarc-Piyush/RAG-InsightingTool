import type { SessionAnalysisContext } from "../shared/schema.js";

/**
 * Assistant merges must never change user-supplied intent; applied after merge LLM output.
 */
export function withImmutableUserIntentFromPrevious(
  previous: SessionAnalysisContext,
  assistantMerged: SessionAnalysisContext
): SessionAnalysisContext {
  return { ...assistantMerged, userIntent: previous.userIntent };
}
