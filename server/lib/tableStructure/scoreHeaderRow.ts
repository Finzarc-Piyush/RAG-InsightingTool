// Table-structure detection — header-likeness scoring for a candidate row
// within a column block. Pure. Combines structural signals into a 0..1 score:
//
//   + dense           a header row is fully populated
//   + text-dominant   labels are text, not numbers
//   + distinct        labels are distinct (data rows repeat / are numeric)
//   + tag signal      labels look like id/period/metric names (reuses wideFormat
//                     `tagColumn` vocabulary — the "row of column labels?" test)
//   + type contrast   the rows BELOW are numeric/date-heavy (labels→data shift)
//   - numeric penalty a numeric "header" is almost certainly a data row
//   - merge penalty   a wide merged cell over an empty block is a TITLE, not a
//                     header — drives the score negative so detection skips it

import type { CellGrid, GridCell } from './grid.js';
import { rowStatsInRange, type ColumnBlock } from './rowProfile.js';
import { tagColumn } from '../wideFormat/tagColumn.js';

export const HEADER_WEIGHTS = {
  nonEmpty: 0.2,
  text: 0.2,
  distinct: 0.15,
  tag: 0.2,
  contrast: 0.25,
  numericPenalty: 0.2,
  mergePenalty: 0.3,
};

/** Fraction of text labels in the row that tag as id/period/metric/compound,
 * weighted by tag confidence. */
function tagSignal(row: GridCell[], c0: number, c1: number): number {
  const labels: string[] = [];
  for (let c = c0; c <= c1; c++) {
    const cell = row[c];
    if (cell && cell.kind === 'text' && cell.text.trim()) labels.push(cell.text.trim());
  }
  if (!labels.length) return 0;
  let sum = 0;
  for (const l of labels) {
    const t = tagColumn(l);
    sum += t.tag === 'ambiguous' ? 0 : t.confidence;
  }
  return sum / labels.length;
}

/** Fraction of body columns whose header cell is a text label and whose cells
 * below are dominantly number/date — the "labels above, data below" shift. */
function typeContrastBelow(
  grid: CellGrid,
  h: number,
  c0: number,
  c1: number,
  kBelow = 8,
): number {
  const rEnd = Math.min(grid.length - 1, h + kBelow);
  if (rEnd <= h) return 0;
  let cols = 0;
  let contrast = 0;
  for (let c = c0; c <= c1; c++) {
    let bodyNonEmpty = 0;
    let bodyNumDate = 0;
    for (let r = h + 1; r <= rEnd; r++) {
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === 'empty') continue;
      bodyNonEmpty++;
      if (cell.kind === 'number' || cell.kind === 'date') bodyNumDate++;
    }
    if (bodyNonEmpty === 0) continue;
    cols++;
    const headerCell = grid[h]?.[c];
    // A label is any non-empty, non-numeric header cell (text OR a date/period
    // label like "Jan 2024"); a numeric "header" is almost certainly data.
    const headerIsLabel =
      !!headerCell && headerCell.kind !== 'empty' && headerCell.kind !== 'number';
    if (headerIsLabel && bodyNumDate / bodyNonEmpty >= 0.5) {
      contrast++;
    }
  }
  return cols > 0 ? contrast / cols : 0;
}

/** 1 when the row is a wide merged cell covering an (otherwise empty) block —
 * i.e. a title row, not a header. */
function mergeSpanPenalty(grid: CellGrid, h: number, c0: number, c1: number): number {
  const row = grid[h];
  if (!row) return 0;
  let nonEmpty = 0;
  let mergedCount = 0;
  for (let c = c0; c <= c1; c++) {
    const cell = row[c];
    if (!cell) continue;
    if (cell.merged) mergedCount++;
    if (cell.kind !== 'empty') nonEmpty++;
  }
  const width = c1 - c0 + 1;
  if (mergedCount >= Math.max(2, Math.ceil(width * 0.5)) && nonEmpty <= 1) return 1;
  return 0;
}

export interface HeaderScoreBreakdown {
  score: number;
  fracNonEmpty: number;
  fracText: number;
  fracDistinct: number;
  fracNumeric: number;
  tag: number;
  contrast: number;
  merge: number;
}

/** Detailed header-likeness breakdown for a candidate row over a column block. */
export function scoreHeaderRowDetailed(
  grid: CellGrid,
  h: number,
  block: ColumnBlock,
): HeaderScoreBreakdown {
  const { colStart: c0, colEnd: c1 } = block;
  const row = grid[h] ?? [];
  const stats = rowStatsInRange(row, c0, c1, h);
  const width = c1 - c0 + 1;
  const fracNonEmpty = width > 0 ? stats.nonEmpty / width : 0;
  const fracText = stats.nonEmpty > 0 ? stats.textCount / stats.nonEmpty : 0;
  const fracDistinct = stats.textCount > 0 ? stats.distinctText / stats.textCount : 0;
  const fracNumeric = stats.nonEmpty > 0 ? stats.numberCount / stats.nonEmpty : 0;
  const tag = tagSignal(row, c0, c1);
  const contrast = typeContrastBelow(grid, h, c0, c1);
  const merge = mergeSpanPenalty(grid, h, c0, c1);
  const w = HEADER_WEIGHTS;
  const raw =
    w.nonEmpty * fracNonEmpty +
    w.text * fracText +
    w.distinct * fracDistinct +
    w.tag * tag +
    w.contrast * contrast -
    w.numericPenalty * fracNumeric -
    w.mergePenalty * merge;
  return {
    score: Math.max(0, Math.min(1, raw)),
    fracNonEmpty,
    fracText,
    fracDistinct,
    fracNumeric,
    tag,
    contrast,
    merge,
  };
}

/** Header-likeness score (0..1) of candidate row `h` within `block`. */
export function scoreHeaderRow(grid: CellGrid, h: number, block: ColumnBlock): number {
  return scoreHeaderRowDetailed(grid, h, block).score;
}
