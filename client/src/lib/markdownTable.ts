/**
 * Minimal GFM-table parsing for the chat MarkdownRenderer.
 *
 * The chat renderer is a custom line-based renderer (bold + line breaks); it has
 * no full markdown engine. These pure helpers detect a GFM pipe-table block
 * (header row + `---` separator row + data rows) so the renderer can render
 * quick-lookup / analytical results as a real <table> instead of raw pipes.
 * Kept dependency-free so they're unit-testable without React.
 */

/** A line shaped like `| a | b |` (requires the leading + trailing pipe). */
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;

/** Split a `| a | b |` row into trimmed cells (drops the outer pipes). */
export function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** True for a GFM separator row like `| --- | :--: |` (cells of -, :, space). */
export function isTableSeparatorRow(line: string): boolean {
  if (!TABLE_ROW_RE.test(line)) return false;
  const cells = splitTableCells(line);
  return (
    cells.length > 0 &&
    cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")))
  );
}

export interface ParsedTableBlock {
  header: string[];
  rows: string[][];
  /** Index of the first line AFTER the table block. */
  nextIndex: number;
}

/**
 * If `lines[start]` begins a GFM table (a non-separator pipe row immediately
 * followed by a separator row), parse the whole block and return it plus the
 * index to continue from. Otherwise return null.
 */
export function parseGfmTableBlock(
  lines: string[],
  start: number
): ParsedTableBlock | null {
  const headerLine = lines[start];
  const sepLine = lines[start + 1];
  if (headerLine == null || sepLine == null) return null;
  if (!TABLE_ROW_RE.test(headerLine) || isTableSeparatorRow(headerLine)) return null;
  if (!isTableSeparatorRow(sepLine)) return null;

  const header = splitTableCells(headerLine);
  const rows: string[][] = [];
  let i = start + 2;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!TABLE_ROW_RE.test(line) || isTableSeparatorRow(line)) break;
    rows.push(splitTableCells(line));
  }
  return { header, rows, nextIndex: i };
}
