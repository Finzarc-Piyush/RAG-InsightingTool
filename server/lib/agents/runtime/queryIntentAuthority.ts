/**
 * ============================================================================
 * queryIntentAuthority.ts — THE single source of truth for question intent
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Classifies a user question ONCE into a small intent class
 *   ({conversational, metadata, lookup, descriptive, diagnostic, strategic})
 *   plus a `depthBudget` ({minimal, standard, full}) that tells the agent loop
 *   how much output a question actually warrants. It also exports the canonical
 *   keyword vocabularies (analytical / diagnostic / strategic / lookup-shape /
 *   factual-leader / multi-part) that every other gate must import instead of
 *   re-hand-coding its own divergent regex.
 *
 * WHY IT MATTERS — the two problems this fixes
 *   1. OVER-ANSWERING. Before this module, the heavy agent loop was the
 *      unconditional default: once the two conservative fast paths bailed, every
 *      enrichment stage (extra charts, dashboard offer, recommendations,
 *      next-step chips, spawned follow-ups) fired with NO reference to how
 *      simple the question was. A one-number lookup got a "plethora" of output.
 *      `depthBudget` gives every content emitter ONE value to gate on, so a
 *      simple question stops auto-padding.
 *   2. INCONSISTENCY FROM DUPLICATION. The predicate "is this analytical?" was
 *      hand-coded — with DIVERGENT word lists — in quickAnswerDetector,
 *      isDirectFactualQuestion, analysisSpecRouter, decompositionGate, and more.
 *      The same question came out "simple" to one gate and "analytical" to
 *      another. This module owns ONE canonical vocabulary; the legacy gates
 *      become thin views over it (see `isDirectFactualQuestion`,
 *      `detectQuickLookup`).
 *
 *   This is the question-intent analogue of `temporalGrainAuthority` (invariant
 *   #11): one authority, named exported constants, no rogue copies. See
 *   docs/decisions/centralized-query-intent.md.
 *
 * KEY PIECES
 *   - classifyQueryIntent(question) — the entry point; pure, no env/IO.
 *   - depthBudget — `minimal` for plain lookups / direct factual asks,
 *     `full` for diagnostic / strategic asks, `standard` for everything else.
 *   - ANALYTICAL_CORE_RE / DIRECT_FACTUAL_EXTRA_RE / DIAGNOSTIC_INTENT_RE /
 *     STRATEGIC_INTENT_RE / TREND_INTENT_RE / LOOKUP_SHAPE_RE /
 *     FACTUAL_LEADER_RES / MULTI_PART_RE — the canonical vocabularies.
 *
 * HOW IT CONNECTS
 *   Pure module (no imports from the runtime), so it stays cycle-free and its
 *   unit tests run unconditionally. Consumed by isDirectFactualQuestion.ts,
 *   quickAnswerDetector.ts, and agentLoop.service.ts (computes ctx.depthBudget
 *   once per turn and gates the enrichment amplifiers on it).
 */

/** Intent class — coarse shape of what the user is asking for. */
export type QueryIntentClass =
  | "conversational"
  | "metadata"
  | "lookup"
  | "descriptive"
  | "diagnostic"
  | "strategic";

/**
 * How much answer a question warrants.
 *   - `minimal`  — plain lookup / direct factual ask. Answer the number/table;
 *                  do NOT auto-add proposed charts, a dashboard offer,
 *                  recommendations, next-step chips, or spawned follow-ups.
 *   - `standard` — descriptive / comparison / trend. Today's full envelope, but
 *                  breadth augmentation (dashboard offer, spawned fan-out) stays
 *                  off unless the user explicitly asked.
 *   - `full`     — diagnostic / strategic. The complete decision-grade envelope
 *                  plus all (flag-enabled) breadth machinery.
 */
export type DepthBudget = "minimal" | "standard" | "full";

export interface QueryIntent {
  intentClass: QueryIntentClass;
  depthBudget: DepthBudget;
  /** Plain factual ask ("what is the average X per Y?") — warrants NO recs/next-steps. */
  isDirectFactual: boolean;
  /** Lookup-shaped ("top 10 X", "how many Y", "list Z") and a single query can answer it. */
  isLookupShape: boolean;
  /** Two asks joined by a conjunction with a real second clause. */
  isMultiPart: boolean;
  signals: {
    analytical: boolean;
    diagnostic: boolean;
    strategic: boolean;
    trend: boolean;
  };
}

/**
 * Max question length for the lookup fast path. Anything longer almost
 * certainly carries conjunctions or qualifiers a single query plan can't
 * honour cleanly. (Promoted verbatim from quickAnswerDetector.)
 */
export const MAX_FAST_PATH_QUESTION_LENGTH = 140;

/**
 * CANONICAL analytical-intent vocabulary. Presence of any of these means the
 * answer needs investigation / synthesis a single query cannot perform, so the
 * question is NOT a plain lookup. This is the authoritative list — formerly
 * `ANALYTICAL_DENYLIST_REGEX` in quickAnswerDetector, promoted here so the fast
 * path and every other gate share ONE vocabulary. Keep strictly additive:
 * removals widen the fast-path blast radius silently.
 */
