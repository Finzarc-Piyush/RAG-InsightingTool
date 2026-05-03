import type { SessionAnalysisContext } from "../shared/schema.js";

/**
 * Assistant merges must never change user-supplied intent; applied after merge LLM output.
 *
 * H2 / AD1 · `dataset.dimensionHierarchies` is pinned across assistant merges — both
 * user-source entries (ground truth, never assistant-mutable) and auto-source entries
 * (set once at upload time by the rollup detector; assistant merge has no business
 * dropping them either). The assistant-merge LLM is taught to preserve dataset.* but
 * isn't 100% reliable, so this guard makes it deterministic. To CHANGE a hierarchy,
 * the user must restate it in chat — that runs through the user-merge LLM, which has
 * full control and can update or retract entries.
 */
export function withImmutableUserIntentFromPrevious(
  previous: SessionAnalysisContext,
  assistantMerged: SessionAnalysisContext
): SessionAnalysisContext {
  const prevHierarchies = previous.dataset.dimensionHierarchies ?? [];
  if (prevHierarchies.length === 0) {
    return { ...assistantMerged, userIntent: previous.userIntent };
  }
  return {
    ...assistantMerged,
    userIntent: previous.userIntent,
    dataset: {
      ...assistantMerged.dataset,
      dimensionHierarchies: prevHierarchies,
    },
  };
}
