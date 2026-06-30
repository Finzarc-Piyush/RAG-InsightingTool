/**
 * ============================================================================
 * recommendationQualityGuard.ts — single authority: drop common-sense filler
 * ============================================================================
 * PRODUCT RULE (user, 2026-06-30)
 *   "Current recommendations / 'do's are more like common sense than actual
 *   suggestions." A recommendation like "Monitor performance closely" or
 *   "Consider improving sales" is filler — it names no lever the reader can pull
 *   and carries no number, so it reads as boilerplate, not a decision. Every
 *   recommendation surfaced to the user must clear a SPECIFICITY bar.
 *
 * WHY DETERMINISTIC (not just a prompt)
 *   The ANSWER_ENVELOPE_CONTRACT already tells the narrator to name a concrete
 *   move with a quantified impact — but a prompt is a hint, not a guarantee, and
 *   the model still slips into "keep an eye on X". This pure guard is THE
 *   guarantee (mirrors `suggestedQuestionGuard`): the narrator / synthesis path
 *   routes recommendations through it before they can reach a rendered field, so
 *   no path re-introduces filler downstream.
 *
 * CONSERVATIVE BY DESIGN — drop ONLY the genuinely empty
 *   A recommendation is dropped ONLY when ALL THREE hold:
 *     1. its `action` is dominated by a VAGUE directive verb ("monitor",
 *        "consider", "keep an eye on", "focus on", "leverage", "improve" …), AND
 *     2. it names NO concrete business lever (channel / SKU / price / spend /
 *        assortment / distribution / promo / region / margin …), AND
 *     3. it carries NO number anywhere (action + rationale + expectedImpact).
 *   A single number OR a single named lever is enough to KEEP it. This makes the
 *   guard pure subtraction with a very low false-positive rate — a strong
 *   recommendation ("Reallocate ₹3M of trade spend to the East") never matches,
 *   and it can never PAD output (invariant #12 safe).
 */

/** A recommendation as it appears on the answer envelope. */
export interface RecommendationLike {
  action?: string;
  rationale?: string;
  expectedImpact?: string;
  horizon?: string;
}

// Actions that START with one of these are vague directives — the "what to do"
// is a posture, not a move. Anchored at the start (after an optional polite
// lead-in) so "Defend metro share" / "Reallocate trade spend" never match.
const VAGUE_ACTION_RE =
  /^(?:please\s+|you\s+should\s+|we\s+should\s+|the\s+team\s+should\s+|continue\s+to\s+|keep\s+)?(?:monitor|track|watch|observe|keep\s+(?:an\s+eye|track|tabs)|consider|explore|look\s+into|review|evaluate|assess|examine|investigate|analy[sz]e|understand|study|be\s+mindful|pay\s+attention|stay\s+on\s+top|stay\s+(?:aware|informed)|focus(?:\s+on)?|leverage|maintain|sustain|ensure|improve|enhance|boost|grow|increase|optimi[sz]e|strengthen|prioriti[sz]e)\b/i;

// Concrete FMCG / commercial levers — naming one means the move is actionable.
const LEVER_RE =
  /\b(sku|assortment|distribution|shelf|planogram|pricing|price|mrp|discount|trade\s+spend|spend|budget|promo|promotion|campaign|inventory|stock|stockout|margin|range|listing|placement|store|outlet|beat|route|coverage|reach|frequency|grp|d2c|metro|tier[\s-]?[123]|channel|region|segment|cohort|launch|relaunch|pack|format|variant|portfolio|festive|seasonal)\b/i;

// Any digit, percentage, or currency mark signals a quantified move/target.
const NUMBER_RE = /[\d%₹$]/;

function text(s: string | undefined | null): string {
  return typeof s === "string" ? s : "";
}

/**
 * True when a recommendation is generic filler (fails the specificity bar).
 * Exported so callers / tests can reason about a single item.
 */
export function isGenericRecommendation(rec: RecommendationLike | null | undefined): boolean {
  if (!rec) return true;
  const action = text(rec.action).trim();
  if (!action) return true;
  const combined = `${action} ${text(rec.rationale)} ${text(rec.expectedImpact)}`;
  const vague = VAGUE_ACTION_RE.test(action);
  if (!vague) return false; // strong verb → keep, no further checks
  const hasLever = LEVER_RE.test(combined);
  const hasNumber = NUMBER_RE.test(combined);
  // Vague verb is only filler when it also lacks BOTH a lever and a number.
  return !hasLever && !hasNumber;
}

/**
 * Drop every generic-filler recommendation. Pure; preserves order; never
 * rewrites. Returns a new array (or undefined when the input was undefined, so
 * an absent field stays absent rather than becoming []).
 */
export function filterGenericRecommendations<T extends RecommendationLike>(
  recommendations: readonly T[] | null | undefined
): T[] | undefined {
  if (recommendations == null) return undefined;
  return recommendations.filter((r) => !isGenericRecommendation(r));
}
