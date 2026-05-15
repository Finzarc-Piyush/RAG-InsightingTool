/**
 * PVT3 · classify whether a user question is a direct factual ask
 * ("What is the average X per Y?", "Which Z has the most W?", "How many ...")
 * that does NOT warrant follow-up recommendations / "further investigation"
 * suggestions in the answer envelope.
 *
 * Returns true only when:
 * - the question shape leads with a factual interrogative ("what", "which",
 *   "how many", "how much", "list", "show me", "give me", "tell me",
 *   "name the", "find the") OR is an imperative listing ("show", "list"), AND
 * - no comparative / diagnostic / strategic / why-driven cue is present
 *   ("why", "drivers", "compare", "vs", "trend", "decompose", "explain",
 *   "investigate", "deep dive", "diagnose", "what if", "scenario", "rescue",
 *   "improve", "predict", "forecast").
 *
 * Intentional false-negatives over false-positives — when in doubt, treat as
 * non-factual so recommendations are kept. The user explicitly said "if user
 * asks a direct quest, no need to go for further investigation"; this matches
 * the *direct* shape, not strategy-flavored asks.
 */
const FACTUAL_LEADERS = [
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

const NON_FACTUAL_CUES =
  /\b(?:why|how\s+come|driver|drivers|driving|compare(?:d|s)?|comparison|versus|\bvs\b|trend(?:s|ing)?|evolution|over\s+time|decompose|breakdown\s+(?:why|the\s+reason)|explain|investigate|deep\s+dive|diagnose|what[\s-]*if|scenario|rescue|improve|optimi[sz]e|predict|forecast|recommend|suggestion|action(?:able)?|strategy|plan|roadmap|next\s+step|fall|drop|grow(?:th|ing)?|decline|surge|spike|root\s+cause|driver\s+analysis)\b/i;

export function isDirectFactualQuestion(question: string | undefined | null): boolean {
  if (!question) return false;
  const q = String(question).trim().toLowerCase();
  if (!q || q.length < 4) return false;

  if (NON_FACTUAL_CUES.test(q)) return false;

  return FACTUAL_LEADERS.some((rx) => rx.test(q));
}
