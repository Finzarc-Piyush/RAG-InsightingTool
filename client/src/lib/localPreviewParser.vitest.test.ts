import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseLocalPreview, inspectLocalWorkbookSheets } from "./localPreviewParser";

/**
 * Wave R9 · pin the ExcelJS-backed local preview parser (replacing SheetJS
 * `xlsx`). Fixtures built with ExcelJS, so no `xlsx` dependency. Preview is
 * string-heuristic based, so dates render as ISO strings (recognised by the
 * date heuristic) while percents stay non-numeric exactly as before.
 */
async function xlsxFile(
  build: (wb: ExcelJS.Workbook) => void,
  name = "fixture.xlsx"
): Promise<File> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("Wave R9 · localPreviewParser (ExcelJS)", () => {
  it("maps cells and infers column types as the old xlsx path did", async () => {
    const file = await xlsxFile((wb) => {
      const ws = wb.addWorksheet("Data");
      ws.addRow(["name", "qty", "share", "when", "flag"]);
      const rows: Array<[string, number, number, Date, boolean]> = [
        ["Alice", 10, 0.1234, new Date(Date.UTC(2024, 0, 15)), true],
        ["Bob", 20, 0.5, new Date(Date.UTC(2024, 1, 20)), false],
        ["Cara", 30, 0.075, new Date(Date.UTC(2024, 2, 25)), true],
      ];
      for (const [name, qty, share, when, flag] of rows) {
        const r = ws.addRow([name, qty, share, when, flag]);
        r.getCell(3).numFmt = "0.00%";
        r.commit();
      }
    });

    const res = await parseLocalPreview(file);
    expect(res.parseStatus).toBe("full");
    expect(res.rows).toHaveLength(3);

    // Cell values.
    expect(res.rows[0].name).toBe("Alice");
    expect(res.rows[0].qty).toBe(10);
    expect(res.rows[0].share).toBe("12.34%"); // percent preserved as text
    expect(res.rows[0].when).toBe("2024-01-15"); // date → ISO string
    expect(res.rows[0].flag).toBe("TRUE");
    expect(res.rows[1].share).toBe("50.00%");

    // Type inference: qty numeric; share NOT numeric (stays text); when date.
    expect(res.numericColumns).toContain("qty");
    expect(res.numericColumns).not.toContain("share");
    expect(res.dateColumns).toContain("when");
  });

  it("lists sheet names and flags multi-sheet workbooks for selection", async () => {
    const file = await xlsxFile((wb) => {
      wb.addWorksheet("Alpha").addRow(["a"]);
      wb.addWorksheet("Beta").addRow(["b"]);
    });
    const info = await inspectLocalWorkbookSheets(file);
    expect(info.sheetNames).toEqual(["Alpha", "Beta"]);
    expect(info.requiresSelection).toBe(true);
    expect(info.selectedSheetName).toBe("Alpha");
  });

  it("honours an explicit sheet selection and skips fully-blank rows", async () => {
    const file = await xlsxFile((wb) => {
      wb.addWorksheet("First").addRow(["x"]);
      const ws = wb.addWorksheet("Second");
      ws.addRow(["k", "v"]);
      ws.addRow(["a", 1]);
      ws.addRow([]); // blank → skipped
      ws.addRow(["b", 2]);
    });
    const res = await parseLocalPreview(file, { sheetName: "Second" });
    expect(res.columns).toEqual(["k", "v"]);
    expect(res.rows).toEqual([
      { k: "a", v: 1 },
      { k: "b", v: 2 },
    ]);
  });
});
