// Table-structure detection — public entry point.
//
// Tier-1 deterministic scoring always runs (cheap, free). The decision is:
//   - trivially-clean sheet  → return Tier-1, SKIP the LLM (byte-identical pass-through)
//   - fallback (empty sheet) → return Tier-1
//   - LLM disabled           → return Tier-1
//   - otherwise (non-trivial) → ALWAYS adjudicate with the LLM (project decision:
//                               "LLM on every messy sheet"), falling back to Tier-1
//
// Also builds a small raw-grid preview (first rows × cols) for the correction UI.

import {
  worksheetToGrid,
  matrixToGrid,
  buildRawGridPreview,
  type CellGrid,
} from './grid.js';
import { detectRegion } from './detectRegion.js';
import { adjudicateTableStructure } from './llmAdjudicate.js';
import type { TableRegion, DetectOptions } from './types.js';
import type ExcelJS from 'exceljs';

// Re-exported for callers/tests that import the preview builder from here.
export { buildRawGridPreview, RAW_PREVIEW_ROWS, RAW_PREVIEW_COLS } from './grid.js';

export interface DetectTableResult {
  region: TableRegion;
  /** First rows × cols of the RAW grid (cell display text) for the correction
   * UI — lets the user see pre-header junk and click the true header row. */
  rawGridPreview: string[][];
}

/** Run detection over a prebuilt grid. */
export async function detectTableFromGrid(
  grid: CellGrid,
  opts: DetectOptions = {},
): Promise<TableRegion> {
  const tier1 = detectRegion(grid);
  if (tier1.region.triviallyClean) return tier1.region;
  if (tier1.region.source === 'fallback') return tier1.region;
  if (!opts.llmEnabled) return tier1.region;
  return adjudicateTableStructure(grid, tier1, {
    turnId: opts.turnId,
    sheetName: opts.sheetName,
  });
}

/** Detect the main table in an ExcelJS worksheet. */
export async function detectTableFromWorksheet(
  ws: ExcelJS.Worksheet,
  opts: DetectOptions = {},
): Promise<DetectTableResult> {
  const grid = worksheetToGrid(ws, { maxScanRows: opts.maxScanRows });
  const region = await detectTableFromGrid(grid, opts);
  return { region, rawGridPreview: buildRawGridPreview(grid) };
}

/** Detect the main table in a raw CSV matrix. */
export async function detectTableFromMatrix(
  matrix: string[][],
  opts: DetectOptions = {},
): Promise<DetectTableResult> {
  const grid = matrixToGrid(matrix, opts.maxScanRows);
  const region = await detectTableFromGrid(grid, opts);
  return { region, rawGridPreview: buildRawGridPreview(grid) };
}
