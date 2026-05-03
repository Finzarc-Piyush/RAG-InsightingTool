// WPF1 · Unit tests for formatWideFormatShapeBlock — the prompt block that
// teaches the planner / narrator about a melted wide-format dataset.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatWideFormatShapeBlock,
  summarizeContextForPrompt,
} from "../lib/agents/runtime/context.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";

const baseColumns: DataSummary["columns"] = [
  { name: "Markets", type: "string", sampleValues: ["Off VN"] },
  { name: "Products", type: "string", sampleValues: ["MARICO"] },
  { name: "Period", type: "string", sampleValues: ["Q1 23"] },
  { name: "PeriodIso", type: "string", sampleValues: ["2023-Q1"] },
  { name: "PeriodKind", type: "string", sampleValues: ["quarter"] },
  {
    name: "Value",
    type: "number",
    sampleValues: [135804075023],
    currency: { symbol: "đ", isoCode: "VND", position: "prefix", confidence: 1 },
  },
];

const purePeriodTransform: WideFormatTransform = {
  detected: true,
  shape: "pure_period",
  idColumns: ["Markets", "Products"],
  meltedColumns: ["Q1 23", "Q2 23", "Q3 23", "Q4 23", "L12M-2YA", "YTD-2YA"],
  periodCount: 6,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  detectedCurrencySymbol: "đ",
};

describe("WPF1 · formatWideFormatShapeBlock", () => {
  it("returns empty string when no wide-format transform on summary", () => {
    const summary: DataSummary = {
      rowCount: 10,
      columnCount: 3,
      columns: [
        { name: "Order Date", type: "date", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [10] },
        { name: "Region", type: "string", sampleValues: ["West"] },
      ],
      numericColumns: ["Sales"],
      dateColumns: ["Order Date"],
    };
    assert.equal(formatWideFormatShapeBlock(summary), "");
  });

  it("renders the pure_period block with currency tag and melted column list", () => {
    const summary: DataSummary = {
      rowCount: 24,
      columnCount: 6,
      columns: baseColumns,
      numericColumns: ["Value"],
      dateColumns: [],
      wideFormatTransform: purePeriodTransform,
    };

    const block = formatWideFormatShapeBlock(summary);

    assert.match(block, /DATASET SHAPE — pre-melted from wide format/);
    assert.match(block, /MELTED to LONG form/);
    assert.match(block, /ID columns: Markets, Products/);
    assert.match(
      block,
      /Period \(raw human label.*"Q1 23".*\): Period/,
      "names the Period column"
    );
    assert.match(
      block,
      /PeriodIso \(CANONICAL sortable.*"2023-Q1".*\): PeriodIso/,
      "names PeriodIso and marks it canonical"
    );
    assert.match(
      block,
      /ALWAYS sort\/order time queries by this column, not Period/,
      "tells planner to sort by PeriodIso"
    );
    assert.match(
      block,
      /Value \(numeric\): Value \(VND, symbol "đ"\)/,
      "tags the Value column with VND currency"
    );
    assert.match(block, /Q1 23, Q2 23, Q3 23, Q4 23, L12M-2YA, YTD-2YA/);
    assert.doesNotMatch(
      block,
      /COMPOUND SHAPE/,
      "pure_period must not include the compound-only critical block"
    );
  });

  it("renders the compound block with Metric column + critical aggregation rule", () => {
    const compoundCols: DataSummary["columns"] = [
      ...baseColumns,
      {
        name: "Metric",
        type: "string",
        sampleValues: ["value_sales"],
        topValues: [
          { value: "value_sales", count: 12 },
          { value: "volume", count: 12 },
        ],
      },
    ];
    const compoundTransform: WideFormatTransform = {
      ...purePeriodTransform,
      shape: "compound",
      meltedColumns: [
        "Q1 23 Value Sales",
        "Q1 23 Volume",
        "Q2 23 Value Sales",
        "Q2 23 Volume",
      ],
      periodCount: 4,
      metricColumn: "Metric",
    };
    const summary: DataSummary = {
      rowCount: 16,
      columnCount: 7,
      columns: compoundCols,
      numericColumns: ["Value"],
      dateColumns: [],
      wideFormatTransform: compoundTransform,
    };

    const block = formatWideFormatShapeBlock(summary);

    assert.match(
      block,
      /Metric \(categorical, one of: value_sales \| volume\): Metric/
    );
    assert.match(block, /CRITICAL — COMPOUND SHAPE/);
    assert.match(
      block,
      /NEVER aggregate Value without filtering by Metric/
    );
    assert.match(
      block,
      /one row per id × period × metric/,
      "header line documents the compound row grain"
    );
    assert.match(
      block,
      /clarify_user/,
      "tells the planner to clarify when metric-ambiguous"
    );
    assert.match(
      block,
      /Q1 23 Value Sales, Q1 23 Volume, Q2 23 Value Sales, Q2 23 Volume/,
      "lists the original wide column names"
    );
  });

  it("truncates long melted-column lists to a sensible cap", () => {
    const many = Array.from({ length: 50 }, (_, i) => `Col_${i}`);
    const summary: DataSummary = {
      rowCount: 50,
      columnCount: 6,
      columns: baseColumns,
      numericColumns: ["Value"],
      dateColumns: [],
      wideFormatTransform: { ...purePeriodTransform, meltedColumns: many },
    };
    const block = formatWideFormatShapeBlock(summary);
    assert.match(block, /Col_0, Col_1,/);
    assert.match(block, /Col_19/);
    assert.doesNotMatch(block, /Col_25/);
    assert.match(block, /\(50 total\)/);
  });

  it("summarizeContextForPrompt includes the wide-format block when transform is present", () => {
    const summary: DataSummary = {
      rowCount: 24,
      columnCount: 6,
      columns: baseColumns,
      numericColumns: ["Value"],
      dateColumns: [],
      wideFormatTransform: purePeriodTransform,
    };
    const ctx = {
      sessionId: "s1",
      question: "value sales by Markets in Q1 23",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.match(text, /DATASET SHAPE — pre-melted from wide format/);
  });

  it("WPF6 · summarizeContextForPrompt surfaces PeriodIso on the dateColumns line", () => {
    const summary: DataSummary = {
      rowCount: 24,
      columnCount: 6,
      columns: baseColumns,
      numericColumns: ["Value"],
      dateColumns: [],
      wideFormatTransform: purePeriodTransform,
    };
    const ctx = {
      sessionId: "s1",
      question: "trend over time",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.match(
      text,
      /dateColumns:\s*PeriodIso \(canonical period — see DATASET SHAPE block\)/
    );
  });

  it("summarizeContextForPrompt omits the block when no transform present", () => {
    const summary: DataSummary = {
      rowCount: 10,
      columnCount: 3,
      columns: [
        { name: "Order Date", type: "date", sampleValues: [] },
        { name: "Sales", type: "number", sampleValues: [10] },
        { name: "Region", type: "string", sampleValues: ["West"] },
      ],
      numericColumns: ["Sales"],
      dateColumns: ["Order Date"],
    };
    const ctx = {
      sessionId: "s1",
      question: "sales by region",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.doesNotMatch(text, /DATASET SHAPE — pre-melted/);
  });
});
