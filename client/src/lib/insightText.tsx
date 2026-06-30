import React from 'react';
import { clampInsightDecimals } from '@/lib/cleanEvidenceNumbers';
import { compactizeNumbersInText } from '@/lib/text/compactizeNumbersInText';

/**
 * W-BOLD1 · Shared inline rich-text renderer for analytical INSIGHT surfaces:
 * the chat answer card (TL;DR, findings, drivers, implications, recommendations),
 * the Key-Insights panel, and the chart-insight Why/Do lanes.
 *
 * Returns inline React nodes — NO block wrapper — so it drops into <p>, flex
 * rows, and pills without disturbing layout. Two responsibilities, in order:
 *   1. compact bare/full-precision numbers into the Indian system (₹ + Cr/Lac/K)
 *      so a raw "1,049,389,992.94" the narrator emits renders as "₹104.9 Cr";
 *   2. clamp machine-precision decimals to ≤2 places (W-DEC1);
 *   3. render the markdown **bold** the LLM emits around every data-derived
 *      name + value as <strong>, after stripping orphaned asterisks.
 *
 * The generator side (prompts) is what PRODUCES the `**…**`; this is the render
 * half that DISPLAYS it. Surfaces that already go through MarkdownRenderer
 * (chat body prose, chart-insight headline) get the same treatment there.
 */

// Remove orphaned asterisks / hyphens that aren't part of real markdown, while
// protecting valid **bold**, *italic*, and numeric ranges (e.g. "24.0-41.0").
export function cleanOrphanedAsterisks(text: string): string {
  const placeholders: { [key: string]: string } = {};
  let placeholderCounter = 0;

  // Protect **bold** patterns
  let cleaned = text.replace(/\*\*(.*?)\*\*/g, (match) => {
    const key = `__BOLD_${placeholderCounter}__`;
    placeholders[key] = match;
    placeholderCounter++;
    return key;
  });

  // Protect *italic* patterns
  cleaned = cleaned.replace(/\*([^*\n]+?)\*/g, (match) => {
    const key = `__ITALIC_${placeholderCounter}__`;
    placeholders[key] = match;
    placeholderCounter++;
    return key;
  });

  // Protect number ranges (e.g., "24.0-41.0", "907-1258")
  cleaned = cleaned.replace(/(\d+\.?\d*)\s*-\s*(\d+\.?\d*)/g, (match) => {
    const key = `__RANGE_${placeholderCounter}__`;
    placeholders[key] = match;
    placeholderCounter++;
    return key;
  });

  // Remove orphaned asterisks
  cleaned = cleaned.replace(/\s*\*\s*$/gm, '');
  cleaned = cleaned.replace(/\.\s*\*\s+/g, '. ');
  cleaned = cleaned.replace(/\s+\*\s+/g, ' ');
  cleaned = cleaned.replace(/\s+\*$/gm, '');

  // Remove orphaned hyphens
  cleaned = cleaned.replace(/\s+-\s*$/gm, '');
  cleaned = cleaned.replace(/\.\s+-\s*/g, '. ');
  cleaned = cleaned.replace(/\.\s+-\s*$/gm, '.');
  cleaned = cleaned.replace(/-\s+$/gm, '');

  // Restore protected patterns
  Object.keys(placeholders).forEach((key) => {
    cleaned = cleaned.replace(key, placeholders[key]);
  });

  return cleaned;
}

/**
 * Plain (string) variant: clamp decimals and STRIP any bold markers, returning
 * a clean string. Use where the surrounding chrome already provides emphasis
 * (e.g. the magnitude badge, which is its own accent pill) so a nested <strong>
 * would fight the host styling.
 */
export function plainInsightText(text: string | null | undefined): string {
  if (!text) return "";
  return cleanOrphanedAsterisks(
    clampInsightDecimals(compactizeNumbersInText(text)),
  ).replace(/\*\*/g, "");
}

/**
 * Clamp decimals → strip orphaned asterisks → split on `**…**` → render bold
 * spans. Returns an array of inline nodes (plain strings for non-bold runs,
 * <strong> for bold runs). Empty array for empty/nullish input.
 */
export function renderInsightText(
  text: string | null | undefined,
): React.ReactNode[] {
  if (!text) return [];
  const cleaned = cleanOrphanedAsterisks(
    clampInsightDecimals(compactizeNumbersInText(text)),
  );
  const parts = cleaned.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

/**
 * W-BOLD2 · Split a Key-Insight string into a headline + optional detail at the
 * FIRST em-dash separator ("… — …"), the shape `deriveInsightsFromEnvelope`
 * emits. Also strips a leading bullet glyph the model sometimes prepends
 * ("* ", "- ", "• "). This replaces the old `parseInsightSubPoints`, which split
 * on every `**…**` marker — catastrophic once the generator bolds EVERY data
 * token (one fragment per token → one clause per line). Splitting on the em-dash
 * instead keeps the headline and detail as at most two lines; heavy inline bold
 * flows WITHIN each line and can never fragment it.
 */
export function splitInsightHeadlineDetail(
  text: string | null | undefined,
): { headline: string; detail?: string } {
  if (!text) return { headline: "" };
  const stripped = text.replace(/^\s*[*\-•]\s+/, "");
  const sep = stripped.search(/\s+—\s+/);
  if (sep === -1) return { headline: stripped.trim() };
  const headline = stripped.slice(0, sep).trim();
  const detail = stripped.slice(sep).replace(/^\s+—\s+/, "").trim();
  if (!headline) return { headline: detail || stripped.trim() };
  return detail ? { headline, detail } : { headline };
}

/**
 * W-INS-DEDUP · Canonical form for comparing two insight strings: drop bold
 * markers, collapse whitespace, lowercase. Used to de-duplicate the rendered
 * Key-Insights list (server mirrors this in insightHelpers.normalizeInsightText).
 */
export function normalizeInsightText(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
