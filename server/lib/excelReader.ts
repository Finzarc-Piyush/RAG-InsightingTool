/**
 * Wave R8 · Excel READ path (ExcelJS), replacing SheetJS (`xlsx`).
 *
 * `xlsx` carries unpatched prototype-pollution + ReDoS advisories with no
 * fix. ExcelJS is already the server's workbook engine.
 *
 * This module reproduces the cell values that the former
 *   `XLSX.utils.sheet_to_json(ws, { raw: false, defval: null })`
 * produced, then hands them to fileParser's UNCHANGED post-processing
 * (boolean canonicalisation, currency/number coercion, trimming). The net
 * value stored is byte-identical to the old path, with two deliberate,
 * signed-off exceptions:
 *
 *   1. DATES are emitted as real `Date` objects (SheetJS `raw:false` emitted a
 *      locale display string like "1/3/18"). This matches the CSV ingest path,
 *      which already yields `Date` objects via csv-parse `cast_date:true`, so
 *      the whole downstream is already built for `Date`-valued cells.
 *   2. PERCENT-formatted cells are re-stringified to their display form
 *      ("12.34%") so the unchanged post-processing coerces them to the SAME
 *      number the old path produced (parseNumeric strips `%` → 12.34). Without
 *      this, ExcelJS's underlying fraction (0.1234) would 100×-shift the value.
 *
 * Other formatted numbers (currency, thousands) pass through as their native
 * numeric value — the post-processing re-derives the identical number from the
 * old display string anyway. Display-format ROUNDING on non-percent numbers is
 * the one tolerated delta (full precision is retained instead of the rounded
 * display text); see the wave note.
 */
import ExcelJS from 'exceljs';
import { estimateExcelRowsFromRef } from './excelRowEstimate.js';
import { normalizeValue, headerLabel } from './excelCellValue.js';
import { isFlagOn } from './featureFlags.js';
import { worksheetToGrid } from './tableStructure/grid.js';
import { trimTrailingSparseRows } from './tableStructure/rowProfile.js';
import { detectTableFromGrid } from './tableStructure/detectTable.js';
import {
  buildHeaderKeys,
  buildHeaderKeysFromGrid,
  regionFromOverride,
  toTableDetection,
} from './tableStructure/applyRegion.js';
import type { TableRegion } from './tableStructure/types.js';
import type { TableDetection, TableRegionOverride } from '../shared/schema.js';

// Re-exported so existing importers keep working after the helpers moved out
// (extraction broke an excelReader↔tableStructure cycle).
export { normalizeValue, headerLabel } from './excelCellValue.js';
export { buildHeaderKeys } from './tableStructure/applyRegion.js';

async function loadFirstWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS load wants an ArrayBuffer/Buffer; a Node Buffer is accepted.
  await wb.xlsx.load(buffer);
  return wb;
}

/** Sheet names in workbook order (replaces `XLSX.read({bookSheets:true})`). */
export async function readExcelSheetNames(buffer: Buffer): Promise<string[]> {
  const wb = await loadFirstWorkbook(buffer);
  return wb.worksheets.map((w) => w.name);
}

export interface ExcelReadResult {
  sheetName: string;
  availableSheets: string[];
  rows: Record<string, unknown>[];
  /** Set when the main-table detector ran (flag on, or an override was given). */
  tableDetection?: TableDetection;
}

/** Materialize data rows for the region. Reads the worksheet directly (not the
 * scan-capped grid) so rows beyond the scan window are still ingested. When the
 * region's data clearly ENDED within the scanned window (a stacked second
 * table below), that bound is honored; otherwise extraction runs to the last row. */
