// WPF3 · Period column on a melted wide-format dataset must sort
// chronologically (via the parallel PeriodIso column), not lexicographically.
// Lexicographic sort produces "Q1 24" before "Q2 23" — wrong.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyQueryTransformations } from "../lib/dataTransform.js";
import { buildQueryPlanDuckdbSql } from "../lib/queryPlanDuckdbExecutor.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";

const transform: WideFormatTransform = {
  detected: true,
  shape: "pure_period",
  idColumns: ["Markets"],
  meltedColumns: ["Q1 23", "Q2 23", "Q3 23", "Q4 23", "Q1 24", "Q2 24"],
  periodCount: 6,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  detectedCurrencySymbol: "đ",
};

const summary: DataSummary = {
  rowCount: 6,
  columnCount: 4,
  columns: [
    { name: "Markets", type: "string", sampleValues: [] },
    { name: "Period", type: "string", sampleValues: [] },
    { name: "PeriodIso", type: "string", sampleValues: [] },
    { name: "Value", type: "number", sampleValues: [] },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
  wideFormatTransform: transform,
};

describe("WPF3 · applyQueryTransformations sorts Period chronologically via PeriodIso", () => {
  it("orders Period rows by PeriodIso, not lexicographically", () => {
    const rows = [
      { Markets: "Off VN", Period: "Q1 24", PeriodIso: "2024-Q1", Value: 5 },
      { Markets: "Off VN", Period: "Q2 23", PeriodIso: "2023-Q2", Value: 2 },
      { Markets: "Off VN", Period: "Q1 23", PeriodIso: "2023-Q1", Value: 1 },
      { Markets: "Off VN", Period: "Q2 24", PeriodIso: "2024-Q2", Value: 6 },
      { Markets: "Off VN", Period: "Q4 23", PeriodIso: "2023-Q4", Value: 4 },
      { Markets: "Off VN", Period: "Q3 23", PeriodIso: "2023-Q3", Value: 3 },
    ];

    const parsed: ParsedQuery = {
      sort: [{ column: "Period", direction: "asc" }],
    } as unknown as ParsedQuery;

    const { data: out } = applyQueryTransformations(rows, summary, parsed);
    assert.deepEqual(
      out.map((r) => r.Period),
      ["Q1 23", "Q2 23", "Q3 23", "Q4 23", "Q1 24", "Q2 24"]
    );
  });

  it("falls back to raw column when ISO is missing on the row", () => {
    const rows = [
      { Markets: "Off VN", Period: "Q1 24", Value: 5 },
      { Markets: "Off VN", Period: "Q2 23", Value: 2 },
      { Markets: "Off VN", Period: "Q1 23", Value: 1 },
    ];
    const parsed: ParsedQuery = {
      sort: [{ column: "Period", direction: "asc" }],
    } as unknown as ParsedQuery;

    // Without PeriodIso on the rows, the remap silently degrades to the raw
    // column (so behavior stays defined; result will be lexicographic).
    const { data: out } = applyQueryTransformations(rows, summary, parsed);
    // We don't assert the exact order here — only that it didn't throw and
    // returned the expected number of rows.
    assert.equal(out.length, 3);
  });

  it("does not interfere with non-Period sort columns", () => {
    const rows = [
      { Markets: "B", Period: "Q1 23", PeriodIso: "2023-Q1", Value: 5 },
      { Markets: "A", Period: "Q1 23", PeriodIso: "2023-Q1", Value: 2 },
    ];
    const parsed: ParsedQuery = {
      sort: [{ column: "Markets", direction: "asc" }],
    } as unknown as ParsedQuery;

    const { data: out } = applyQueryTransformations(rows, summary, parsed);
    assert.deepEqual(out.map((r) => r.Markets), ["A", "B"]);
  });

  it("does not remap when no wideFormatTransform is set", () => {
    const noWfSummary: DataSummary = {
      ...summary,
      wideFormatTransform: undefined,
    };
    const rows = [
      { Markets: "Off VN", Period: "Q1 24", Value: 5 },
      { Markets: "Off VN", Period: "Q1 23", Value: 1 },
    ];
    const parsed: ParsedQuery = {
      sort: [{ column: "Period", direction: "asc" }],
    } as unknown as ParsedQuery;
    const { data: out } = applyQueryTransformations(rows, noWfSummary, parsed);
    // Lexicographic: "Q1 23" < "Q1 24" (digits 23 < 24) — same result by luck,
    // but assert the system doesn't crash without the transform.
    assert.equal(out.length, 2);
  });
});

describe("WPF3 · buildQueryPlanDuckdbSql adds hidden PeriodIso ordering", () => {
  it("adds PeriodIso to SELECT/GROUP BY/ORDER BY when groupBy includes Period", () => {
    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Period"],
        aggregations: [{ column: "Value", operation: "sum" }],
      },
      {
        tableColumns: new Set(["Markets", "Period", "PeriodIso", "PeriodKind", "Value"]),
        summary,
      }
    );
    assert.ok(built);
    assert.match(built!.aggregateSql, /"PeriodIso" AS "PeriodIso"/);
    assert.match(built!.aggregateSql, /GROUP BY "Period", "PeriodIso"/);
    assert.match(built!.aggregateSql, /ORDER BY "PeriodIso" ASC/);
    assert.deepEqual(built!.hiddenColumns, ["PeriodIso"]);
  });

  it("rewrites explicit Period sort to PeriodIso (chronological)", () => {
    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Period"],
        aggregations: [{ column: "Value", operation: "sum" }],
        sort: [{ column: "Period", direction: "desc" }],
      },
      {
        tableColumns: new Set(["Markets", "Period", "PeriodIso", "PeriodKind", "Value"]),
        summary,
      }
    );
    assert.ok(built);
    // Explicit DESC sort on Period → ORDER BY "PeriodIso" DESC and no
    // duplicate ASC (since explicit handled the period column).
    assert.match(built!.aggregateSql, /ORDER BY "PeriodIso" DESC/);
    assert.doesNotMatch(built!.aggregateSql, /"PeriodIso" ASC/);
  });

  it("does not add hidden column when groupBy does not include Period", () => {
    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Markets"],
        aggregations: [{ column: "Value", operation: "sum" }],
      },
      {
        tableColumns: new Set(["Markets", "Period", "PeriodIso", "Value"]),
        summary,
      }
    );
    assert.ok(built);
    assert.equal(built!.hiddenColumns, undefined);
    assert.doesNotMatch(built!.aggregateSql, /"PeriodIso"/);
  });

  it("does not add hidden column when wideFormatTransform is missing", () => {
    const noWfSummary: DataSummary = {
      ...summary,
      wideFormatTransform: undefined,
    };
    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Period"],
        aggregations: [{ column: "Value", operation: "sum" }],
      },
      {
        tableColumns: new Set(["Markets", "Period", "PeriodIso", "Value"]),
        summary: noWfSummary,
      }
    );
    assert.ok(built);
    assert.equal(built!.hiddenColumns, undefined);
  });

  it("does not add hidden column when groupBy already includes PeriodIso", () => {
    const built = buildQueryPlanDuckdbSql(
      {
        groupBy: ["Period", "PeriodIso"],
        aggregations: [{ column: "Value", operation: "sum" }],
      },
      {
        tableColumns: new Set(["Markets", "Period", "PeriodIso", "Value"]),
        summary,
      }
    );
    assert.ok(built);
    assert.equal(
      built!.hiddenColumns,
      undefined,
      "PeriodIso explicitly grouped → don't hide it"
    );
  });
});
