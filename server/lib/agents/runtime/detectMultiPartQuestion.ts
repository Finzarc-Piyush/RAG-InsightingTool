/**
 * Wave D1 · Detect multi-part questions that would benefit from
 * coordinator decomposition into parallel sub-investigations.
 *
 * Examples we want to catch (and split):
 *   - "show me top 10 brands AND tell me why MARICO is leading"
 *   - "compare A vs B, ALSO show the trend over time"
 *   - "what drove the Q3 drop, AND what should we do about it"
 *   - "give me regional sales; ALSO check Q4 anomalies"
 *
 * The W11–W13 single-flow policy bypasses `coordinatorAgent.decomposeQuestion`
 * (currently dormant). D1 ships a deterministic detector that:
 *   1. Returns the sub-questions when the question matches a multi-part shape
 *   2. Returns null for single-shape questions (the common case — agent
 *      loop proceeds normally)
 *
 * Decomposition happens via simple conjunction splitting + light cleanup.
 * Each sub-question is treated as a standalone analytical request by the
 * caller. Cap at 4 sub-questions (the W11 budget) — anything beyond is
 * truncated with a log line.
 *
 * Gated by `DEEP_INVESTIGATION_ENABLED=true` at the call site; the
 * detector itself is pure logic so unit tests run unconditionally.
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
 * Wave D1 · Detect multi-part questions.
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
    // Cap at 4 total per W11 budget.
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
