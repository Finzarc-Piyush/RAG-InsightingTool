/**
 * Question normalization for the semantic question cache (Phase 5).
 *
 * The same function MUST run at write time (chatStream writes
 * `pastAnalysisDoc.normalizedQuestion`) and at lookup time (cache exact-match
 * filter on `normalizedQuestion eq @nq`). Any divergence causes 100% cache
 * miss, so it lives in one tested module that both call sites import.
 *
 * Goals:
 *   1. Folds trivial typing variation: case, leading/trailing whitespace,
 *      multiple spaces, runs of punctuation at the end of a sentence.
 *   2. Conservative — does NOT merge questions that differ in meaning.
 *      "show me sales" and "show sales" stay distinct (different intent
 *      strength). "How are sales?" and "how are sales" collapse (typing
 *      variation). False-positive cache hits are far worse than misses.
 *
 * Out of scope:
 *   - Synonym folding (revenue ↔ sales) — too risky.
 *   - Stemming, lemmatization — domain-dependent, unverifiable.
 *   - Question-mark stripping mid-sentence (only trailing).
 */

const TRAILING_PUNCT = /[!?.,;:'"()\[\]]+$/;
const COLLAPSE_WS = /\s+/g;

/**
 * Normalize a user question for cache lookup. Returns "" on empty/whitespace
 * input — callers should treat that as "do not cache" (an empty key would
 * collide across all empty-string questions).
 */
export function normalizeQuestionForCache(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(COLLAPSE_WS, " ")
    .trim()
    .replace(TRAILING_PUNCT, "")
    .trim();
}
