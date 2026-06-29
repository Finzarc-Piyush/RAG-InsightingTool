import React from 'react';
import { clampInsightDecimals } from '@/lib/cleanEvidenceNumbers';

/**
 * W-BOLD1 · Shared inline rich-text renderer for analytical INSIGHT surfaces:
 * the chat answer card (TL;DR, findings, drivers, implications, recommendations),
 * the Key-Insights panel, and the chart-insight Why/Do lanes.
 *
 * Returns inline React nodes — NO block wrapper — so it drops into <p>, flex
 * rows, and pills without disturbing layout. Two responsibilities, in order:
 *   1. clamp machine-precision decimals to ≤2 places (W-DEC1);
 *   2. render the markdown **bold** the LLM emits around every data-derived
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
  return cleanOrphanedAsterisks(clampInsightDecimals(text)).replace(/\*\*/g, "");
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
  const cleaned = cleanOrphanedAsterisks(clampInsightDecimals(text));
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