function buildRowsFromRegion(
  ws: ExcelJS.Worksheet,
  region: TableRegion,
  keys: string[],
  scanRows: number,
): Record<string, unknown>[] {
  const firstDataSheetRow = region.dataRowStart + 1; // grid 0-based → sheet 1-based
  const reachedScanEnd = region.dataRowEnd >= scanRows - 1;
  const lastSheetRow = reachedScanEnd ? ws.rowCount : region.dataRowEnd + 1;
  const rows: Record<string, unknown>[] = [];
  for (let r = firstDataSheetRow; r <= lastSheetRow; r++) {
    const row = ws.getRow(r);
    const rec: Record<string, unknown> = {};
    let allEmpty = true;
    for (let c = region.colStart; c <= region.colEnd; c++) {
      const cell = row.getCell(c + 1); // grid 0-based col → sheet 1-based
      const val = normalizeValue(cell.value, cell.numFmt);
      rec[keys[c - region.colStart]!] = val;
      if (val !== null) allEmpty = false;
    }
    if (allEmpty) continue;
    rows.push(rec);
  }
  // Drop trailing stray-value rows (e.g. formula cells below the table whose
  // dimension columns are blank) so they don't become phantom null-dimension
  // buckets like a "null" Month. Reads to ws.rowCount when the scan window was
  // exhausted, so this is the gate that catches junk below row ~200.
  return trimTrailingSparseRows(rows);
}

/**
 * Read a worksheet into object-rows keyed by the header row, reproducing
 * `sheet_to_json({ raw:false, defval:null })`: first row = header, empty cells
 * → null, fully-blank rows skipped. Throws the same OOM-guard error as the
 * legacy path when the sheet exceeds `maxRows`.
 *
 * When `TABLE_STRUCTURE_DETECT_ENABLED` is on (or a `tableRegionOverride` is
 * supplied), the main-table detector first finds the real header/data bounds
 * (handling title rows, junk, side tables) and keys/iterates from THAT region.
 * A trivially-clean sheet detects to {header row 0, full width} and produces
 * byte-identical output to the legacy path.
 */
export async function readExcelObjectRows(
  buffer: Buffer,
  opts: {
    sheetName?: string;
    maxRows: number;
    onOversize: (estimatedRows: number) => never;
    tableRegionOverride?: TableRegionOverride;
    turnId?: string;
  },
): Promise<ExcelReadResult> {
  const wb = await loadFirstWorkbook(buffer);
  const availableSheets = wb.worksheets.map((w) => w.name);
  const sheetName = opts.sheetName || availableSheets[0];
  if (!sheetName) throw new Error('No sheet found in workbook');
  if (!availableSheets.includes(sheetName)) {
    throw new Error(`Selected sheet "${sheetName}" was not found in workbook`);
  }
  const ws = wb.getWorksheet(sheetName)!;

  // OOM guard — refuse oversized sheets before materialising row objects.
  const ref = ws.dimensions?.toString();
  const estimatedRows = ref ? estimateExcelRowsFromRef(ref) : ws.rowCount;
  if (estimatedRows > opts.maxRows) opts.onOversize(estimatedRows);

  const detectEnabled = isFlagOn('TABLE_STRUCTURE_DETECT_ENABLED');
  if (detectEnabled || opts.tableRegionOverride) {
    const grid = worksheetToGrid(ws);
    const colsN = grid.reduce((m, row) => Math.max(m, row.length), 0);
    let region: TableRegion;
    if (opts.tableRegionOverride) {
      region = regionFromOverride(opts.tableRegionOverride, grid.length, colsN);
    } else {
      region = await detectTableFromGrid(grid, {
        llmEnabled: true,
        turnId: opts.turnId,
        sheetName,
      });
    }
    const keys = buildHeaderKeysFromGrid(grid, region);
    const rows = buildRowsFromRegion(ws, region, keys, grid.length);
    return {
      sheetName,
      availableSheets,
      rows,
      tableDetection: toTableDetection(region, grid),
    };
  }

  // ── Legacy path (flag off, no override): header = row 1, byte-identical ──
  const headerRow = ws.getRow(1);
  const colCount = ws.columnCount;
  const headerCells: (string | null)[] = [];
  for (let c = 1; c <= colCount; c++) headerCells.push(headerLabel(headerRow.getCell(c)));
  const keys = buildHeaderKeys(headerCells);

  const rows: Record<string, unknown>[] = [];
  const lastRow = ws.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const rec: Record<string, unknown> = {};
    let allEmpty = true;
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      const val = normalizeValue(cell.value, cell.numFmt);
      rec[keys[c - 1]!] = val;
      if (val !== null) allEmpty = false;
    }
    if (allEmpty) continue; // sheet_to_json object-mode skips fully-blank rows
    rows.push(rec);
  }

  return { sheetName, availableSheets, rows: trimTrailingSparseRows(rows) };
}
