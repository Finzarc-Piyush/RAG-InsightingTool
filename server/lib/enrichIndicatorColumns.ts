/**
 * SU-IC2 · LLM-augmented enrichment for indicator columns.
 *
 * SU-IC1's heuristic detector identifies *which* columns are indicators
 * and partitions their values into positive / negative / sentinel buckets
 * when the dictionary can disambiguate. SU-IC2 adds two pieces of
 * semantic richness on top:
 *
 *   1. `answersQuestions: string[]` — natural-language phrasings the
 *      column directly answers ("what % of staff clocked in before
 *      9:30?", "attendance punctuality breakdown"). Lets the planner +
 *      the schema-binding LLM map a fuzzy user question to the indicator
 *      column by *meaning*, not just by name token overlap.
 *
 *   2. `positiveValues` / `negativeValues` adjudication when SU-IC1
 *      couldn't resolve them (e.g. "Adherent"/"Compliant" — the
 *      heuristic dictionary covers some but not all variants).
 *
 * Cost discipline: this fires *only* when the heuristic flagged ≥ 1
 * column, only sends the indicator column metadata (name + topValues +
 * SU-IC1 partition), and routes through the MINI tier (gpt-4o-mini /
 * Haiku) for ~$0.0001/call. System prompt is byte-stable so the
 * prompt-cache eligibility kicks in across uploads.
 *
 * Failure modes are isolated: any error / timeout / malformed response
 * leaves the heuristic-only state intact. The pipeline never throws
 * upstream.
 */

import { z } from "zod";
import type { DataSummary } from "../shared/schema.js";
import { completeJson } from "./agents/runtime/llmJson.js";
import { LLM_PURPOSE } from "./agents/runtime/llmCallPurpose.js";

const indicatorEnrichmentSchema = z.object({
  enrichments: z
    .array(
      z.object({
        column: z.string().min(1).max(200),
        answersQuestions: z.array(z.string().min(1).max(200)).max(4),
        positiveValues: z.array(z.string().min(1).max(200)).max(8).optional(),
        negativeValues: z.array(z.string().min(1).max(200)).max(8).optional(),
      })
    )
    .max(20),
});

type IndicatorEnrichment = z.infer<typeof indicatorEnrichmentSchema>;

const SYSTEM_PROMPT = `You annotate pre-computed "indicator" columns in tabular datasets — low-cardinality columns whose values directly answer a common analytical question (e.g. a "Clock-In <09:30" column with values Yes/No/Absent answers attendance-punctuality questions).

Input: a JSON object with "shortDescription" (one-line dataset summary) and "indicators" — an array of indicator candidates, each with:
- column: the column header (verbatim).
- distinctValues: up to 8 distinct cell values seen in the column.
- kind: "boolean" or "categorical" — the heuristic's structural classification.
- positiveValuesGuess / negativeValuesGuess: optional partition the heuristic produced (Yes/No-like). Empty arrays mean the heuristic couldn't resolve them.

Return ONLY a JSON object: { "enrichments": [...] }. For EACH input indicator emit one entry with:
- column: the same header verbatim.
- answersQuestions: 1–4 short natural-language phrasings that the column directly answers, written as the user might type them in chat. Be concrete, use units when relevant. Example for "Clock-In <09:30" with Yes/No/Absent: ["what % of staff clocked in before 9:30 am?", "attendance punctuality breakdown", "who clocked in late?"].
- positiveValues / negativeValues: ONLY when the heuristic guess was empty AND the values are unambiguous (e.g. ["Adherent"] vs ["Non-Adherent"], or ["On"] vs ["Off"]). Skip these fields when (a) the heuristic guess was non-empty (don't override) or (b) the values are genuinely categorical with no clear "good"/"bad" axis (e.g. {Bronze, Silver, Gold, Platinum}).

Use the exact column header verbatim. Do not invent columns. Phrase questions in natural English, not SQL.`;

interface BuildPayloadInput {
  summary: DataSummary;
  shortDescription?: string;
}

