/**
 * Wave R6 · Single-sheet .xlsx writer (ExcelJS).
 *
 * Replaces the former SheetJS (`xlsx`) write path —
 *   `json_to_sheet` → `book_new` → `book_append_sheet` → `write({bookType})` —
 * which carried unpatched prototype-pollution + ReDoS advisories. ExcelJS is
 * already the server's workbook engine (see `services/dashboardExport`).
 *
 * Behaviour parity with `XLSX.utils.json_to_sheet`:
 *   - Header row = the UNION of keys across all rows, in first-appearance order.
 *   - Cell values carry through their native JS type (number / string / boolean
 *     / Date); `null` and `undefined` become empty cells.
 *   - Non-finite numbers (NaN / ±Infinity) are written as empty cells rather
 *     than invalid numeric cells (SheetJS would emit a corrupt cell here).
 */
import ExcelJS from 'exceljs';

export async function buildXlsxBufferFromRows(
  rows: Record<string, unknown>[],
  sheetName = 'Sheet1',
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  // Union of keys, first-appearance order — matches json_to_sheet header logic.
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  // Assigning `.columns` with `header` populates row 1; `addRow(object)` keys by
  // `key`. We use the column name as both header and key (json_to_sheet parity).
  ws.columns = headers.map((h) => ({ header: h, key: h }));

  for (const row of rows) {
    const out: Record<string, unknown> = {};
    for (const h of headers) {
      const v = (row ?? {})[h];
      if (v === undefined || v === null) {
        out[h] = null;
      } else if (typeof v === 'number' && !Number.isFinite(v)) {
        out[h] = null;
      } else {
        out[h] = v;
      }
    }
    ws.addRow(out);
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}