export const ANALYTICAL_CORE_RE =
  /\b(?:why|driver|drivers|drove|driving|drives|cause|causes|caused|because|compare|comparison|comparing|vs|versus|correlation|correlate|correlated|trend|trends|trending|trended|over\s+time|breakdown|break\s+down|decompose|explain|explanation|forecast|predict|prediction|optimi[sz]e|optimi[sz]ation|redistribute|reallocate|scenario|what\s+if|dashboard|recommend|recommendation|should\s+(?:we|i|they)|seasonal|seasonality|attribution|attribut|mmm|regression|hypothes|deep\s+dive|insight|analy[sz]e|analy[sz]is|root\s+cause)\b/i;

/**
 * EXTRA cues that a direct factual answer should NOT pad with recommendations
 * even though a single query could compute it — softer "strategy/outcome"
 * language. `isDirectFactual` rejects on ANALYTICAL_CORE_RE ∪ this set; the
 * lookup fast path deliberately does NOT use this set (a "list all plans"
 * lookup is still a lookup). This is the ONE place the two concerns diverge,
 * and the divergence is intentional and documented here — not accidental drift.
 * (Formerly the delta between `NON_FACTUAL_CUES` and `ANALYTICAL_DENYLIST_REGEX`.)
 */
export const DIRECT_FACTUAL_EXTRA_RE =
  /\b(?:how\s+come|evolution|investigate|diagnose|rescue|improve|suggestion|action(?:able)?|strategy|plan|roadmap|next\s+step|fall|drop|grow(?:th|ing)?|decline|surge|spike|driver\s+analysis)\b/i;

/**
 * Diagnostic intent — the user wants a causal "why / what explains / drivers
 * of / decompose the variance" answer. A strict subset of analytical intent
 * that warrants the FULL decision-grade envelope.
 */
