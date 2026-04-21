import type { Insight } from "../../../shared/schema.js";

/**
 * Appends keyInsight to the shared insights array unless it is blank or a
 * near-duplicate of an existing entry.  No longer gated on chart count —
 * pivot responses with associated charts also deserve an InsightCard.
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
