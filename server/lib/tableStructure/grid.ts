// Table-structure detection — the universal `CellGrid` both Excel and CSV
// reduce to. The detector never touches ExcelJS / csv-parse directly; it reasons
// over this typed grid, so every scoring function is a pure, unit-testable
// transform on literal grids.
//
// Cell-kind classification reuses the SAME value coercion the ingest pipeline
// already uses (`normalizeValue` from excelReader, `stripCurrencyAndParse`,
// `parseFlexibleDate`) so the grid's view of "this is a number / a date" matches
// what the rows will actually become after parsing.

import ExcelJS from 'exceljs';
import { normalizeValue, headerLabel } from '../excelCellValue.js';
import { stripCurrencyAndParse } from '../wideFormat/currencyVocabulary.js';
import { parseFlexibleDate } from '../dateUtils.js';

export type CellKind = 'empty' | 'text' | 'number' | 'date' | 'bool';

export interface GridCell {
  /** Normalized value (Date | number | boolean | string | null). For a merged
   * NON-anchor cell this is always null — only the anchor carries the value, so
   * a merged title spanning many columns reads as ONE populated cell, not many. */
  raw: unknown;
  /** Classified semantic type. */
  kind: CellKind;
  /** Display text. For a merged non-anchor cell this is the ANCHOR's text, so a
   * multi-row header flattener can still propagate a merged super-header label
   * across the columns it spans (while `kind` stays `empty` for profiling). */
  text: string;
  /** Part of a merged range. */
  merged: boolean;
  /** Top-left origin cell of a merged range. */
  mergeAnchor: boolean;
}

export type CellGrid = GridCell[][];

export const DEFAULT_MAX_SCAN_ROWS = 200;

/** Classify a string by attempting the same coercions the parser applies. */
export function classifyStringKind(s: string): CellKind {
  const t = s.trim();
  if (!t) return 'empty';
  const lower = t.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'yes' || lower === 'no') return 'bool';
  if (stripCurrencyAndParse(t) !== null) return 'number';
  if (parseFlexibleDate(t) != null) return 'date';
  return 'text';
}

/** Classify a normalized cell value into a `CellKind`. */
export function classifyValueKind(raw: unknown): CellKind {
  if (raw === null || raw === undefined) return 'empty';
  if (raw instanceof Date) return 'date';
  if (typeof raw === 'number') return Number.isFinite(raw) ? 'number' : 'empty';
  if (typeof raw === 'boolean') return 'bool';
  if (typeof raw === 'string') return classifyStringKind(raw);
  return 'empty';
}

function sameAddr(a: ExcelJS.Cell | undefined, b: ExcelJS.Cell): boolean {
  return !!a && a.address === b.address;
}

function textOf(cell: ExcelJS.Cell): string {
  const t = headerLabel(cell);
  if (t != null) return t;
  const ct = cell.text;
  return typeof ct === 'string' ? ct : ct == null ? '' : String(ct);
}

export interface WorksheetToGridOptions {
  maxScanRows?: number;
}

/** Build a `CellGrid` from an ExcelJS worksheet, capped at `maxScanRows`.
 * Merge-aware: only the merge anchor carries its value/kind; the rest of the
 * merged range is emitted as empty cells (carrying the anchor's text). */
export function worksheetToGrid(
  ws: ExcelJS.Worksheet,
  opts: WorksheetToGridOptions = {},
): CellGrid {
  const maxScanRows = opts.maxScanRows ?? DEFAULT_MAX_SCAN_ROWS;
  const rowN = Math.min(ws.rowCount, maxScanRows);
  const colN = ws.columnCount;
  const grid: CellGrid = [];
  for (let r = 1; r <= rowN; r++) {
    const row = ws.getRow(r);
    const cells: GridCell[] = [];
    for (let c = 1; c <= colN; c++) {
      const cell = row.getCell(c);
      const merged = cell.isMerged === true;
      const isAnchor = merged ? sameAddr(cell.master, cell) : false;
      if (merged && !isAnchor) {
        cells.push({
          raw: null,
          kind: 'empty',
          text: textOf(cell.master),
          merged: true,
          mergeAnchor: false,
        });
      } else {
        const raw = normalizeValue(cell.value, cell.numFmt);
        cells.push({
          raw,
          kind: classifyValueKind(raw),
          text: textOf(cell),
          merged,
          mergeAnchor: merged,
        });
      }
    }
    grid.push(cells);
  }
  return grid;
}

export const RAW_PREVIEW_ROWS = 30;
export const RAW_PREVIEW_COLS = 30;

/** First rows × cols of a grid's display text (cells truncated), for the
 * correction UI — lets the user see pre-header junk and pick the header row. */
export function buildRawGridPreview(
  grid: CellGrid,
  maxRows = RAW_PREVIEW_ROWS,
  maxCols = RAW_PREVIEW_COLS,
): string[][] {
  const rowsN = Math.min(grid.length, maxRows);
  let colsN = 0;
  for (let r = 0; r < rowsN; r++) colsN = Math.max(colsN, grid[r]?.length ?? 0);
  colsN = Math.min(colsN, maxCols);
  const out: string[][] = [];
  for (let r = 0; r < rowsN; r++) {
    const row: string[] = [];
    for (let c = 0; c < colsN; c++) {
      const t = grid[r]?.[c]?.text ?? '';
      row.push(t.length > 60 ? `${t.slice(0, 59)}…` : t);
    }
    out.push(row);
  }
  return out;
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/** Build a `CellGrid` from a raw CSV/tabular matrix, capped at `maxRows`. Cells
 * may be raw strings (no-cast parse) OR already-typed values (cast parse) —
 * `classifyValueKind` handles both. CSV has no merges. */
export function matrixToGrid(matrix: unknown[][], maxRows = DEFAULT_MAX_SCAN_ROWS): CellGrid {
  const rowN = Math.min(matrix.length, maxRows);
  let colN = 0;
  for (let r = 0; r < rowN; r++) colN = Math.max(colN, matrix[r]?.length ?? 0);
  const grid: CellGrid = [];
  for (let r = 0; r < rowN; r++) {
    const cells: GridCell[] = [];
    for (let c = 0; c < colN; c++) {
      const v = matrix[r]?.[c];
      const kind = classifyValueKind(v);
      cells.push({
        raw: kind === 'empty' ? null : v,
        kind,
        text: cellText(v),
        merged: false,
        mergeAnchor: false,
      });
    }
    grid.push(cells);
  }
  return grid;
}
