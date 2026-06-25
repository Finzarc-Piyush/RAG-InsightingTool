/**
 * ============================================================================
 * filterSpawnedQuestions.ts — gate the reflector's "Investigating further" chips
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The reflector LLM emits follow-up "spawnedQuestions" that the UI renders as
 *   the "Investigating further" chips. Left ungated, it produces three shapes a
 *   manager never wants to see: (1) RANDOM-SAMPLE questions ("Which 5 random
 *   reps can be sampled…") — never actionable; (2) DUPLICATES (the same
 *   breakdown emitted twice across reflector calls); (3) per-IDENTIFIER
 *   groupings ("… by <rep name/code>") that rank thousands of row-identifiers.
 *   It also drops (4) DISJUNCTIVE questions containing a standalone "or"
 *   ("… by cluster or state?") — an ambiguous choice the app can't resolve
 *   (delegated to suggestedQuestionGuard). This pure function drops all four
 *   before the chips reach the user.
 *
 * WHY IT MATTERS
 *   "Never show random samples" is a hard product rule, and the LLM does not
 *   reliably honour a prompt instruction alone — so the deterministic regex here
 *   is the guarantee. Dedup removes the visible repetition; the identifier guard
 *   removes the highest-noise grouping. (A defensive sentence in the reflector
 *   W8 prompt discourages these at generation time; this filter enforces it.)
 *
 * HOW IT CONNECTS
 *   Called from agentLoop.service.ts at the single spawned-question chokepoint
 *   (before they are accumulated + SSE-emitted as `sub_question_spawned`).
 *   Reuses isLikelyIdentifierColumnName (../../columnIdHeuristics.js).
 */
import { isLikelyIdentifierColumnName } from "../../columnIdHeuristics.js";
import { hasDisjunctiveOr } from "../../suggestedQuestionGuard.js";

/** HARD RULE — random-sample shapes are never shown to the user. */
const RANDOM_SAMPLE_RE =
  /\b(random(?:ly)?|sampled?|sampling|a sample of|representative sample|drawn at random)\b/i;

export interface SpawnedQuestionLike {
  question: string;
  [key: string]: unknown;
}

export interface FilterSpawnedOptions {
  /** Questions already shown earlier this turn — dedup target. */
  priorQuestions?: readonly string[];
  /** All dataset column names; identifier-shaped or very-high-cardinality ones
   *  are treated as bad grouping dimensions and any question naming them is
   *  dropped. Pass `ctx.summary.columns.map(c => c.name)` (+ optionally the set
   *  of high-cardinality names). */
  excludedColumns?: readonly string[];
}

/** Lowercase, strip punctuation, collapse whitespace — used for the random-sample
 *  and identifier-grouping substring checks (which need the words in order). */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Question-framing and ranking words that carry no analytical content: two
 * follow-ups differing ONLY in these words ask the same thing. Aggregation
 * qualifiers (average / mean / total / sum / min / max / median) are
 * deliberately EXCLUDED so "average X by Y" and "total X by Y" stay distinct.
 */
const STOPWORDS = new Set<string>([
  // framing / function words
  "what", "which", "how", "who", "whom", "whose", "when", "where", "why",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done",
  "the", "a", "an", "of", "by", "on", "in", "for", "with", "to", "from", "per",
  "at", "as", "into", "onto", "over", "under", "about", "within",
  "and", "or", "but", "nor", "so", "than", "then",
  "that", "this", "these", "those", "there", "here", "their", "its", "it",
  "them", "they", "we", "you", "i", "he", "she", "his", "her", "our", "your",
  "has", "have", "had", "having",
  "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  "each", "any", "all", "some", "both", "every", "no", "not",
  // ranking / generic-analytical paraphrase noise
  "top", "bottom", "highest", "lowest", "high", "low", "most", "least",
  "many", "much", "more", "less", "fewer", "greater", "larger", "smaller",
  "biggest", "largest", "smallest",
  "rank", "ranked", "ranking", "rankings",
  "vary", "varies", "varied", "varying", "variation", "variations",
  "name", "names", "named",
  "value", "values",
  "count", "counts", "counting",
  "number", "numbers",
  "breakdown", "breakdowns",
  "distribution", "distributions",
  "across", "between", "among", "versus", "vs",
  "single",
  "list", "lists", "show", "shows", "give", "gives", "find", "finds", "identify",
  "compare", "compared", "comparison",
]);

/**
 * Content signature for SEMANTIC dedup: lowercase → strip punctuation → drop
 * numbers, single chars, and STOPWORDS → crude singularize (trailing "s" on
 * tokens longer than 3) → sort the unique remaining tokens. Two questions with
 * the same signature ask the same analytical thing regardless of phrasing or
 * word order — e.g. "Which 10 TSOEs have the highest Compliance Visit count?"
 * and "What are the top 10 TSOE names by Compliance Visit?" both reduce to
 * "compliance tsoe visit". Returns "" when nothing survives (caller then falls
 * back to `normalize` so all-stopword questions aren't collapsed into one).
 */
function semanticKey(s: string): string {
  const toks = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.length >= 2) // drop stray single chars (e.g. the "s" from "OL's")
    .filter((t) => !/^\d+$/.test(t)) // drop pure numbers ("10", "5")
    .filter((t) => !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)); // singularize
  return Array.from(new Set(toks)).sort().join(" ");
}

/**
 * Drop spawned follow-up questions that should never surface. Pure; preserves
 * input order and shape. Order of checks: random-sample (hard) → identifier
 * grouping → duplicate (vs prior + within batch).
 */
export function filterSpawnedQuestions<T extends SpawnedQuestionLike>(
  spawned: readonly T[],
  options: FilterSpawnedOptions = {}
): T[] {
  // Dedup keys are SEMANTIC signatures (collapse paraphrases), falling back to
  // the plain normalized string when a question reduces to nothing but stopwords.
  const dedupKey = (s: string): string => semanticKey(s) || normalize(s);
  const seen = new Set<string>(
    (options.priorQuestions ?? []).map(dedupKey).filter(Boolean)
  );
  // Only identifier-shaped columns become a "never group by this" matcher —
  // a normal low-card dimension (Cluster Name, ASM) must NOT be excluded.
  const excludedNorms = (options.excludedColumns ?? [])
    .filter((c) => typeof c === "string" && c && isLikelyIdentifierColumnName(c))
    .map(normalize)
    .filter((c) => c.length >= 3);

  const out: T[] = [];
  for (const sq of spawned) {
    const raw = (sq?.question ?? "").trim();
    if (!raw) continue;
    if (RANDOM_SAMPLE_RE.test(raw)) continue; // hard rule
    if (hasDisjunctiveOr(raw)) continue; // hard rule — "or" makes the ask ambiguous
    const norm = normalize(raw);
    if (!norm) continue;
    if (excludedNorms.some((col) => norm.includes(col))) continue; // identifier grouping
    const sig = semanticKey(raw) || norm;
    if (seen.has(sig)) continue; // duplicate (semantic — collapses paraphrases)
    seen.add(sig);
    out.push(sq);
  }
  return out;
}
