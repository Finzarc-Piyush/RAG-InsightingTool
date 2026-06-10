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
 *   This pure function drops all three before the chips reach the user.
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

/** Lowercase, strip punctuation, collapse whitespace — for dedup + matching. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const seen = new Set<string>(
    (options.priorQuestions ?? []).map(normalize).filter(Boolean)
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
    const norm = normalize(raw);
    if (!norm) continue;
    if (excludedNorms.some((col) => norm.includes(col))) continue; // identifier grouping
    if (seen.has(norm)) continue; // duplicate
    seen.add(norm);
    out.push(sq);
  }
  return out;
}