interface IndicatorPayloadEntry {
  column: string;
  distinctValues: string[];
  kind: "boolean" | "categorical";
  positiveValuesGuess: string[];
  negativeValuesGuess: string[];
}

function buildPayload(
  input: BuildPayloadInput
): { indicators: IndicatorPayloadEntry[]; payload: string } {
  const indicators: IndicatorPayloadEntry[] = [];
  for (const col of input.summary.columns) {
    if (!col.indicator) continue;
    if (col.indicator.source === "user") continue; // user already authoritative
    const distinct = (col.topValues ?? [])
      .map((tv) => String(tv.value))
      .slice(0, 8);
    indicators.push({
      column: col.name,
      distinctValues: distinct,
      kind: col.indicator.kind,
      positiveValuesGuess: col.indicator.positiveValues ?? [],
      negativeValuesGuess: col.indicator.negativeValues ?? [],
    });
  }
  const payload = JSON.stringify({
    shortDescription: input.shortDescription ?? "",
    indicators,
  });
  return { indicators, payload };
}

/**
 * Stamp the LLM enrichment back onto the per-column meta. Idempotent —
 * preserves user-source fields, leaves heuristic positive/negative
 * partitions alone when the LLM didn't override.
 */
function applyEnrichment(
  summary: DataSummary,
  enrichment: IndicatorEnrichment
): void {
  for (const e of enrichment.enrichments) {
    const col = summary.columns.find((c) => c.name === e.column);
    if (!col || !col.indicator) continue;
    if (col.indicator.source === "user") continue;
    if (e.answersQuestions.length > 0) {
      col.answersQuestions = e.answersQuestions;
    }
    // Only fill polarity when the heuristic guess was empty AND the LLM
    // provided one. Don't overwrite a heuristic-resolved partition.
    const indicator = col.indicator;
    const hadPos = (indicator.positiveValues ?? []).length > 0;
    const hadNeg = (indicator.negativeValues ?? []).length > 0;
    if (!hadPos && e.positiveValues && e.positiveValues.length > 0) {
      indicator.positiveValues = e.positiveValues;
      indicator.source = "llm";
    }
    if (!hadNeg && e.negativeValues && e.negativeValues.length > 0) {
      indicator.negativeValues = e.negativeValues;
      indicator.source = "llm";
    }
  }
}

/**
 * Run the indicator-enrichment LLM pass on the supplied summary in place.
 *
 * No-op (zero LLM cost) when the summary has no indicator columns yet —
 * SU-IC1 must run first via `applyIndicatorsToSummary`.
 *
 * Failure isolation: any error / timeout / parse failure leaves the
 * heuristic-only state intact and never throws.
 */
export async function enrichIndicatorColumns(
  summary: DataSummary,
  options?: { shortDescription?: string; timeoutMs?: number }
): Promise<{ enriched: number }> {
  const { indicators, payload } = buildPayload({
    summary,
    shortDescription: options?.shortDescription,
  });
  if (indicators.length === 0) return { enriched: 0 };

  const timeoutMs =
    options?.timeoutMs ??
    (Number(process.env.INDICATOR_ENRICH_TIMEOUT_MS) || 20_000);

  try {
    const winner = await Promise.race([
      completeJson(SYSTEM_PROMPT, payload, indicatorEnrichmentSchema, {
        maxTokens: 1024,
        temperature: 0.2,
        turnId: "indicator_enrich",
        purpose: LLM_PURPOSE.INDICATOR_ENRICH,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (winner === null) {
      console.warn(
        `⚠️ enrichIndicatorColumns: timeout after ${timeoutMs}ms; keeping heuristic-only state`
      );
      return { enriched: 0 };
    }
    if (!winner.ok) {
      console.warn(
        "⚠️ enrichIndicatorColumns: LLM parse failed:",
        winner.error
      );
      return { enriched: 0 };
    }
    applyEnrichment(summary, winner.data);
    return { enriched: winner.data.enrichments.length };
  } catch (err) {
    console.warn("⚠️ enrichIndicatorColumns:", err);
    return { enriched: 0 };
  }
}
