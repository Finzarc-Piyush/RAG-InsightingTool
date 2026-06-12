import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import { parseFile, getExcelSheetNames } from "../lib/fileParser.js";
import { readExcelObjectRows } from "../lib/excelReader.js";

/**
 * Wave R8 · pin the ExcelJS read path (replacing SheetJS `xlsx`). Fixtures are
 * built with ExcelJS so the suite carries no `xlsx` dependency. Asserts the
 * net stored values are byte-identical to the old `sheet_to_json({raw:false,
 * defval:null})` path, with two signed-off deltas: dates → real `Date`
 * objects, and percent-formatted cells coerced to the SAME number as before.
 */

/** Build a single-sheet workbook exercising every cell kind. */
async function richFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data");
  ws.addRow(["str", "int", "float", "pct2", "pct0", "curr", "date", "datetime", "bt", "bf", "empty", "formula"]);
  const setRow = (
    rowIdx: number,
    s: string,
    int: number,
    flt: number,
    pct: number,
    curr: number,
    date: Date,
    datetime: Date,
    bt: boolean,
    bf: boolean,
    formula: number,
  ) => {
    const r = ws.getRow(rowIdx);
    r.getCell(1).value = s;
    r.getCell(2).value = int;
    r.getCell(3).value = flt;
    r.getCell(4).value = pct; r.getCell(4).numFmt = "0.00%";
    r.getCell(5).value = pct; r.getCell(5).numFmt = "0%";
    r.getCell(6).value = curr; r.getCell(6).numFmt = "$#,##0.00";
    r.getCell(7).value = date;
    r.getCell(8).value = datetime;
    r.getCell(9).value = bt;
    r.getCell(10).value = bf;
    // col 11 (empty) intentionally unset
    r.getCell(12).value = { formula: "B2-C2", result: formula } as ExcelJS.CellValue;
    r.commit();
  };
  setRow(2, "hello", 42, 1234.5, 0.1234, 99.5, new Date(Date.UTC(2018, 0, 3)), new Date(Date.UTC(2018, 0, 3, 12, 0)), true, false, 30);
  setRow(3, "world", 7, 8.25, 0.5, 12.0, new Date(Date.UTC(2018, 0, 4)), new Date(Date.UTC(2018, 0, 4, 6, 0)), false, true, 31);
  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

describe("Wave R8 · ExcelJS read path parity", () => {
  it("parseFile maps every cell kind exactly as the old xlsx path (dates → Date)", async () => {
    const rows = await parseFile(await richFixture(), "fixture.xlsx");
    assert.equal(rows.length, 2);
    const [a, b] = rows;

    // Strings / native numbers pass through.
    assert.equal(a.str, "hello");
    assert.equal(a.int, 42);
    assert.equal(a.float, 1234.5);

    // Percent: 0.1234 with "0.00%" → "12.34%" → parseNumeric strips % → 12.34
    // (identical to the old SheetJS path). "0%" rounds to whole → 12.
    assert.equal(a.pct2, 12.34);
    assert.equal(a.pct0, 12);
    assert.equal(b.pct2, 50);
    assert.equal(b.pct0, 50);

    // Currency: ExcelJS yields the underlying number; old path stripped "$".
    assert.equal(a.curr, 99.5);
    assert.equal(b.curr, 12);

    // Booleans canonicalised to Yes/No.
    assert.equal(a.bt, "Yes");
    assert.equal(a.bf, "No");
    assert.equal(b.bt, "No");
    assert.equal(b.bf, "Yes");

    // Formula → cached result.
    assert.equal(a.formula, 30);
    assert.equal(b.formula, 31);

    // Empty cell → null.
    assert.equal(a.empty, null);

    // Dates are real Date objects at the exact UTC instant (signed-off delta).
    assert.ok(a.date instanceof Date);
    assert.equal((a.date as Date).toISOString(), "2018-01-03T00:00:00.000Z");
    assert.ok(a.datetime instanceof Date);
    assert.equal((a.datetime as Date).toISOString(), "2018-01-03T12:00:00.000Z");
    assert.equal((b.date as Date).toISOString(), "2018-01-04T00:00:00.000Z");
  });

  it("getExcelSheetNames returns sheet names in workbook order", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Alpha");
    wb.addWorksheet("Beta");
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    assert.deepEqual(await getExcelSheetNames(buf), ["Alpha", "Beta"]);
  });

  it("readExcelObjectRows honours the sheet selection and skips fully-blank rows", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("First");
    const ws2 = wb.addWorksheet("Second");
    ws2.addRow(["A", "B"]);
    ws2.addRow([1, 2]);
    ws2.addRow([]); // fully blank → skipped
    ws2.addRow([3, 4]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const { sheetName, rows } = await readExcelObjectRows(buf, {
      sheetName: "Second",
      maxRows: 1000,
      onOversize: () => {
        throw new Error("should not fire");
      },
    });
    assert.equal(sheetName, "Second");
    assert.deepEqual(rows, [
      { A: 1, B: 2 },
      { A: 3, B: 4 },
    ]);
  });

  it("readExcelObjectRows fires the OOM guard above maxRows", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Big");
    ws.addRow(["A"]);
    ws.addRow([1]);
    ws.addRow([2]);
    ws.addRow([3]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await assert.rejects(
      readExcelObjectRows(buf, {
        maxRows: 1,
        onOversize: (n): never => {
          throw new Error(`too big: ${n}`);
        },
      }),
      /too big:/,
    );
  });
});
