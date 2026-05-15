import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
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

function roundTrip(wb: XLSX.WorkBook): XLSX.WorkBook {
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return XLSX.read(buf, { type: "array" });
}

function sheetToAoa(ws: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
}

describe("buildPivotWorkbook — two-sheet output", () => {
  it("exports two sheets when flatTableRows is non-empty", () => {
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

    const round = roundTrip(wb);
    expect(round.SheetNames).toEqual(["Pivot", "Flat Table"]);

    const flat = sheetToAoa(round.Sheets["Flat Table"]!);
    // 1 header row + 5 data rows
    expect(flat.length).toBe(6);
    expect(flat[0]).toEqual(["Region", "Sales", "Date"]);
    expect(flat[1]).toEqual(["North", 100, "2026-01-01"]);
  });

  it("omits Flat Table sheet when flatTableRows is empty", () => {
    const wb = buildPivotWorkbook(
      minimalPivotModel(),
      minimalFlatRows(),
      [],
      "raw",
      []
    );
    const round = roundTrip(wb);
    expect(round.SheetNames).toEqual(["Pivot"]);
  });

  it("omits Flat Table sheet when flatTableRows is undefined (backward compat)", () => {
    const wb = buildPivotWorkbook(
      minimalPivotModel(),
      minimalFlatRows(),
      [],
      "raw"
    );
    const round = roundTrip(wb);
    expect(round.SheetNames).toEqual(["Pivot"]);
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
    );
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
    ]);
    const aoa = sheetToAoa(ws);
    expect(aoa[0]).toEqual(["a", "b", "c"]);
    expect(aoa[1]).toEqual([1, 2, ""]);
    expect(aoa[2]).toEqual([3, "", 4]);
  });

  it("null and undefined cells are written as empty, not 'null' / 'undefined'", () => {
    const ws = buildFlatTableSheet([
      { a: null as unknown as number, b: undefined as unknown as number, c: 0 },
    ]);
    const aoa = sheetToAoa(ws);
    expect(aoa[0]).toEqual(["a", "b", "c"]);
    expect(aoa[1]).toEqual(["", "", 0]);
  });

  it("Date cells are coerced to ISO string", () => {
    const d = new Date("2026-01-15T00:00:00.000Z");
    const ws = buildFlatTableSheet([{ when: d, value: 1 }]);
    const aoa = sheetToAoa(ws);
    expect(aoa[1]).toEqual(["2026-01-15T00:00:00.000Z", 1]);
  });
});
