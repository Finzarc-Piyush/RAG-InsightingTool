/**
 * ============================================================================
 * quickAnswerDetector.ts — is this a simple lookup we can fast-path?
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A regex gate that decides whether a question is a simple lookup ("top 10
 *   SKUs by sales", "how many regions") that one DuckDB query plus a results
 *   table can answer — so the engine can skip the heavy pipeline
 *   (hypothesis → brief → planner → reflector → narrator → verifier) and reply
 *   fast. DuckDB is the in-process SQL engine that runs queries on the dataset.
 *
 * WHY IT MATTERS
 *   The full loop is slow; many questions don't need it. But getting it wrong is
 *   asymmetric: a false negative just costs normal latency, while a false
 *   positive would silently strip out the analysis the user expected. So it is
 *   deliberately conservative — any analytical keyword (why, compare, trend,
 *   driver, ...) rejects the fast path.
 *
 * KEY PIECES
 *   - detectQuickLookup(question) — true only when the question is lookup-shaped,
 *     short enough, carries no analytical keyword, and isn't multi-part.
 *   - isQuickLookupEnabled() — env kill-switch (default ON; set
 *     QUICK_LOOKUP_ENABLED=false to force every turn through the full loop).
 *
 * HOW IT CONNECTS
 *   THIN VIEW over the question-intent authority: `detectQuickLookup` is exactly
 *   `classifyQueryIntent(q).isLookupShape`. The lookup-opener / analytical-core /
 *   multi-part vocabularies live in `queryIntentAuthority.ts` (single source of
 *   truth) so this detector can never drift out of sync with the direct-factual
 *   gate or the depth-budget routing. Tested by tests/quickAnswerDetector.test.ts.
 */

import { classifyQueryIntent } from "./queryIntentAuthority.js";
import { isFlagOn } from "../../featureFlags.js";

/**
 * Returns true iff the question is shaped like a simple lookup AND carries
 * no analytical-intent keywords AND is not multi-part AND fits the length
 * budget. Delegates to the authority so one vocabulary governs every gate.
 *
 * Pure function — no side effects, no env reads. Safe to call before any
 * other classification step.
 */
export function detectQuickLookup(question: string | undefined | null): boolean {
  return classifyQueryIntent(question).isLookupShape;
}

/**
 * Env-gated kill-switch. Default ON. Set `QUICK_LOOKUP_ENABLED=false` to
 * force every turn through the full agentic loop (rollback path).
 */
export function isQuickLookupEnabled(): boolean {
  return isFlagOn("QUICK_LOOKUP_ENABLED");
}

/**
 * Env-gated kill-switch for the quick-answer chart. Default ON. Set
 * `QUICK_ANSWER_CHART_ENABLED=false` to suppress the auto-attached
 * "all performers, sorted" chart on the quick-answer fast path (the answer
 * table + derived pivot are unaffected).
 */
export function isQuickAnswerChartEnabled(): boolean {
  return isFlagOn("QUICK_ANSWER_CHART_ENABLED");
}
