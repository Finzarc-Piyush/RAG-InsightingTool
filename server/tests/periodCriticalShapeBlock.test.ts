// Layer C · formatWideFormatShapeBlock must warn the planner that a melted
// pure_period dimension is non-additive (overlapping pre-aggregates), mirroring
// the existing compound-shape CRITICAL block.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatWideFormatShapeBlock } from "../lib/agents/runtime/context.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";

const top = (...vals: string[]) => vals.map((v, i) => ({ value: v, count: vals.length - i }));

const purePeriodTransform: WideFormatTransform = {
  detected: true,
  shape: "pure_period",
  idColumns: ["Markets", "Products"],
  meltedColumns: ["Latest 12 Mths", "YTD TY", "Q1 23"],
  periodCount: 18,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  detectedCurrencySymbol: "đ",
};

const purePeriodSummary: DataSummary = {
  rowCount: 13500,
  columnCount: 5,
  columns: [
    { name: "Products", type: "string", sampleValues: ["FEMALE SHOWER GEL"] },
    { name: "Period", type: "string", sampleValues: ["Q1 23"] },
    {
      name: "PeriodIso",
      type: "string",
      sampleValues: ["L12M", "2023-Q1"],
      topValues: top("L12M", "L12M-YA", "YTD-TY", "2023-Q1", "2025-Q4"),
    },
    {
      name: "PeriodKind",
      type: "string",
      sampleValues: ["quarter"],
      topValues: top("quarter", "latest_n", "ytd"),
    },
    { name: "Value", type: "number", sampleValues: [123] },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
  wideFormatTransform: purePeriodTransform,
};

describe("Layer C · periodCritical block (pure_period)", () => {
  it("warns that period rows are overlapping and must not be summed", () => {
    const block = formatWideFormatShapeBlock(purePeriodSummary);
    assert.match(block, /OVERLAPPING PERIOD ROWS \(pure_period shape\)/);
    assert.match(block, /NEVER SUM Value across multiple PeriodKind/);
    assert.match(block, /L12M/);
    assert.match(block, /latest 12 months.*PeriodIso="L12M"/);
  });

  it("lists the distinct PeriodKind and PeriodIso catalog values", () => {
    const block = formatWideFormatShapeBlock(purePeriodSummary);
    assert.match(block, /Distinct PeriodKind values: quarter \| latest_n \| ytd/);
    assert.match(block, /Distinct PeriodIso values:.*L12M.*2023-Q1/);
  });

  it("does NOT emit the compound-shape block for pure_period", () => {
    const block = formatWideFormatShapeBlock(purePeriodSummary);
    assert.doesNotMatch(block, /COMPOUND SHAPE/);
  });

  it("emits compoundCritical (not periodCritical) for a compound dataset", () => {
    const compoundSummary: DataSummary = {
      ...purePeriodSummary,
      columns: [
        ...purePeriodSummary.columns,
        {
          name: "Metric",
          type: "string",
          sampleValues: ["value_sales"],
          topValues: top("value_sales", "volume"),
        },
      ],
      wideFormatTransform: {
        ...purePeriodTransform,
        shape: "compound",
        metricColumn: "Metric",
      },
    };
    const block = formatWideFormatShapeBlock(compoundSummary);
    assert.match(block, /CRITICAL — COMPOUND SHAPE/);
    assert.doesNotMatch(block, /OVERLAPPING PERIOD ROWS/);
  });
});
