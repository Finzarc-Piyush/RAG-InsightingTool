import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildFlatTableSheet,
  buildPivotWorkbook,
} from "./exportPivotToXlsx";
import type { PivotFlatRow, PivotModel } from "./types";

function minimalPivotModel(): PivotModel {
  return {
    rowFields: ["Region"],
    colField: null,
    columnFields: [],
    colKeys: [],
    valueSpecs: [{ id: "v1", field: "Sales", agg: "sum" }],
    tree: {
      nodes: [],
      grandTotal: { flatValues: { v1: 600 }, matrixValues: null },
    },
    columnFieldTruncated: false,
  };
}

function minimalFlatRows(): PivotFlatRow[] {
  return [
    {
      kind: "data",
      depth: 0,
      label: "North",
      pathKey: "North",
      values: { flatValues: { v1: 200 }, matrixValues: null },
    },
    {
      kind: "data",
      depth: 0,
      label: "South",
      pathKey: "South",
      values: { flatValues: { v1: 400 }, matrixValues: null },
    },
    {
      kind: "grand",
      depth: 0,
      label: "Grand total",
      pathKey: "__grand__",
      values: { flatValues: { v1: 600 }, matrixValues: null },
    },
  ];
}

async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buf = await wb.xlsx.writeBuffer();
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(buf as ArrayBuffer);
  return out;
}

/** Mirror the former `sheet_to_json({header:1, defval:""})`: 0-indexed dense
 *  AOA where empty cells read back as "". */
function sheetToAoa(ws: ExcelJS.Worksheet): unknown[][] {
  const out: unknown[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const vals = ws.getRow(r).values as unknown[]; // 1-indexed sparse
    const row: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = vals[c];
      row.push(v === undefined || v === null ? "" : v);
    }
    out.push(row);
  }
  return out;
}

describe("buildPivotWorkbook — two-sheet output", () => {
  it("exports two sheets when flatTableRows is non-empty", async () => {
    const flatTableRows = [
      { Region: "North", Sales: 100, Date: "2026-01-01" },
      { Region: "North", Sales: 100, Date: "2026-02-01" },
      { Region: "South", Sales: 200, Date: "2026-01-01" },
      { Region: "South", Sales: 100, Date: "2026-02-01" },
      { Region: "South", Sales: 100, Date: "2026-03-01" },
    ];

    const wb = buildPivotWorkbook(
      minimalPivotModel(),
      minimalFlatRows(),
      [],
      "raw",
      flatTableRows
    );

    const round = await roundTrip(wb);
    expect(round.worksheets.map((w) => w.name)).toEqual(["Pivot", "Flat Table"]);

    const flat = sheetToAoa(round.getWorksheet("Flat Table")!);
    // 1 header row + 5 data rows
    expect(flat.length).toBe(6);
    expect(flat[0]).toEqual(["Region", "Sales", "Date"]);
    expect(flat[1]).toEqual(["North", 100, "2026-01-01"]);
  });

  it("omits Flat Table sheet when flatTableRows is empty", async () => {
    const wb = buildPivotWorkbook(
      minimalPivotModel(),
      minimalFlatRows(),
      [],
      "raw",
      []
    );
    const round = await roundTrip(wb);
    expect(round.worksheets.map((w) => w.name)).toEqual(["Pivot"]);
  });

  it("omits Flat Table sheet when flatTableRows is undefined (backward compat)", async () => {
    const wb = buildPivotWorkbook(
      minimalPivotModel(),
      minimalFlatRows(),
      [],
      "raw"
    );
    const round = await roundTrip(wb);
    expect(round.worksheets.map((w) => w.name)).toEqual(["Pivot"]);
  });
});

describe("buildFlatTableSheet", () => {
  it("prepends note row at A1 and places header at A3 when note is provided", () => {
    const ws = buildFlatTableSheet(
      [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
      "Sample of 2000 rows. Use Download Dataset for full data."
    ).getWorksheet("Flat Table")!;
    const aoa = sheetToAoa(ws);
    expect(aoa[0]?.[0]).toBe(
      "Sample of 2000 rows. Use Download Dataset for full data."
    );
    // A2 is blank (no row), A3 is header
    expect(aoa[2]).toEqual(["a", "b"]);
    expect(aoa[3]).toEqual([1, 2]);
    expect(aoa[4]).toEqual([3, 4]);
  });

  it("heterogeneous row shapes produce union-of-keys columns with empty cells for missing keys", () => {
    const ws = buildFlatTableSheet([
      { a: 1, b: 2 },
      { a: 3, c: 4 },
    ]).getWorksheet("Flat Table")!;
    const aoa = sheetToAoa(ws);
    expect(aoa[0]).toEqual(["a", "b", "c"]);
    expect(aoa[1]).toEqual([1, 2, ""]);
    expect(aoa[2]).toEqual([3, "", 4]);
  });

  it("null and undefined cells are written as empty, not 'null' / 'undefined'", () => {
    const ws = buildFlatTableSheet([
      { a: null as unknown as number, b: undefined as unknown as number, c: 0 },
    ]).getWorksheet("Flat Table")!;
    const aoa = sheetToAoa(ws);
    expect(aoa[0]).toEqual(["a", "b", "c"]);
    expect(aoa[1]).toEqual(["", "", 0]);
  });

  it("Date cells are coerced to ISO string", () => {
    const d = new Date("2026-01-15T00:00:00.000Z");
    const ws = buildFlatTableSheet([{ when: d, value: 1 }]).getWorksheet(
      "Flat Table"
    )!;
    const aoa = sheetToAoa(ws);
    expect(aoa[1]).toEqual(["2026-01-15T00:00:00.000Z", 1]);
  });
});
