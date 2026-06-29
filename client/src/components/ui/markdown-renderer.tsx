import React from 'react';
import { compactizeNumbersInText } from '@/lib/text/compactizeNumbersInText';
import { clampInsightDecimals } from '@/lib/cleanEvidenceNumbers';
import { extractCitations } from '@/lib/citationTokens';
import { CitationHoverCard } from '@/components/CitationHoverCard';
import { parseGfmTableBlock } from '@/lib/markdownTable';

/**
 * Simple markdown renderer for chat messages
 * Handles **bold**, *italic*, and line breaks
 * Removes orphaned asterisks that aren't part of markdown formatting
 */
export function MarkdownRenderer({ content }: { content: string }) {
  // RNK-f6 · safety net for already-persisted messages: strip stray internal
  // blackboard finding-reference tokens ([f1], [f6], …) the narrator may have
  // echoed into prose. New turns are stripped server-side; this catches history.
  const withoutFindingRefs = content.replace(/\s?\[f\d+\]/gi, "");
  // Compact large numbers (≥1000) to K/M/B/T form, then clamp any remaining
  // machine-precision decimals to ≤2 places (W-DEC1), before markdown cleanup —
  // so chat prose matches the K/M/B convention AND the "no more than two
  // decimals anywhere" rule. Order matters: compactize first (so K/M/B suffixes
  // are applied), clamp second (rounds the sub-1000 decimals it leaves behind).
  const cleanedContent = cleanOrphanedAsterisks(
    clampInsightDecimals(compactizeNumbersInText(withoutFindingRefs)),
  );

  // Split by lines to handle line breaks
  const lines = cleanedContent.split('\n');

  // Wave WQ3 · pre-walk the full content to assign stable 1-based citation
  // numbers per unique packId in first-occurrence order. Two citations of
  // the same pack get the same superscript number (e.g. both render as
  // `[1]`), so the user can correlate repeated citations visually. Done
  // once per render so the per-line passes below are O(N) lookups.
  const citationIndex = buildCitationIndex(cleanedContent);

  // Render line-by-line, but fold contiguous GFM pipe-table blocks into a real
  // <table> (the renderer otherwise has no table support, so analytical results
  // emitted as a markdown table would show as raw pipes).
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const table = parseGfmTableBlock(lines, i);
    if (table) {
      elements.push(
        <MarkdownTable
          key={`tbl-${i}`}
          header={table.header}
          rows={table.rows}
          citationIndex={citationIndex}
          baseKey={i}
        />,
      );
      i = table.nextIndex;
      continue;
    }
    const line = lines[i];
    const parts = parseMarkdownLine(line, i, citationIndex);
    const isLast = i === lines.length - 1;
    elements.push(
      <React.Fragment key={`ln-${i}`}>
        {parts}
        {!isLast && <br />}
      </React.Fragment>,
    );
    i++;
  }

  return <div className="markdown-content">{elements}</div>;
}

