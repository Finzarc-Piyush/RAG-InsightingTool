/**
 * ============================================================================
 * kpiStripBlock.ts — "Headline numbers" strip for the dashboard
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Takes up to 4 "magnitudes" (a magnitude is a labelled headline number such
 *   as "Revenue — $1.2M") from an answer and formats them into a small markdown
 *   block (a "narrative block") that the dashboard can show as a KPI strip.
 *   "KPI" = Key Performance Indicator, the few numbers that matter most.
 *
 * WHY IT MATTERS
 *   It is built deterministically from the answer's own figures and prepended
 *   to the Executive Summary sheet, so the headline numbers always appear even
 *   if the dashboard-writing LLM forgot to mention them.
 *
 * KEY PIECES
 *   - KpiMagnitude — { label, value, optional confidence } input shape.
 *   - buildKpiStripBlock(magnitudes) — returns a DashboardNarrativeBlock, or
 *     null when no valid magnitude was supplied.
 *
 * HOW IT CONNECTS
 *   Called by the dashboard builder (buildDashboardFromTurn) after its LLM call
 *   returns. DashboardNarrativeBlock comes from shared/schema.ts.
 */
import { randomUUID } from "crypto";

import type { DashboardNarrativeBlock } from "../../../shared/schema.js";

export interface KpiMagnitude {
  label: string;
  value: string;
  confidence?: "low" | "medium" | "high";
}

/**
 * Returns a narrative block when at least one valid magnitude is supplied,
 * null otherwise. Caller is responsible for placement (typically prepend
 * to Sheet 1).
 */
export function buildKpiStripBlock(
  magnitudes: KpiMagnitude[] | undefined
): DashboardNarrativeBlock | null {
  const cleaned = (magnitudes ?? []).filter(
    (m) =>
      typeof m?.label === "string" &&
      m.label.trim().length > 0 &&
      typeof m?.value === "string" &&
      m.value.trim().length > 0
  );
  if (cleaned.length === 0) return null;

  const top = cleaned.slice(0, 4);

  const lines = top.map((m) => {
    const conf = m.confidence ? ` _(confidence: ${m.confidence})_` : "";
    return `- **${m.label}** — ${m.value}${conf}`;
  });

  return {
    id: randomUUID(),
    role: "custom",
    title: "Headline numbers",
    body: lines.join("\n"),
    order: 0,
  };
}
