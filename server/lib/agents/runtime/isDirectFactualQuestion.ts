/**
 * ============================================================================
 * isDirectFactualQuestion.ts — is this a plain lookup, not a strategy ask?
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Decides, with regex only, whether the user asked a simple factual question
 *   ("What is the average X per Y?", "Which Z has the most W?", "How many ...")
 *   versus something analytical or strategic. If it is plainly factual, the
 *   answer should NOT pad itself with recommendations or "further investigation"
 *   suggestions — the user just wanted the number.
 *
 * WHY IT MATTERS
 *   Stops short factual answers from being bloated with unwanted next-steps,
 *   honoring the explicit user request "if the user asks a direct question, no
 *   need to go for further investigation."
 *
 * KEY PIECES
 *   - isDirectFactualQuestion(question) — true only when the question opens with
 *     a factual interrogative AND contains no comparative/why/strategic cue.
 *   - Biased toward false (treat as non-factual when unsure) so we keep
 *     recommendations rather than wrongly stripping them.
 *
 * HOW IT CONNECTS
 *   THIN VIEW over the question-intent authority. The factual-leader openers
 *   and the "non-factual" denylist (analytical core ∪ the strategy/outcome
 *   extras) now live in `queryIntentAuthority.ts` — the single source of truth
 *   — so this gate can never drift out of sync with the routing gates again.
 *   Used by the answer-envelope assembly in the agent runtime to gate whether
 *   recommendation sections are included.
 */

import { classifyQueryIntent } from "./queryIntentAuthority.js";

/**
 * Classify whether a user question is a direct factual ask
 * ("What is the average X per Y?", "Which Z has the most W?", "How many ...")
 * that does NOT warrant follow-up recommendations / "further investigation"
 * suggestions in the answer envelope.
 *
 * Delegates to `classifyQueryIntent().isDirectFactual`: true only when the
 * question opens with a factual interrogative AND carries no analytical /
 * diagnostic / strategic / outcome cue. Intentional false-negatives over
 * false-positives — when in doubt, treat as non-factual so recommendations are
 * kept. The user explicitly said "if user asks a direct question, no need to go
 * for further investigation"; this matches the *direct* shape only.
 */
export function isDirectFactualQuestion(question: string | undefined | null): boolean {
  return classifyQueryIntent(question).isDirectFactual;
}
