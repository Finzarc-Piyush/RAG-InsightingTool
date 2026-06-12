import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildXlsxBufferFromRows } from "../lib/xlsxWriter.js";

/**
 * Wave R6 · Parity tests for the ExcelJS single-sheet writer that replaced the
 * SheetJS (`xlsx`) `json_to_sheet` → `write` export path. Reads back with
 * ExcelJS so the test carries no `xlsx` dependency.
 */

async function readBack(buf: Buffer, sheetName = "Sheet1") {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet(sheetName);
  assert.ok(ws, `sheet "${sheetName}" should exist`);
  const header = (ws!.getRow(1).values as unknown[]).slice(1); // 1-indexed → drop [0]
  const rows: unknown[][] = [];
  for (let r = 2; r <= ws!.rowCount; r++) {
    const vals = ws!.getRow(r).values as unknown[];
    rows.push(vals.slice(1));
  }
  return { header, rows };
}

test("xlsxWriter · emits a valid ZIP/xlsx container", async () => {
  const buf = await buildXlsxBufferFromRows([{ A: 1 }]);
  assert.ok(buf.length > 0);
  assert.strictEqual(buf[0], 0x50); // P
  assert.strictEqual(buf[1], 0x4b); // K
  assert.strictEqual(buf[2], 0x03);
  assert.strictEqual(buf[3], 0x04);
});

test("xlsxWriter · header is the union of keys in first-appearance order", async () => {
  const buf = await buildXlsxBufferFromRows([
    { Region: "North", Revenue: 100 },
    { Region: "South", Revenue: 200, Note: "late column" },
  ]);
  const { header } = await readBack(buf);
  assert.deepStrictEqual(header, ["Region", "Revenue", "Note"]);
});

test("xlsxWriter · preserves native cell types (number / string / boolean / Date)", async () => {
  const when = new Date(Date.UTC(2024, 0, 15, 0, 0, 0));
  const buf = await buildXlsxBufferFromRows([
    { s: "hello", n: 42, f: 1234.5, b: true, d: when },
  ]);
  const { rows } = await readBack(buf);
  const [s, n, f, b, d] = rows[0];
  assert.strictEqual(s, "hello");
  assert.strictEqual(n, 42);
  assert.strictEqual(f, 1234.5);
  assert.strictEqual(b, true);
  assert.ok(d instanceof Date);
  assert.strictEqual((d as Date).toISOString(), when.toISOString());
});

test("xlsxWriter · null/undefined and a partial row become empty cells, not shifted columns", async () => {
  const buf = await buildXlsxBufferFromRows([
    { A: 1, B: null, C: 3 },
    { A: 4 }, // B and C absent → empty
  ]);
  const { header, rows } = await readBack(buf);
  assert.deepStrictEqual(header, ["A", "B", "C"]);
  // Row 1: A=1, B empty, C=3
  assert.strictEqual(rows[0][0], 1);
  assert.ok(rows[0][1] === undefined || rows[0][1] === null);
  assert.strictEqual(rows[0][2], 3);
  // Row 2: only A present; B & C empty (column alignment preserved)
  assert.strictEqual(rows[1][0], 4);
  assert.ok(rows[1][1] === undefined || rows[1][1] === null);
  assert.ok(rows[1][2] === undefined || rows[1][2] === null);
});

test("xlsxWriter · non-finite numbers are written as empty cells (no corrupt numeric cell)", async () => {
  const buf = await buildXlsxBufferFromRows([
    { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 7 },
  ]);
  const { rows } = await readBack(buf);
  assert.ok(rows[0][0] === undefined || rows[0][0] === null);
  assert.ok(rows[0][1] === undefined || rows[0][1] === null);
  assert.strictEqual(rows[0][2], 7);
});

test("xlsxWriter · honours a custom sheet name", async () => {
  const buf = await buildXlsxBufferFromRows([{ A: 1 }], "Pivot");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepStrictEqual(wb.worksheets.map((w) => w.name), ["Pivot"]);
});
