/**
 * Wave WQ3 · client-side detector for backtick-wrapped domain-pack citation
 * tokens in narrator prose. Pairs with the server-side W22 anti-hallucination
 * gate ([`checkEnvelopeCompleteness.ts`](../../../../server/lib/agents/runtime/checkEnvelopeCompleteness.ts))
 * — same regex, same heuristic. WQ3 reads what W22 enforces.
 *
 * Format: `` `packId` `` where packId matches `[a-z][a-z0-9-]{4,}` AND
 * contains ≥1 hyphen (the hyphen rule filters generic backtick-wrapped
 * identifiers like `Volume_MT` or `Region`). Examples:
 *   - `marico-haircare-portfolio` → citation
 *   - `kpi-and-metric-glossary` → citation
 *   - `Volume_MT` → not a citation (no hyphen)
 *   - `MT` → not a citation (too short, no hyphen)
 *
 * The MarkdownRenderer calls `extractCitations` on prose lines and replaces
 * citation segments with a Radix HoverCard wrapper ([CitationHoverCard.tsx](../components/CitationHoverCard.tsx)).
 * Pure helper, no React imports — testable via node:test.
 */

/**
 * Mirrors the server-side W22 `CITATION_TOKEN_RE` (server/lib/agents/runtime/checkEnvelopeCompleteness.ts:120).
 * Backtick-wrapped, lowercase first letter, 5+ chars total. Keep in sync.
 */
export const CITATION_TOKEN_RE = /`([a-z][a-z0-9-]{4,})`/g;

export type CitationSegment =
  | { type: "text"; value: string }
  | { type: "citation"; packId: string; raw: string };

/**
 * Tokenise a text fragment into alternating text / citation segments. Output
 * preserves all input characters: concatenating `segments.map(s => s.type
 * === "text" ? s.value : s.raw)` reproduces the input byte-for-byte (modulo
 * the regex's matching behaviour).
 *
 * Empty input → empty array. Input with no citations → single text segment.
 * Adjacent citations → consecutive citation segments with empty text
 * elided. Citation IDs without hyphens (e.g. ` `MT` ` or ` `Volume_MT` `)
 * are intentionally NOT extracted — the hyphen rule filters generic
 * code spans per W22's anti-false-positive heuristic.
 */
export function extractCitations(text: string): CitationSegment[] {
  if (!text) return [];
  const segments: CitationSegment[] = [];
  // Fresh regex per call — global regexes carry lastIndex state across calls.
  const re = new RegExp(CITATION_TOKEN_RE.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const packId = match[1];
    // Hyphen rule mirrors W22's filter — generic backtick spans without
    // hyphens (column names, acronyms) are NOT citations.
    if (!packId.includes("-")) continue;
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "citation", packId, raw: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }
  return segments;
}

/**
 * Humanise a kebab-case pack id for display in the hover-card header. Splits
 * on hyphens, title-cases each word. `marico-haircare-portfolio` →
 * `Marico Haircare Portfolio`. Strictly cosmetic — the canonical ID is
 * always shown alongside.
 */
export function formatCitationLabel(packId: string): string {
  if (!packId) return "";
  return packId
    .split("-")
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/**
 * Returns the unique citation pack IDs in a piece of text in first-occurrence
 * order. Used by AnswerCard / MessageBubble to enumerate citations without
 * having to walk the segment array twice. Pure projection over `extractCitations`.
 */
export function listCitedPackIds(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const seg of extractCitations(text)) {
    if (seg.type === "citation" && !seen.has(seg.packId)) {
      seen.add(seg.packId);
      ids.push(seg.packId);
    }
  }
  return ids;
}