/** Render a parsed GFM table block as a styled <table>; cells reuse inline markdown. */
function MarkdownTable({
  header,
  rows,
  citationIndex,
  baseKey,
}: {
  header: string[];
  rows: string[][];
  citationIndex: Map<string, number>;
  baseKey: number;
}) {
  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {header.map((h, ci) => (
              <th
                key={`h-${ci}`}
                className="border border-border/60 bg-muted/40 px-2.5 py-1.5 text-left font-semibold text-foreground"
              >
                {parseMarkdownLine(h, baseKey * 100 + ci, citationIndex)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, ri) => (
            <tr key={`r-${ri}`} className="even:bg-muted/10">
              {header.map((_, ci) => (
                <td
                  key={`c-${ri}-${ci}`}
                  className="border border-border/60 px-2.5 py-1.5 align-top"
                >
                  {parseMarkdownLine(cells[ci] ?? "", baseKey * 10000 + ri * 100 + ci, citationIndex)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Wave WQ3 · build a packId → 1-based index map by walking the prose in
 * first-occurrence order. Used to assign stable superscript numbers to
 * citation hover-cards across the message. Pure projection over
 * `extractCitations`.
 */
function buildCitationIndex(content: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const seg of extractCitations(content)) {
    if (seg.type === "citation" && !map.has(seg.packId)) {
      map.set(seg.packId, map.size + 1);
    }
  }
  return map;
}

/**
 * Remove orphaned characters (asterisks and hyphens) that aren't part of markdown formatting
 * Orphaned characters are:
 * - Single * at the end of lines/sentences (not part of **bold** or *italic*)
 * - Single - at the end of lines/sentences (not part of ranges like "24.0-41.0")
 */
function cleanOrphanedAsterisks(text: string): string {
  // First, protect valid markdown patterns by replacing them with placeholders
  const placeholders: { [key: string]: string } = {};
  let placeholderCounter = 0;
  
  // Protect **bold** patterns
  let cleaned = text.replace(/\*\*(.*?)\*\*/g, (match) => {
    const key = `__BOLD_${placeholderCounter}__`;
    placeholders[key] = match;
    placeholderCounter++;
    return key;
  });
  
  // Protect *italic* patterns (but only if they're not part of **bold**)
  cleaned = cleaned.replace(/\*([^*\n]+?)\*/g, (match) => {
    const key = `__ITALIC_${placeholderCounter}__`;
    placeholders[key] = match;
    placeholderCounter++;
    return key;
  });
  
  // Protect number ranges (e.g., "24.0-41.0", "907-1258") to avoid removing valid hyphens
  cleaned = cleaned.replace(/(\d+\.?\d*)\s*-\s*(\d+\.?\d*)/g, (match) => {
    const key = `__RANGE_${placeholderCounter}__`;
    placeholders[key] = match;
    placeholderCounter++;
    return key;
  });
  
  // Now remove orphaned asterisks:
  // 1. Remove asterisks at the end of lines (with optional whitespace before)
  cleaned = cleaned.replace(/\s*\*\s*$/gm, '');
  // 2. Remove asterisks after periods/full stops
  cleaned = cleaned.replace(/\.\s*\*\s+/g, '. ');
  // 3. Remove asterisks that are standalone (surrounded by spaces or at line end)
  cleaned = cleaned.replace(/\s+\*\s+/g, ' ');
  cleaned = cleaned.replace(/\s+\*$/gm, '');
  
  // Remove orphaned hyphens:
  // 1. Remove hyphens at the end of lines (with whitespace before) - handles "text -" at end
  cleaned = cleaned.replace(/\s+-\s*$/gm, '');
  // 2. Remove hyphens after periods/full stops followed by space(s) - handles "text. -"
  cleaned = cleaned.replace(/\.\s+-\s*/g, '. ');
  // 3. Remove hyphens that appear standalone after sentences (period + space + hyphen at end)
  cleaned = cleaned.replace(/\.\s+-\s*$/gm, '.');
  // 4. Remove hyphens followed by space and newline or end of string
  cleaned = cleaned.replace(/-\s+$/gm, '');
  
  // Restore protected markdown patterns and ranges
  Object.keys(placeholders).forEach((key) => {
    cleaned = cleaned.replace(key, placeholders[key]);
  });
  
  return cleaned;
}

/**
 * Parse a line of markdown and return React nodes
 * Handles **bold** and *italic* (but prioritizes **bold** over *italic*)
 *
 * Wave WQ3 · `citationIndex` carries packId → superscript-number assignments
 * built once per render. Threaded through to `parseInlineMarkdown` so
 * citations inside bold / italic / plain spans all render as hover-cards.
 */
function parseMarkdownLine(
  line: string,
  baseKey: number,
  citationIndex: Map<string, number>,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let keyCounter = baseKey * 1000;

  // First, process bold text (**text**) - this takes priority
  const boldRegex = /\*\*(.*?)\*\*/g;
  const boldMatches: Array<{ start: number; end: number; text: string }> = [];
  let match;

  while ((match = boldRegex.exec(line)) !== null) {
    boldMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[1],
    });
  }

  // Process the line, handling bold sections and regular text
  let lastIndex = 0;

  for (const boldMatch of boldMatches) {
    // Add text before the bold
    if (boldMatch.start > lastIndex) {
      const beforeText = line.substring(lastIndex, boldMatch.start);
      if (beforeText) {
        parts.push(...parseInlineMarkdown(beforeText, keyCounter++, citationIndex));
      }
    }

    // Bold text — process citations inside the bold span too.
    parts.push(
      <strong key={keyCounter++} className="font-semibold">
        {parseInlineMarkdown(boldMatch.text, keyCounter++, citationIndex)}
      </strong>
    );

    lastIndex = boldMatch.end;
  }

  // Add remaining text after last bold
  if (lastIndex < line.length) {
    const afterText = line.substring(lastIndex);
    if (afterText) {
      parts.push(...parseInlineMarkdown(afterText, keyCounter++, citationIndex));
    }
  }

  // If no bold was found, process the whole line for italic
  if (parts.length === 0) {
    parts.push(...parseInlineMarkdown(line, keyCounter++, citationIndex));
  }

  return parts;
}

/**
 * Parse inline markdown (italic) - only processes text that's not already bold
 * Since bold (**text**) is processed first, we can safely look for single asterisks
 *
 * Wave WQ3 · after italic processing, each plain-text segment is run through
 * `renderTextWithCitations` so backtick-wrapped domain-pack IDs become
 * superscript Radix hover-cards (see [CitationHoverCard.tsx](../CitationHoverCard.tsx)).
 */
function parseInlineMarkdown(
  text: string,
  baseKey: number,
  citationIndex: Map<string, number>,
): React.ReactNode[] {
  // If text is empty, return empty array
  if (!text) {
    return [];
  }

  // If text contains **, it means there might be bold markers we missed - skip italic processing
  // (This shouldn't happen since we process bold first, but just in case)
  if (text.includes('**')) {
    return renderTextWithCitations(text, baseKey * 1000, citationIndex);
  }

  const parts: React.ReactNode[] = [];
  let keyCounter = baseKey * 1000;

  // Process italic text (*text*) - find single asterisks
  // Since we've already processed bold, remaining asterisks should be italic
  const italicRegex = /\*([^*\n]+?)\*/g;
  let lastIndex = 0;
  let match;

  while ((match = italicRegex.exec(text)) !== null) {
    // Add text before the italic — process citations on the plain span.
    if (match.index > lastIndex) {
      const beforeText = text.substring(lastIndex, match.index);
      if (beforeText) {
        parts.push(...renderTextWithCitations(beforeText, keyCounter++, citationIndex));
      }
    }

    // Italic text — also process citations inside the italic span.
    parts.push(
      <em key={keyCounter++} className="italic">
        {renderTextWithCitations(match[1], keyCounter++, citationIndex)}
      </em>
    );

    lastIndex = italicRegex.lastIndex;
  }

  // Add remaining text — process citations on the trailing plain span.
  if (lastIndex < text.length) {
    parts.push(...renderTextWithCitations(text.substring(lastIndex), keyCounter++, citationIndex));
  }

  // If no italic was found, run citation processing on the whole text.
  if (parts.length === 0) {
    return renderTextWithCitations(text, baseKey * 1000, citationIndex);
  }

  return parts;
}

/**
 * Wave WQ3 · split a plain-text fragment into alternating text spans and
 * CitationHoverCard components based on backtick-wrapped pack ids. Returns
 * the input as a single-element array when no citations are present so
 * callers can splice the result into a larger node list without special-
 * casing the empty / unchanged case.
 *
 * Lookups against `citationIndex` are O(1); the index was built once at the
 * top of `MarkdownRenderer` to ensure repeated citations of the same pack
 * get the same superscript number.
 */
function renderTextWithCitations(
  text: string,
  baseKey: number,
  citationIndex: Map<string, number>,
): React.ReactNode[] {
  if (!text) return [];
  const segments = extractCitations(text);
  if (segments.length === 0) return [text];
  // No citations present → segments is a single text segment; return raw.
  const hasCitation = segments.some((s) => s.type === "citation");
  if (!hasCitation) return [text];
  const nodes: React.ReactNode[] = [];
  let keyCounter = baseKey;
  for (const seg of segments) {
    if (seg.type === "text") {
      if (seg.value) nodes.push(seg.value);
    } else {
      const index = citationIndex.get(seg.packId) ?? 0;
      nodes.push(
        <CitationHoverCard
          key={`citation-${keyCounter++}-${seg.packId}`}
          packId={seg.packId}
          index={index}
        />
      );
    }
  }
  return nodes;
}

