/**
 * ============================================================================
 * insightHelpers.ts — de-duplicating appender for the answer's insight list
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Adds a one-line "key insight" to the list of Insights an answer carries,
 *   but skips it if it is blank or looks like a near-duplicate of one already
 *   present. (An "Insight" is a short takeaway the UI renders as a card.)
 *
 * WHY IT MATTERS
 *   Prevents the same takeaway from showing up twice on screen and keeps the
 *   insight list tidy as different parts of a turn each try to contribute one.
 *
 * KEY PIECES
 *   - appendEnvelopeInsight(mergedInsights, keyInsight) — mutate the array in
 *     place; assigns the next sequential id when it does add.
 *
 * HOW IT CONNECTS
 *   Used while assembling the final answer envelope in the agent runtime;
 *   the Insight type comes from shared/schema.ts.
 */
import type { Insight } from "../../../shared/schema.js";

/**
 * Appends keyInsight to the shared insights array unless it is blank or a
 * near-duplicate of an existing entry. Not gated on chart count — pivot
 * responses with associated charts also deserve an InsightCard.
 */
export function appendEnvelopeInsight(
  mergedInsights: Insight[],
  keyInsight?: string
): void {
  if (!keyInsight?.trim()) return;
  const text = keyInsight.trim();
  const duplicate = mergedInsights.some((i) => i.text.slice(0, 50) === text.slice(0, 50));
  if (duplicate) return;
  const nextId = mergedInsights.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  mergedInsights.push({ id: nextId, text });
}
