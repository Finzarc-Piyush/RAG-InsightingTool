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

/** Count digit placeholders after the decimal point (before the `%`). */
function percentDecimals(numFmt: string): number {
  const beforePct = numFmt.split('%')[0] ?? '';
  const dot = beforePct.lastIndexOf('.');
  if (dot < 0) return 0;
  return (beforePct.slice(dot + 1).match(/[0#]/g) || []).length;
}

/**
 * Reproduce SheetJS `raw:false` display text for a percent-formatted number:
 * scale ×100, round to the format's decimal count, append "%". Optional
 * thousands grouping when the format groups the integer part.
 */
function formatPercentDisplay(value: number, numFmt: string): string {
  const decimals = percentDecimals(numFmt);
  const fixed = (value * 100).toFixed(decimals);
  const beforePct = numFmt.split('%')[0] ?? '';
  if (/[#0],[#0]/.test(beforePct)) {
    const neg = fixed.startsWith('-');
    const [intPart, fracPart] = (neg ? fixed.slice(1) : fixed).split('.');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${neg ? '-' : ''}${fracPart ? `${grouped}.${fracPart}` : grouped}%`;
  }
  return `${fixed}%`;
}

/** Map a resolved ExcelJS cell value to the value fileParser expects. */
function normalizeValue(v: ExcelJS.CellValue, numFmt: string | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v; // (1) dates typed
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (numFmt && numFmt.includes('%')) return formatPercentDisplay(v, numFmt); // (2)
    return v;
  }
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return normalizeValue(o.result as ExcelJS.CellValue, numFmt); // formula
    if ('error' in o) return null; // error cell → empty
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r?.text ?? '').join('');
    }
    if (typeof o.text === 'string') return o.text; // hyperlink
  }
  return null;
}

/** Header label for a cell, mirroring SheetJS key derivation. */
function headerLabel(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return cell.text ?? null;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o && o.result != null) return String(o.result);
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r?.text ?? '').join('');
    }
    if (typeof o.text === 'string') return o.text;
  }
  return cell.text || null;
}

/**
 * Build SheetJS-compatible object header keys: empty header cells become
 * `__EMPTY`/`__EMPTY_1`…; duplicate keys get `_1`/`_2`… suffixes.
 */
function buildHeaderKeys(headerCells: (string | null)[]): string[] {
  const used = new Map<string, number>();
  return headerCells.map((raw) => {
    const base = raw ?? '__EMPTY';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    if (n === 0) return base;
    // SheetJS suffixes duplicates as `key_1`, `key_2`, …
    let suffixed = `${base}_${n}`;
    while (used.has(suffixed)) suffixed = `${base}_${(used.get(base) ?? 0) + 1}`;
    used.set(suffixed, 1);
    return suffixed;
  });
}

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
}

/**
 * Read a worksheet into object-rows keyed by the header row, reproducing
 * `sheet_to_json({ raw:false, defval:null })`: first row = header, empty cells
 * → null, fully-blank rows skipped. Throws the same OOM-guard error as the
 * legacy path when the sheet exceeds `maxRows`.
 */
export async function readExcelObjectRows(
  buffer: Buffer,
  opts: { sheetName?: string; maxRows: number; onOversize: (estimatedRows: number) => never },
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

  return { sheetName, availableSheets, rows };
}
