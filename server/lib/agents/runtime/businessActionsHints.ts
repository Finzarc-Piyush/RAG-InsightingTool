/**
 * Strategy-intent hint extraction.
 *
 * Pure-function regex over the user's question that produces *informational*
 * hints for the businessActionsAgent's user message — never gates whether the
 * agent fires. The agent reads the hints alongside the question text and
 * decides for itself whether to emit business actions; an empty hint list is
 * NOT a signal that the question lacks strategy intent (it might be phrased
 * naturally — "the team's wondering what to do about LASHE — talk me through
 * it" — and still warrant actions).
 *
 * If you find yourself wanting to add a hint here to "make the agent fire",
 * resist: improve the agent prompt instead. Hints are observations about the
 * question's surface form, not directives.
 */

const HINT_PATTERNS: ReadonlyArray<{
  label: string;
  re: RegExp;
}> = [
  // Action verb + business outcome noun (the strongest signal).
  // Use `\w*` after each noun stem to absorb plurals / inflected forms
  // ("margin" → "margins", "cost" → "costs", "share" → "shares").
  {
    label: "action verb + business outcome",
    re: /\b(increase|grow|boost|lift|drive|improve|rescue|fix|save|protect|defend|reduce|cut|optimi[sz]e|recover|restore|stabili[sz]e|expand|scale|accelerate|falling|declining|dropping|slumping|losing)\b[\s\S]{0,80}\b(sales|revenue|profit|profitabilit\w*|margin\w*|market\s+share\w*|share\w*|growth|customer\w*|retention|churn|cost\w*|expense\w*|spend|budget\w*|portfolio\w*|brand\w*|distribution|penetration|loyalty|categor\w*|segment\w*|sku\w*|product\w*|line\w*)\b/i,
  },
  // Imperative question shape (open strategy ask).
  {
    label: "imperative shape",
    re: /\b(how\s+(do|should|can|might|do\s+we|should\s+we|can\s+we)|what\s+should\s+(i|we|they)|should\s+(i|we|they|the\s+team)|where\s+should\s+(i|we|they)\s+(focus|invest|allocate|cut|prioriti[sz]e)|what(?:'s|\s+is)\s+the\s+best\s+way\s+to)\b/i,
  },
  // Explicit ask for strategy / actions / decisions.
  {
    label: "explicit strategy ask",
    re: /\b(strateg(y|ies|ic\s+options?)|action\s+items?|next\s+steps?|playbook|prioriti(?:s|z)e|recommend(ations?)?\s+for|what\s+would\s+you\s+(do|advise|recommend)|talk\s+me\s+through|walk\s+me\s+through|make\s+a\s+case|game\s*plan|plan\s+of\s+action|decide|decision\w*|focus\s+on|where\s+to\s+invest|where\s+to\s+cut)\b/i,
  },
  // Implicit decision-making framing (asks the model for an opinion / call).
  {
    label: "decision framing",
    re: /\b(your\s+take|your\s+opinion|your\s+advice|any\s+thoughts?|what\s+(would|do)\s+you\s+think|the\s+team(?:'s|\s+is)\s+wondering|we(?:'re|\s+are)\s+(thinking|trying\s+to\s+(decide|figure))|help\s+me\s+(decide|prioriti[sz]e|figure))\b/i,
  },
];

/**
 * Returns short labelled hints for any strategy-intent patterns the question
 * matches. Empty array on no matches — caller must NOT treat that as a gate.
 *
 * Intentionally over-recall, under-precision: false positives just hand the
 * agent a hint it can ignore; false negatives are the failure mode we are
 * actively avoiding by making this non-gating.
 */
export function extractStrategyIntentHints(question: string): string[] {
  const q = (question ?? "").trim();
  if (!q) return [];
  const hits: string[] = [];
  for (const { label, re } of HINT_PATTERNS) {
    if (re.test(q)) hits.push(label);
  }
  return hits;
}
