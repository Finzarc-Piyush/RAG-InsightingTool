/**
 * Merge two lists of suggested questions with a strict priority semantic:
 * `primary` (LLM-driven, context-aware) wins. `fallback` (e.g. hardcoded
 * column-name templates) is used only when `primary` is empty after dedup.
 * Never interleaves — template padding behind a short LLM list defeats the
 * quality goal.
 */
export function mergeSuggestedQuestions(
  primary?: string[],
  fallback?: string[],
  limit = 12
): string[] {
  const cleanPrimary = [...new Set((primary || []).filter((q) => q?.trim()))];
  if (cleanPrimary.length > 0) {
    return cleanPrimary.slice(0, limit);
  }
  const cleanFallback = [...new Set((fallback || []).filter((q) => q?.trim()))];
  return cleanFallback.slice(0, limit);
}
