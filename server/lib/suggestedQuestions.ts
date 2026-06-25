import { stripOrQuestions } from "./suggestedQuestionGuard.js";

/**
 * Merge two lists of suggested questions with a strict priority semantic:
 * `primary` (LLM-driven, context-aware) wins. `fallback` (e.g. hardcoded
 * column-name templates) is used only when `primary` is empty after dedup.
 * Never interleaves — template padding behind a short LLM list defeats the
 * quality goal.
 *
 * Backstop for the no-"or" product rule: this is the shared merge point for the
 * upload/initial path, so disjunctive ("... A or B ...") questions are stripped
 * here regardless of which generator produced them.
 */
export function mergeSuggestedQuestions(
  primary?: string[],
  fallback?: string[],
  // UX · product rule: never surface more than 5 suggested questions.
  limit = 5
): string[] {
  const cleanPrimary = [...new Set(stripOrQuestions(primary))];
  if (cleanPrimary.length > 0) {
    return cleanPrimary.slice(0, limit);
  }
  const cleanFallback = [...new Set(stripOrQuestions(fallback))];
  return cleanFallback.slice(0, limit);
}