export const DIAGNOSTIC_INTENT_RE =
  /\b(?:why\b|how\s+come|what(?:'s|\s+is|\s+are)?\s+driving|what\s+(?:drives|explains|caused|explain)|drivers?\s+of|driver\s+analysis|root\s*cause|decompose|variance|diagnos(?:e|tic)|attribution|what'?s\s+behind)\b/i;

/**
 * Diagnostic-MODE detector — BROADER than DIAGNOSTIC_INTENT_RE. Used by
 * analysisSpecRouter to decide whether to run diagnostic pivots / planner hints
 * (a UX-merge gate), NOT to set the answer depth budget. It deliberately fires
 * on softer "factors driving / success in / performance in / investigating"
 * phrasing that should NOT, on its own, force a FULL-depth answer — so it is a
 * SEPARATE constant from DIAGNOSTIC_INTENT_RE rather than the same one. Both
 * live here so the diagnostic vocabulary has exactly one home. (Formerly the
 * private `DIAGNOSTIC_RE` in analysisSpecRouter.ts.)
 */
export const DIAGNOSTIC_MODE_RE =
  /\b(factors?\s+driving|drivers?\s+of|driving\s+\w+|root\s*cause|what\s+(drives|explains)|why\s+(did|is|are|was|were)|investigating\b|contributing\s+to|success\s+in|performance\s+in|deep\s*dive|associations?\s+with)\b/i;

/**
 * Strategic intent — the user wants a recommendation / action / scenario /
 * optimisation. Warrants the FULL envelope (recommendations, magnitudes).
 */
export const STRATEGIC_INTENT_RE =
  /\b(?:recommend|recommendation|should\s+(?:we|i|they)|optimi[sz]e|optimi[sz]ation|reallocate|redistribute|scenario|what\s+if|rescue|improve|strategy|strategic|roadmap|next\s+step|action\s+plan|prioriti[sz]e|invest\s+(?:more|less|in))\b/i;

/** Time-evolution intent — "over time / trend / evolution / growth". */
export const TREND_INTENT_RE =
  /\b(?:over\s*time|overtime|trend|trends|trending|evolution|month\s*over\s*month|year\s*over\s*year|growth|decline|seasonal|seasonality)\b/i;

/**
 * Factual interrogative leaders — the question opens like a plain fact ask.
 * (Promoted from `FACTUAL_LEADERS` in isDirectFactualQuestion.) Matched against
 * the lower-cased, trimmed question.
 */
export const FACTUAL_LEADER_RES: RegExp[] = [
  /^\s*what\s+(?:is|are|was|were)\s+/,
  /^\s*which\s+/,
  /^\s*how\s+many\s+/,
  /^\s*how\s+much\s+/,
  /^\s*list\s+/,
  /^\s*show\s+(?:me\s+)?/,
  /^\s*give\s+me\s+/,
  /^\s*tell\s+me\s+/,
  /^\s*name\s+the\s+/,
  /^\s*find\s+(?:the\s+)?/,
  /^\s*who\s+(?:is|are|was|were|has|have|had)\s+/,
  /^\s*when\s+(?:is|are|was|were|did|does|do)\s+/,
  /^\s*where\s+(?:is|are|was|were|did|does|do)\s+/,
];

/**
 * Lookup-shape opener — must match the START of the trimmed question. Captures
 * top/bottom/highest/lowest/list/show/how many/count/sum/total/average/avg/
 * mean/latest/most recent, plus "what's the top/bottom/etc.". (Promoted
 * verbatim from `LOOKUP_SHAPE_REGEX` in quickAnswerDetector.)
 */
export const LOOKUP_SHAPE_RE =
  /^(?:top|bottom|highest|lowest|max|min|list|show(?:\s+me)?|what(?:'s|\s+is|\s+are|\s+were)?\s+(?:the\s+)?(?:top|bottom|highest|lowest|max|min|list|count|sum|total|average|avg|mean)|how\s+many|count|sum|total|average|avg|mean|latest|most\s+recent|which\s+\d+)\b/i;

/**
 * Multi-part conjunction — "top 10 X **and** tell me why they grew". Even if
 * the head clause is a lookup, the tail demands analysis. (Promoted verbatim
 * from `MULTI_PART_CONJUNCTION_REGEX` in quickAnswerDetector — the canonical
 * multi-part signal for routing; detectMultiPartQuestion remains a separate,
 * richer SPLITTER and is unaffected.)
 */
export const MULTI_PART_RE =
  /\band\s+(?:why|how|what(?:'s|\s+is|\s+are)?\s+(?:driving|causing|behind)|tell\s+me|explain|investigate|dig|figure\s+out)/i;

/**
 * Combined "this question is NOT a plain factual ask" predicate used by
 * isDirectFactualQuestion. Equals ANALYTICAL_CORE_RE ∪ DIRECT_FACTUAL_EXTRA_RE.
 */
export function isNonFactualPhrasing(lowerQuestion: string): boolean {
  return (
    ANALYTICAL_CORE_RE.test(lowerQuestion) ||
    DIRECT_FACTUAL_EXTRA_RE.test(lowerQuestion)
  );
}

/**
 * Classify a question once. Pure — safe to call before any other step and to
 * memoise on the execution context.
 *
 * depthBudget policy (conservative — only CLEARLY simple questions get
 * `minimal`; anything ambiguous stays `standard`, i.e. today's behaviour):
 *   - diagnostic / strategic        → full
 *   - direct-factual OR lookup-shape → minimal
 *   - everything else               → standard
 */
export function classifyQueryIntent(
  question: string | undefined | null
): QueryIntent {
  const raw = typeof question === "string" ? question.trim() : "";
  const lower = raw.toLowerCase();

  const analytical = raw.length > 0 && ANALYTICAL_CORE_RE.test(lower);
  const diagnostic = raw.length > 0 && DIAGNOSTIC_INTENT_RE.test(lower);
  const strategic = raw.length > 0 && STRATEGIC_INTENT_RE.test(lower);
  const trend = raw.length > 0 && TREND_INTENT_RE.test(lower);
  const isMultiPart = raw.length > 0 && MULTI_PART_RE.test(lower);

  // Direct factual: opens with a factual interrogative AND carries no
  // analytical / strategy cue. Biased to false when unsure (keeps recs).
  const factualLeader =
    lower.length >= 4 && FACTUAL_LEADER_RES.some((rx) => rx.test(lower));
  const isDirectFactual =
    factualLeader && !analytical && !DIRECT_FACTUAL_EXTRA_RE.test(lower);

  // Lookup shape: a lookup opener, no analytical cue, not multi-part, within
  // the length budget. (Same contract as the old detectQuickLookup.)
  const isLookupShape =
    raw.length > 0 &&
    raw.length <= MAX_FAST_PATH_QUESTION_LENGTH &&
    LOOKUP_SHAPE_RE.test(raw) &&
    !analytical &&
    !isMultiPart;

  let intentClass: QueryIntentClass;
  let depthBudget: DepthBudget;
  if (diagnostic) {
    intentClass = "diagnostic";
    depthBudget = "full";
  } else if (strategic) {
    intentClass = "strategic";
    depthBudget = "full";
  } else if (isDirectFactual || isLookupShape) {
    intentClass = "lookup";
    depthBudget = "minimal";
  } else if (analytical || trend || isMultiPart) {
    intentClass = "descriptive";
    depthBudget = "standard";
  } else {
    // Unknown shape (e.g. "sales by region for furniture"): keep today's
    // behaviour — neither stripped nor force-expanded.
    intentClass = "descriptive";
    depthBudget = "standard";
  }

  return {
    intentClass,
    depthBudget,
    isDirectFactual,
    isLookupShape,
    isMultiPart,
    signals: { analytical, diagnostic, strategic, trend },
  };
}

/** Convenience: does this question warrant the trimmed, minimal-output path? */
export function isMinimalDepth(question: string | undefined | null): boolean {
  return classifyQueryIntent(question).depthBudget === "minimal";
}
