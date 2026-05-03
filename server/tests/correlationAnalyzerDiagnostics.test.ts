// W46 · `analyzeCorrelations` returns a `diagnostic` field whenever it would
// otherwise return an empty payload silently. These tests pin the three pure-
// math early-exit paths so future refactors can't reintroduce a silent fail.
//
// We don't exercise the LLM-insight or chart-generation paths here — those
// require network/LLM stubs and are covered separately by W50/W51.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Loading correlationAnalyzer pulls in openai/callLlm. The empty-correlation
// paths under test short-circuit before any LLM call — we just need the
// transitive openai module to not crash at load time.
process.env.AGENTIC_ALLOW_NO_RAG = process.env.AGENTIC_ALLOW_NO_RAG ?? "true";
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { analyzeCorrelations } = await import("../lib/correlationAnalyzer.js");

describe("analyzeCorrelations diagnostic", () => {
  it("reports `no_target_values` when the target column is absent on every row (e.g. aggregated frame)", async () => {
    // Frame shape: { bucket, Sales_sum } — looks like the leftover from a
    // run_aggregation tool call. The schema still claims "Sales" exists, but
    // no row carries that key, so toNumber→NaN for all rows.
    const aggregatedFrame = Array.from({ length: 12 }, (_, i) => ({
      bucket: `2025-${String(i + 1).padStart(2, "0")}`,
      Sales_sum: 100 + i * 10,
    }));

    const { charts, insights, diagnostic } = await analyzeCorrelations(
      aggregatedFrame,
      "Sales",
      ["Sales", "Price", "Volume"],
      "all",
      undefined,
      undefined,
      25,
      undefined,
      undefined,
      true,
      []
    );

    assert.equal(charts.length, 0);
    assert.equal(insights.length, 0);
    assert.ok(diagnostic, "diagnostic must be populated on empty result");
    assert.equal(diagnostic.reason, "no_target_values");
    assert.equal(diagnostic.targetSampleNonNan, 0);
    assert.equal(diagnostic.frameRows, 12);
    assert.equal(diagnostic.numericTried, 2); // Price, Volume (Sales is target, skipped)
    assert.equal(diagnostic.numericKept, 0);
    assert.equal(diagnostic.filter, "all");
    assert.match(diagnostic.notes ?? "", /aggregated|non-numeric/i);
  });

  it("reports `no_numeric_pairs` when the target has values but no overlap with any other numeric column", async () => {
    // Sales has values on every row, but Price/Volume are NaN paired with
    // Sales (different rows have them) → pairwise deletion empties everything.
    const data = [
      { Sales: 100, Price: null, Volume: null },
      { Sales: 200, Price: null, Volume: null },
      { Sales: 300, Price: null, Volume: null },
    ];

    const { charts, insights, diagnostic } = await analyzeCorrelations(
      data,
      "Sales",
      ["Sales", "Price", "Volume"],
      "all",
      undefined,
      undefined,
      25,
      undefined,
      undefined,
      true,
      []
    );

    assert.equal(charts.length, 0);
    assert.equal(insights.length, 0);
    assert.ok(diagnostic);
    assert.equal(diagnostic.reason, "no_numeric_pairs");
    assert.ok(diagnostic.targetSampleNonNan >= 3);
    assert.equal(diagnostic.numericTried, 2);
    assert.equal(diagnostic.numericKept, 0);
    assert.equal(diagnostic.categoricalTried, 0);
  });

  it("reports `no_categorical_signal` when only categorical cols were tried and all η returned null", async () => {
    // No numeric columns to try (only target). Categorical column has <5 rows
    // → calculateEtaSquared returns null. So everything ends up empty.
    const data = [
      { Sales: 100, Region: "North" },
      { Sales: 200, Region: "South" },
      { Sales: 300, Region: "East" },
    ];

    const { charts, insights, diagnostic } = await analyzeCorrelations(
      data,
      "Sales",
      ["Sales"], // only target — no other numeric cols
      "all",
      undefined,
      undefined,
      25,
      undefined,
      undefined,
      true,
      ["Region"]
    );

    assert.equal(charts.length, 0);
    assert.equal(insights.length, 0);
    assert.ok(diagnostic);
    assert.equal(diagnostic.reason, "no_categorical_signal");
    assert.equal(diagnostic.numericTried, 0);
    assert.equal(diagnostic.categoricalTried, 1);
    assert.equal(diagnostic.categoricalKept, 0);
  });

  it("reports `filter_eliminated_all` when correlations exist but the sign filter drops everything", async () => {
    // All correlations will be perfectly positive (Sales=Price), then we
    // filter to `negative` — drops everything. Function still returns a
    // generic insight but no charts; diagnostic must explain why.
    const data = Array.from({ length: 30 }, (_, i) => ({
      Sales: 100 + i,
      Price: 10 + i,
    }));

    const { charts, insights, diagnostic } = await analyzeCorrelations(
      data,
      "Sales",
      ["Sales", "Price"],
      "negative",
      undefined,
      undefined,
      25,
      undefined,
      undefined,
      false, // skip chart generation to keep test fast
      []
    );

    assert.equal(charts.length, 0);
    assert.equal(insights.length, 1, "expected one explanatory insight");
    assert.ok(diagnostic);
    assert.equal(diagnostic.reason, "filter_eliminated_all");
    assert.equal(diagnostic.filter, "negative");
    assert.equal(diagnostic.numericKept, 1);
  });
});
