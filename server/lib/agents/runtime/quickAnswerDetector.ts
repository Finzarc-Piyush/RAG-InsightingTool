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
 *   Called at the top of a turn before classification. Tested by
 *   tests/quickAnswerDetector.test.ts.
 */

/** Max question length for the fast path. Anything longer almost certainly carries
 *  conjunctions or qualifiers a single query plan can't honour cleanly. */
const MAX_FAST_PATH_QUESTION_LENGTH = 140;

/**
 * Lookup-shape opener — must match the start of the trimmed question.
 * Captures top/bottom/highest/lowest/list/show/how many/count/sum/total/
 * average/avg/mean/latest/most recent, plus "what's the top/bottom/etc.".
 */
const LOOKUP_SHAPE_REGEX =
  /^(?:top|bottom|highest|lowest|max|min|list|show(?:\s+me)?|what(?:'s|\s+is|\s+are|\s+were)?\s+(?:the\s+)?(?:top|bottom|highest|lowest|max|min|list|count|sum|total|average|avg|mean)|how\s+many|count|sum|total|average|avg|mean|latest|most\s+recent|which\s+\d+)\b/i;

/**
 * Analytical-intent denylist. Presence of ANY of these terms rejects the
 * fast path because the answer would require investigation / synthesis the
 * fast path doesn't perform. Keep this list strictly additive — removals
 * widen the fast-path blast radius silently.
 */
const ANALYTICAL_DENYLIST_REGEX =
  /\b(?:why|driver|drivers|drove|driving|drives|cause|causes|caused|because|compare|comparison|comparing|vs|versus|correlation|correlate|correlated|trend|trends|trending|trended|over\s+time|breakdown|break\s+down|decompose|explain|explanation|forecast|predict|prediction|optimi[sz]e|optimi[sz]ation|redistribute|reallocate|scenario|what\s+if|dashboard|recommend|recommendation|should\s+(?:we|i|they)|seasonal|seasonality|attribution|attribut|mmm|regression|hypothes|deep\s+dive|insight|analy[sz]e|analy[sz]is|root\s+cause)\b/i;

/**
 * Conjunctions that imply a multi-part request — "top 10 X **and** tell me
 * why they grew". Even if the head clause is a lookup, the tail demands
 * analysis. Reject the fast path so the full loop handles both.
 */
const MULTI_PART_CONJUNCTION_REGEX =
  /\band\s+(?:why|how|what(?:'s|\s+is|\s+are)?\s+(?:driving|causing|behind)|tell\s+me|explain|investigate|dig|figure\s+out)/i;

/**
 * Returns true iff the question is shaped like a simple lookup AND carries
 * no analytical-intent keywords AND fits the length budget.
 *
 * Pure function — no side effects, no env reads. Safe to call before any
 * other classification step.
 */
export function detectQuickLookup(question: string | undefined | null): boolean {
  if (typeof question !== "string") return false;
  const trimmed = question.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_FAST_PATH_QUESTION_LENGTH) return false;
  if (!LOOKUP_SHAPE_REGEX.test(trimmed)) return false;
  if (ANALYTICAL_DENYLIST_REGEX.test(trimmed)) return false;
  if (MULTI_PART_CONJUNCTION_REGEX.test(trimmed)) return false;
  return true;
}

/**
 * Env-gated kill-switch. Default ON. Set `QUICK_LOOKUP_ENABLED=false` to
 * force every turn through the full agentic loop (rollback path).
 */
export function isQuickLookupEnabled(): boolean {
  return process.env.QUICK_LOOKUP_ENABLED !== "false";
}
