/**
 * W7 · Headline Numbers KPI strip.
 *
 * Pure function that turns up to 4 magnitudes from the AnswerEnvelope into a
 * deterministic dashboard narrative block. Prepended to the Executive Summary
 * sheet by `buildDashboardFromTurn` after the LLM call returns, so the strip
 * appears even if the LLM forgot to mention the headline numbers.
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
