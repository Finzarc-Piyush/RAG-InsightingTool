/**
 * Wave SU-IC3 · planner-prompt block tests.
 *
 * Pin the contract: the planner sees a labelled INDICATOR COLUMNS block
 * when the dataset has indicators, the block omits cleanly when there
 * are none (no empty-block leak — same convention as TIME-OF-DAY +
 * wide-format), and the block surfaces the answersQuestions phrasings
 * so the planner can pattern-match user intent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatIndicatorColumnsBlock } from "../lib/agents/runtime/context.js";
import type { DataSummary } from "../shared/schema.js";

function indicatorSummary(): DataSummary {
  return {
    rowCount: 100,
    columnCount: 3,
    columns: [
      {
        name: "Clock-In <09:30",
        type: "text",
        sampleValues: [],
        indicator: {
          kind: "boolean",
          positiveValues: ["Yes"],
          negativeValues: ["No"],
          sentinelValues: ["Absent"],
          source: "auto",
        },
        answersQuestions: [
          "what % of staff clocked in before 9:30 am?",
          "attendance punctuality breakdown",
        ],
      },
      {
        name: "Compliance Visit",
        type: "text",
        sampleValues: [],
        indicator: {
          kind: "boolean",
          positiveValues: ["Yes"],
          negativeValues: ["No"],
          source: "auto",
        },
      },
      {
        name: "Region",
        type: "text",
        sampleValues: [],
      },
    ],
    numericColumns: [],
    dateColumns: [],
  };
}

describe("Wave SU-IC3 · formatIndicatorColumnsBlock", () => {
  it("emits the block when ≥ 1 indicator column exists", () => {
    const block = formatIndicatorColumnsBlock(indicatorSummary());
    assert.ok(block.length > 0);
    assert.match(block, /PRE-COMPUTED INDICATOR COLUMNS/);
    assert.match(block, /"Clock-In <09:30" \(boolean Yes vs No, sentinel: Absent\)/);
    assert.match(block, /"Compliance Visit" \(boolean Yes vs No\)/);
    // Region is not an indicator → must NOT appear in the block.
    assert.equal(/"Region"/.test(block), false);
  });

  it("surfaces the answersQuestions phrasings inline", () => {
    const block = formatIndicatorColumnsBlock(indicatorSummary());
    assert.match(block, /what % of staff clocked in before 9:30 am\?/);
    assert.match(block, /attendance punctuality breakdown/);
  });

  it("returns the empty string when the dataset has no indicators (no empty-block leak)", () => {
    const empty: DataSummary = {
      rowCount: 10,
      columnCount: 1,
      columns: [{ name: "Region", type: "text", sampleValues: [] }],
      numericColumns: [],
      dateColumns: [],
    };
    const block = formatIndicatorColumnsBlock(empty);
    assert.equal(block, "");
  });

  it("renders categorical indicators without inventing positive/negative", () => {
    const summary: DataSummary = {
      rowCount: 50,
      columnCount: 1,
      columns: [
        {
          name: "Compliance Status",
          type: "text",
          sampleValues: [],
          indicator: {
            kind: "categorical",
            source: "auto",
          },
        },
      ],
      numericColumns: [],
      dateColumns: [],
    };
    const block = formatIndicatorColumnsBlock(summary);
    assert.match(block, /"Compliance Status" \(categorical\)/);
  });

  it("includes the PCT1 + sentinel reminder so the planner emits the right shape", () => {
    const block = formatIndicatorColumnsBlock(indicatorSummary());
    // The PCT1 reminder + sentinel-exclusion guidance should be present
    // — these are the rules the planner must follow when picking an
    // indicator over a raw column.
    assert.match(block, /PCT1/);
    assert.match(block, /sentinel/);
  });
});
