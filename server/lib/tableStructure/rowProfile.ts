// Table-structure detection — per-row and per-column profiling, plus
// column-block (gap) detection. All pure functions over a `CellGrid`.
//
// These profiles are the raw signal the header scorer (TS3) and the Tier-1
// orchestrator (TS4) combine: a header row is dense + text-dominant + distinct
// labels with a type-stable numeric/date body beneath it; a side table is a
// separate dense column block beyond an empty-column gap.

import type { CellGrid, GridCell, CellKind } from './grid.js';

export interface RowProfile {
  index: number;
  nonEmpty: number;
  /** nonEmpty / width of the scanned column range. */
  density: number;
  textCount: number;
  numberCount: number;
  dateCount: number;
  boolCount: number;
  /** Most common non-empty kind in the row ('empty' if the row is blank). */
  dominantKind: CellKind;
  /** Distinct non-empty text values (headers are distinct labels). */
  distinctText: number;
  /** First / last non-empty column index in range, or -1 when blank. */
  leftEdge: number;
  rightEdge: number;
}

export interface ColProfile {
  index: number;
  nonEmpty: number;
  density: number;
  dominantKind: CellKind;
  /** Fraction of non-empty cells matching dominantKind (1 = perfectly typed). */
  typeStability: number;
}

export interface ColumnBlock {
  colStart: number;
  colEnd: number;
}

/** Widest row width across the grid. */
export function gridColCount(grid: CellGrid): number {
  return grid.reduce((m, row) => Math.max(m, row.length), 0);
}

type KindCounts = { text: number; number: number; date: number; bool: number };

function dominantKind(counts: KindCounts): CellKind {
  let best: CellKind = 'empty';
  let bestN = 0;
  for (const k of ['text', 'number', 'date', 'bool'] as const) {
    if (counts[k] > bestN) {
      bestN = counts[k];
      best = k;
    }
  }
  return best;
}

/** Profile a single row over the inclusive column range [c0, c1]. */
export function rowStatsInRange(row: GridCell[], c0: number, c1: number, index = 0): RowProfile {
  let nonEmpty = 0;
  let leftEdge = -1;
  let rightEdge = -1;
  const counts: KindCounts = { text: 0, number: 0, date: 0, bool: 0 };
  const texts = new Set<string>();
  for (let c = c0; c <= c1; c++) {
    const cell = row[c];
    if (!cell || cell.kind === 'empty') continue;
    nonEmpty++;
    if (leftEdge < 0) leftEdge = c;
    rightEdge = c;
    counts[cell.kind]++;
    if (cell.kind === 'text') texts.add(cell.text.trim().toLowerCase());
  }
  const width = c1 - c0 + 1;
  return {
    index,
    nonEmpty,
    density: width > 0 ? nonEmpty / width : 0,
    textCount: counts.text,
    numberCount: counts.number,
    dateCount: counts.date,
    boolCount: counts.bool,
    dominantKind: dominantKind(counts),
    distinctText: texts.size,
    leftEdge,
    rightEdge,
  };
}

/** Per-row profiles across the full grid width. */
export function profileRows(grid: CellGrid): RowProfile[] {
  const cols = gridColCount(grid);
  return grid.map((row, index) => rowStatsInRange(row, 0, cols - 1, index));
}

/** Per-column profiles over an inclusive row range (default: whole grid). */
export function profileCols(grid: CellGrid, rowStart = 0, rowEnd?: number): ColProfile[] {
  const cols = gridColCount(grid);
  const rEnd = rowEnd ?? grid.length - 1;
  const out: ColProfile[] = [];
  for (let c = 0; c < cols; c++) {
    let nonEmpty = 0;
    const counts: KindCounts = { text: 0, number: 0, date: 0, bool: 0 };
    for (let r = rowStart; r <= rEnd; r++) {
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === 'empty') continue;
      nonEmpty++;
      counts[cell.kind]++;
    }
    const rows = rEnd - rowStart + 1;
    const dom = dominantKind(counts);
    const domCount = dom === 'empty' ? 0 : counts[dom];
    out.push({
      index: c,
      nonEmpty,
      density: rows > 0 ? nonEmpty / rows : 0,
      dominantKind: dom,
      typeStability: nonEmpty > 0 ? domCount / nonEmpty : 0,
    });
  }
  return out;
}

/** Index of the rightmost column that holds any data (trailing fully-empty
 * columns don't count — so a clean sheet with blank tail columns is still
 * "full width"). Returns -1 for an empty grid. */
export function lastNonEmptyColumn(grid: CellGrid): number {
  const cols = profileCols(grid);
  for (let c = cols.length - 1; c >= 0; c--) if (cols[c]!.density > 0) return c;
  return cols.length - 1;
}

// Only a COMPLETELY empty column separates two table blocks. A merely sparse
// column (an optional/notes field filled in a few rows) must stay part of its
// table — otherwise a real table with a sparse column is wrongly split, and a
// clean sheet looks like it has a "side table". A genuine side/lookup table is
// separated by a truly blank column.
export const GAP_DENSITY_FLOOR = 0;

/** Split columns into contiguous runs separated by fully-empty columns. This is
 * what isolates a main table from a gap-separated side/lookup table. */
export function columnBlocks(grid: CellGrid, floor = GAP_DENSITY_FLOOR): ColumnBlock[] {
  const cols = profileCols(grid);
  const blocks: ColumnBlock[] = [];
  let start = -1;
  for (let c = 0; c < cols.length; c++) {
    const dense = cols[c]!.density > floor;
    if (dense && start < 0) start = c;
    if (!dense && start >= 0) {
      blocks.push({ colStart: start, colEnd: c - 1 });
      start = -1;
    }
  }
  if (start >= 0) blocks.push({ colStart: start, colEnd: cols.length - 1 });
  return blocks;
}
