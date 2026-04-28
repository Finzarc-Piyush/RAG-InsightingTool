import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tagMarketingColumns,
  looksLikeMarketingMixDataset,
} from "../lib/marketingColumnTags.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(args: {
  numeric?: string[];
  date?: string[];
  categorical?: Array<{ name: string; topValuesCount?: number }>;
  rowCount?: number;
  numericSamples?: Record<string, Array<string | number | null>>;
}): DataSummary {
  const { numeric = [], date = [], categorical = [], rowCount = 100, numericSamples = {} } = args;
  const cols: DataSummary["columns"] = [];
  for (const n of numeric) {
    cols.push({
      name: n,
      type: "number",
      sampleValues: numericSamples[n] ?? [1000, 2000, 3000],
    });
  }
  for (const d of date) {
    cols.push({ name: d, type: "date", sampleValues: ["2024-01-01"] });
  }
  for (const c of categorical) {
    cols.push({
      name: c.name,
      type: "string",
      sampleValues: ["A", "B"],
      topValues: c.topValuesCount
        ? Array.from({ length: c.topValuesCount }, (_, i) => ({ value: `v${i}`, count: 10 }))
        : undefined,
    });
  }
  return {
    rowCount,
    columnCount: cols.length,
    columns: cols,
    numericColumns: numeric,
    dateColumns: date,
  };
}

describe("tagMarketingColumns", () => {
  it("detects wide-format spend + outcome + time", () => {
    const summary = makeSummary({
      numeric: ["TV_Spend", "Digital_Spend", "OOH_Spend", "Revenue"],
      date: ["Week"],
    });
    const t = tagMarketingColumns(summary);
    assert.deepEqual(t.spendColumns.sort(), ["Digital_Spend", "OOH_Spend", "TV_Spend"]);
    assert.equal(t.outcomeColumn, "Revenue");
    assert.equal(t.timeColumn, "Week");
    assert.equal(t.shape, "wide");
    assert.equal(t.caveats.length, 0);
    assert.equal(looksLikeMarketingMixDataset(summary), true);
  });

  it("ranks revenue/sales above clicks/impressions", () => {
    const summary = makeSummary({
      numeric: ["TV_Spend", "Digital_Spend", "Clicks", "Impressions", "Sales"],
      date: ["Date"],
    });
    const t = tagMarketingColumns(summary);
    assert.equal(t.outcomeColumn, "Sales");
    assert.ok(t.outcomeCandidates.includes("Clicks"));
    assert.ok(t.outcomeCandidates.indexOf("Sales") < t.outcomeCandidates.indexOf("Clicks"));
  });

  it("detects long-format with channel dim + single spend column", () => {
    const summary = makeSummary({
      numeric: ["spend", "revenue"],
      date: ["date"],
      categorical: [{ name: "Channel", topValuesCount: 4 }],
    });
    const t = tagMarketingColumns(summary);
    assert.equal(t.shape, "long");
    assert.equal(t.channelDimension, "Channel");
    assert.ok(t.caveats.some((c) => c.toLowerCase().includes("long-format")));
  });

  it("detects spend by channel-token + money formatting when 'spend' word missing", () => {
    const summary = makeSummary({
      numeric: ["TV", "Digital", "Print", "Revenue"],
      date: ["Week"],
      numericSamples: {
        TV: ["$1,200", "$3,400", "$5,600"],
        Digital: ["$800", "$2,200", "$4,100"],
        Print: ["$300", "$500", "$700"],
        Revenue: [10000, 12000, 15000],
      },
    });
    const t = tagMarketingColumns(summary);
    assert.deepEqual(t.spendColumns.sort(), ["Digital", "Print", "TV"]);
    assert.equal(t.outcomeColumn, "Revenue");
    assert.equal(t.shape, "wide");
  });

  it("flags caveats when spend columns are missing", () => {
    const summary = makeSummary({
      numeric: ["Revenue", "Some_Metric"],
      date: ["Date"],
    });
    const t = tagMarketingColumns(summary);
    assert.equal(t.spendColumns.length, 0);
    assert.ok(t.caveats.some((c) => c.toLowerCase().includes("no spend columns")));
    assert.equal(looksLikeMarketingMixDataset(summary), false);
  });

  it("flags caveats when no time column is present", () => {
    const summary = makeSummary({
      numeric: ["TV_Spend", "Digital_Spend", "Revenue"],
    });
    const t = tagMarketingColumns(summary);
    assert.ok(t.caveats.some((c) => c.toLowerCase().includes("no date column")));
    assert.equal(looksLikeMarketingMixDataset(summary), false);
  });

  it("does not classify a Revenue column as spend even if matched by money format", () => {
    const summary = makeSummary({
      numeric: ["TV_Spend", "Revenue"],
      date: ["Week"],
      numericSamples: { Revenue: ["$10,000", "$12,000"] },
    });
    const t = tagMarketingColumns(summary);
    assert.ok(!t.spendColumns.includes("Revenue"));
    assert.equal(t.outcomeColumn, "Revenue");
  });
});
