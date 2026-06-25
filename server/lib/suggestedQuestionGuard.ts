/**
 * ============================================================================
 * suggestedQuestionGuard.ts — single authority: no "or" in a suggested question
 * ============================================================================
 * PRODUCT RULE (user, 2026-06-25)
 *   A *suggested* question must NEVER contain the conjunction "or"
 *   (e.g. "What is sales distribution by cluster or state?"). An "or" offers the
 *   app a choice between two analyses it can't resolve, so the question is not
 *   answerable. Every surface that proposes a question to the user — initial
 *   starter chips, quick-answer follow-ups, reflector "Investigating further"
 *   chips, narrator/synthesis CTAs — must drop these.
 *
 * WHY DETERMINISTIC (not just a prompt)
 *   Each generator IS asked in-prompt to avoid "or", but a prompt is a hint, not
 *   a guarantee — the LLM slips, and some questions are built from hardcoded
 *   templates. This pure guard is THE guarantee: every generator routes its
 *   output through `stripOrQuestions` before it can reach a rendered field, so
 *   no path can re-introduce an "or" question downstream. (Mirrors the
 *   filterSpawnedQuestions random-sample firewall: prompt discourages, filter
 *   enforces.)
 *
 * SCOPE — the standalone WORD "or" only
 *   `/\bor\b/i` matches the conjunction ("by cluster or state", "and/or", "A OR
 *   B") but NOT the letters inside "for", "store", "factor", "category",
 *   "region", "report" — those have no word boundary around the "or", so they
 *   are never touched. A question with a real disjunction is DROPPED, not
 *   rewritten: auto-picking one branch ("cluster" over "state") could silently
 *   change the user's intent.
 */

/** Matches the standalone conjunction "or" (incl. "and/or"); never the "or"
 *  inside a larger word. */
const DISJUNCTIVE_OR_RE = /\bor\b/i;

/** True when the question contains a standalone "or" (the ambiguous disjunction). */
export function hasDisjunctiveOr(question: string | null | undefined): boolean {
  return typeof question === "string" && DISJUNCTIVE_OR_RE.test(question);
}

/**
 * Drop every question that contains a standalone "or". Pure; preserves order and
 * de-dups nothing (callers own dedup). Non-string / empty entries are dropped.
 */
export function stripOrQuestions(
  questions: readonly string[] | null | undefined
): string[] {
  if (!questions?.length) return [];
  return questions.filter(
    (q): q is string => typeof q === "string" && !!q.trim() && !hasDisjunctiveOr(q)
  );
}
