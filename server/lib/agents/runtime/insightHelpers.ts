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
 * W-INS-DEDUP · Canonical form for comparing two insight strings: drop bold
 * markers, collapse whitespace, lowercase. Mirrors the client's
 * insightText.normalizeInsightText so both sides agree on what "the same
 * insight" means.
 */
export function normalizeInsightText(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Appends keyInsight to the shared insights array unless it is blank or a
 * duplicate of an existing entry. Not gated on chart count — pivot
 * responses with associated charts also deserve an InsightCard.
 */
export function appendEnvelopeInsight(
  mergedInsights: Insight[],
  keyInsight?: string
): void {
  if (!keyInsight?.trim()) return;
  const text = keyInsight.trim();
  const key = normalizeInsightText(text);
  const duplicate = mergedInsights.some((i) => normalizeInsightText(i.text) === key);
  if (duplicate) return;
  const nextId = mergedInsights.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  mergedInsights.push({ id: nextId, text });
}

/**
 * W-INS-DEDUP · De-duplicating batch appender for tool-emitted insights.
 * The tool-merge seam (agentLoop) previously did a raw `push(...result.insights)`
 * with NO dedup, so when the loop emitted the same insight set across two tool
 * turns (e.g. a replan / re-run) the whole batch stacked → "7 insights then the
 * same 7 again". This routes every tool batch through the same normalized-text
 * dedup the envelope path uses, assigning sequential ids as it adds.
 */
export function mergeInsights(
  mergedInsights: Insight[],
  incoming: Insight[] | undefined
): void {
  if (!incoming?.length) return;
  for (const item of incoming) {
    const text = item?.text?.trim();
    if (!text) continue;
    const key = normalizeInsightText(text);
    if (mergedInsights.some((i) => normalizeInsightText(i.text) === key)) continue;
    const nextId = mergedInsights.reduce((m, i) => Math.max(m, i.id), 0) + 1;
    mergedInsights.push({ id: nextId, text });
  }
}
