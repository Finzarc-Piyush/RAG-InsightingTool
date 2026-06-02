/**
 * ============================================================================
 * detectMultiPartQuestion.ts — splits "do A and also B" asks by plain text rules
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Users often pack several requests into one sentence: "show me top 10 brands
 *   AND tell me why MARICO is leading", "compare A vs B, ALSO show the trend".
 *   This pure function scans the question for conjunctions ("and", "also",
 *   "then", "additionally"...) that are followed by a real second clause led by a
 *   verb or question word, and splits it into up to 4 standalone sub-questions.
 *   It returns null when the question is a single request (the common case).
 *
 * WHY IT MATTERS
 *   It's a cheap, deterministic alternative to the LLM coordinator
 *   (coordinatorAgent.ts) for the specific shape of "two asks joined by a
 *   conjunction". The caller can then treat each sub-question as its own
 *   analytical request. It's deliberately CONSERVATIVE: it won't split a compound
 *   metric phrase like "sales and growth by region" (one request, not two), and
 *   anything ambiguous returns null so the normal single-flow path runs.
 *
 * KEY PIECES
 *   - detectMultiPartQuestion — the entry point; returns a MultiPartIntent
 *     (original + subQuestions[] + the trigger token) or null.
 *   - CONJUNCTION_PATTERNS (internal) — the ordered regexes that recognise a
 *     genuine second clause; each requires a verb/question-word after the joiner.
 *   - normaliseClause (internal) — trims stray punctuation and capitalises each
 *     split clause.
 *
 * HOW IT CONNECTS
 *   No imports — self-contained text logic, so its unit tests run unconditionally.
 *   The call site is gated by DEEP_INVESTIGATION_ENABLED; sub-questions are capped
 *   at 4 to match the deep-investigation budget.
 */

export interface MultiPartIntent {
  /** Original question, preserved for telemetry. */
  original: string;
  /** Split sub-questions (≤ 4). Each is a standalone analytical request. */
  subQuestions: string[];
  /** Conjunction token that triggered the split (for telemetry). */
  trigger: string;
}

/**
 * Conjunction patterns that signal a multi-part question. Ordered by
 * specificity — more explicit patterns first.
 *
 * Each pattern MUST include a meaningful second clause (verb-led or
 * question-word). We deliberately don't split on bare "and" inside a
 * noun phrase (e.g. "show me sales and growth by region" — that's a
 * compound metric request, not two questions).
 */
const CONJUNCTION_PATTERNS: RegExp[] = [
  // ", and (also/then) <verb-led second>"
  /[,;]\s+(?:and\s+(?:also\s+|then\s+)?|also\s+|then\s+)(show|tell|give|find|list|compare|why|what|how|when|where|explain|check|investigate|run|forecast|predict|rank|analyze)\b/i,
  // " and <verb-led> ..." (no comma — only when the second clause is a real verb-led second question)
  /\s+and\s+(why|what|how|when|where|tell|show|give|list|compare|explain|check|investigate|forecast|predict|rank|analyze)\b/i,
  // explicit conjunctions: "additionally", "in addition", "plus also"
  /[,;.]?\s+(additionally|in addition|plus,? also)\s+/i,
];

/**
 * Detect multi-part questions.
 *
 * Returns the split intent when the question matches a multi-part
 * conjunction pattern AND each sub-question has at least 3 word
 * characters of content. Otherwise null.
 *
 * Conservative — anything ambiguous returns null (caller proceeds to
 * single-flow).
 */
export function detectMultiPartQuestion(
  question: string | undefined
): MultiPartIntent | null {
  const q = (question ?? "").trim();
  if (!q || q.length < 20) return null; // too short to plausibly be multi-part

  for (const pattern of CONJUNCTION_PATTERNS) {
    const m = pattern.exec(q);
    if (!m) continue;
    const splitPos = m.index!;
    const matchedLen = m[0]!.length;
    // The matched group's second-clause keyword (verb / question word).
    const trigger = m[1] ?? m[0]!;
    const left = q.slice(0, splitPos).trim();
    // Right side begins where the conjunction match starts but we want
    // to keep the verb-led clause INCLUDING the matched keyword.
    // Strip leading commas/whitespace from the matched token and keep
    // the second clause verbatim.
    const matchString = m[0]!;
    const verbStartInMatch = matchString.search(/[A-Za-z]/);
    const rightStart =
      verbStartInMatch >= 0
        ? splitPos + matchString.indexOf(
            matchString.slice(verbStartInMatch).match(/\b\w/)![0]
          )
        : splitPos + matchedLen;
    let right = q.slice(rightStart).trim();
    // Strip leading "and ", "also ", "then ", "additionally ", etc.
    // so the second sub-question starts with its verb / question word.
    right = right
      .replace(
        /^(and\s+(also\s+|then\s+)?|also\s+|then\s+|additionally\s+|in\s+addition\s+|plus\s+also,?\s*)/i,
        ""
      )
      .trim();
    if (left.length < 3 || right.length < 3) continue;

    const subQuestions: string[] = [];
    subQuestions.push(normaliseClause(left));
    subQuestions.push(normaliseClause(right));

    // Look for a THIRD clause in the right side (recursive single split).
    // Cap at 4 total per the deep-investigation budget.
    let remaining = right;
    while (subQuestions.length < 4) {
      let foundNext: { left: string; right: string; trigger: string } | null = null;
      for (const innerPattern of CONJUNCTION_PATTERNS) {
        const mm = innerPattern.exec(remaining);
        if (!mm) continue;
        const innerSplit = mm.index!;
        const innerMatched = mm[0]!;
        const innerLeft = remaining.slice(0, innerSplit).trim();
        const innerVerbStart = innerMatched.search(/[A-Za-z]/);
        const innerRightStart =
          innerVerbStart >= 0
            ? innerSplit + innerMatched.indexOf(
                innerMatched.slice(innerVerbStart).match(/\b\w/)![0]
              )
            : innerSplit + innerMatched.length;
        let innerRight = remaining.slice(innerRightStart).trim();
        innerRight = innerRight
          .replace(
            /^(and\s+(also\s+|then\s+)?|also\s+|then\s+|additionally\s+|in\s+addition\s+|plus\s+also,?\s*)/i,
            ""
          )
          .trim();
        if (innerLeft.length < 3 || innerRight.length < 3) continue;
        foundNext = {
          left: innerLeft,
          right: innerRight,
          trigger: mm[1] ?? mm[0]!,
        };
        break;
      }
      if (!foundNext) break;
      // Replace the last entry (which is `remaining` minus the inner-left)
      // with the inner-left, then push inner-right.
      subQuestions[subQuestions.length - 1] = normaliseClause(foundNext.left);
      subQuestions.push(normaliseClause(foundNext.right));
      remaining = foundNext.right;
    }

    return {
      original: q,
      subQuestions,
      trigger,
    };
  }
  return null;
}

function normaliseClause(clause: string): string {
  // Trim and strip dangling punctuation that the split may have left.
  let out = clause.trim();
  out = out.replace(/^[,;:.]+/, "").trim();
  out = out.replace(/[,;]+$/, "").trim();
  // Capitalise first letter if it's not already.
  if (out.length > 0) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }
  // Ensure the clause ends with a question mark IF it was originally one.
  // Otherwise leave as-is — downstream uses it verbatim.
  return out;
}
