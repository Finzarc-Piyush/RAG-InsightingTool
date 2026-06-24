import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Stub Azure env BEFORE the dynamic import so the import chain
// (generateInsightForCharts → insightGenerator → callLlm → openai) doesn't crash
// at module load. Every case below is OFFLINE by construction: the idempotent
// path skips generation entirely, and the generation cases use empty data so
// `generateChartInsights` early-returns its deterministic no-data message
// without ever reaching the network.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { generateInsightForCharts, enrichChartWithInsight } = await import(
  "../lib/generateInsightForCharts.js"
);

const baseDeps = {
  filteredRawData: [] as Record<string, unknown>[],
  dataSummary: { rowCount: 0 } as any,
};

// A chart whose rows resolve to [] deterministically (no embedded data,
// `_useAnalyticalDataOnly` with no fallback rows → resolver returns []), so the
// engine's no-data early-return fires instead of an LLM call.
const noDataChart = (overrides: Record<string, unknown> = {}) => ({
  type: "bar",
  title: "Empty",
  x: "Region",
  y: "Sales",
  _useAnalyticalDataOnly: true,
  ...overrides,
});

describe("generateInsightForCharts — idempotency (the load-bearing contract)", () => {
  it("passes a chart with a usable keyInsight through untouched (no regeneration)", async () => {
    const chart = {
      type: "bar",
      title: "T",
      x: "Region",
      y: "Sales",
      keyInsight: "Pre-seeded insight that must survive untouched.",
      data: [{ Region: "West", Sales: 10 }],
    };
    const [out] = await generateInsightForCharts([chart], baseDeps);
    assert.equal(out.keyInsight, "Pre-seeded insight that must survive untouched.");
    // Embedded data is preserved (resolver returns the chart's own rows).
    assert.deepEqual(out.data, [{ Region: "West", Sales: 10 }]);
  });

  it("treats a whitespace-only keyInsight as missing (regenerates)", async () => {
    const [out] = await generateInsightForCharts([noDataChart({ keyInsight: "   " })], baseDeps);
    assert.equal(out.keyInsight, "No data available for analysis");
  });
});

describe("generateInsightForCharts — generation gate fills missing insights (offline)", () => {
  it("fills keyInsight from the engine when missing", async () => {
    const [out] = await generateInsightForCharts([noDataChart()], baseDeps);
    assert.equal(out.keyInsight, "No data available for analysis");
  });
});

describe("generateInsightForCharts — attachData controls the data spread", () => {
  it("does NOT attach resolved rows when attachData is false (insight-only)", async () => {
    // No embedded `data`; with attachData:false the resolved rows are used to
    // compute the insight but are NOT spread onto the output.
    const chart = {
      type: "bar",
      title: "T",
      x: "Region",
      y: "Sales",
      keyInsight: "ok",
      _useAnalyticalDataOnly: true,
    };
    const out = await enrichChartWithInsight(chart, { ...baseDeps, attachData: false });
    assert.equal(out.keyInsight, "ok");
    assert.equal("data" in out, false);
  });

  it("preserves a chart's existing frozen data when attachData is false", async () => {
    // Dashboard charts carry frozen inline data — attachData:false must keep it,
    // not strip it (we only add the insight).
    const chart = {
      type: "bar",
      title: "T",
      x: "Region",
      y: "Sales",
      keyInsight: "ok",
      data: [{ Region: "W", Sales: 1 }],
    };
    const out = await enrichChartWithInsight(chart, { ...baseDeps, attachData: false });
    assert.deepEqual(out.data, [{ Region: "W", Sales: 1 }]);
  });

  it("attaches resolved data by default (chat pipeline behavior)", async () => {
    const chart = {
      type: "bar",
      title: "T",
      x: "Region",
      y: "Sales",
      keyInsight: "ok",
      data: [{ Region: "W", Sales: 1 }],
    };
    const out = await enrichChartWithInsight(chart, baseDeps);
    assert.equal(Array.isArray(out.data), true);
  });
});

describe("generateInsightForCharts — batch robustness", () => {
  it("isolates a per-chart failure and preserves the rest of the batch", async () => {
    const good = {
      type: "bar",
      title: "Good",
      x: "Region",
      y: "Sales",
      keyInsight: "ok",
      data: [{ Region: "W", Sales: 1 }],
    };
    const results = await generateInsightForCharts([good, null as any], baseDeps);
    assert.equal(results.length, 2);
    assert.equal(results[0].keyInsight, "ok");
    assert.equal(results[1], null);
  });

  it("returns [] for non-array input", async () => {
    assert.deepEqual(await generateInsightForCharts(undefined as any, baseDeps), []);
    assert.deepEqual(await generateInsightForCharts(null as any, baseDeps), []);
  });
});
