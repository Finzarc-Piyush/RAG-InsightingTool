import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChartSpec } from "../shared/schema.js";

// Stub Azure OpenAI env BEFORE the dynamic import so the import chain
// (insightGenerator → callLlm → openai) doesn't crash at module load when running
// outside CI. The helpers under test are pure and never touch the network.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { resolveTopPerfDimension, buildDeterministicChartInsightFallback } =
  await import("../lib/insightGenerator.js");

/**
 * Regression for: pivot chart Key Insight mislabelled a Category value (Technology) as a
 * Region. When the chart has multi-series data (seriesKeys + seriesColumn), the deterministic
 * fallback narrative — and any prompt fragment derived from `topPerfDimension` — must name
 * the SERIES dimension, not the X-axis dimension.
 */

describe("resolveTopPerfDimension", () => {
  it("returns seriesColumn when seriesKeys is non-empty", () => {
    const spec: Pick<ChartSpec, "x" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
      seriesColumn: "Category",
      seriesKeys: ["Furniture", "Office_Supplies", "Technology"],
    };
    assert.equal(resolveTopPerfDimension(spec), "Category");
  });

  it("falls back to literal 'series' when seriesKeys is set but seriesColumn is missing/empty", () => {
    const spec: Pick<ChartSpec, "x" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
      seriesColumn: "   ",
      seriesKeys: ["A", "B"],
    };
    assert.equal(resolveTopPerfDimension(spec), "series");
  });

  it("returns chartSpec.x when there are no seriesKeys", () => {
    const spec: Pick<ChartSpec, "x" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
    };
    assert.equal(resolveTopPerfDimension(spec), "Region");
  });

  it("returns chartSpec.x when seriesKeys is an empty array", () => {
    const spec: Pick<ChartSpec, "x" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
      seriesColumn: "Category",
      seriesKeys: [],
    };
    assert.equal(resolveTopPerfDimension(spec), "Region");
  });
});

describe("buildDeterministicChartInsightFallback", () => {
  // Mirrors `formatCompactNumber` in server/lib/formatCompactNumber.ts so the
  // fallback narrative produced inside the test renders thousands as "K" /
  // millions as "M" / billions as "B" — matching what runtime callers feed in.
  const formatY = (n: number): string => {
    if (!isFinite(n)) return String(n);
    const abs = Math.abs(n);
    const scale = (val: number, divisor: number, suffix: string): string => {
      const v = val / divisor;
      const av = Math.abs(v);
      const s = av >= 100 ? v.toFixed(0)
        : av >= 10 ? v.toFixed(1).replace(/\.0$/, "")
        : v.toFixed(2).replace(/\.?0+$/, "");
      return `${s}${suffix}`;
    };
    if (abs >= 1e9) return scale(n, 1e9, "B");
    if (abs >= 1e6) return scale(n, 1e6, "M");
    if (abs >= 1e3) return scale(n, 1e3, "K");
    if (abs >= 100) return n.toFixed(0);
    if (abs >= 10) return n.toFixed(1).replace(/\.0$/, "");
    if (abs >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
    return n.toFixed(3).replace(/\.?0+$/, "");
  };

  it("names the series dimension (not chartSpec.x) when ranking by series", () => {
    const chartSpec: Pick<ChartSpec, "x" | "y" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
      y: "Sales",
      seriesColumn: "Category",
      seriesKeys: ["Furniture", "Office_Supplies", "Technology"],
    };
    const fallback = buildDeterministicChartInsightFallback({
      chartSpec,
      topX: "Technology",
      topY: 827456,
      avgY: 188461,
      yP75: 224431,
      bottomThreshold: "705K",
      formatY,
    });

    assert.match(fallback, /Top Category "Technology"/);
    assert.match(fallback, /prioritize Category "Technology"/);
    assert.doesNotMatch(
      fallback,
      /Region/i,
      "fallback must not reference the X-dimension when winner is a series"
    );
  });

  it("names chartSpec.x when there are no seriesKeys", () => {
    const chartSpec: Pick<ChartSpec, "x" | "y" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
      y: "Sales",
    };
    const fallback = buildDeterministicChartInsightFallback({
      chartSpec,
      topX: "West",
      topY: 710212,
      avgY: 565382,
      yP75: 690000,
      bottomThreshold: "389K",
      formatY,
    });

    assert.match(fallback, /Top Region "West"/);
    assert.match(fallback, /prioritize Region "West"/);
    assert.doesNotMatch(fallback, /Category/i);
  });

  it("includes the formatted (K/M/B) top, avg, p75, and bottom-threshold values", () => {
    const chartSpec: Pick<ChartSpec, "x" | "y" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
      y: "Sales",
      seriesColumn: "Category",
      seriesKeys: ["Furniture", "Office_Supplies", "Technology"],
    };
    const fallback = buildDeterministicChartInsightFallback({
      chartSpec,
      topX: "Technology",
      topY: 827456,
      avgY: 188461,
      yP75: 224431,
      bottomThreshold: "705K",
      formatY,
    });

    assert.match(fallback, /827K/);
    assert.match(fallback, /188K/);
    assert.match(fallback, /224K/);
    assert.match(fallback, /705K/);
    assert.doesNotMatch(fallback, /827456|188461|224431|705415/);
  });

  it("uses the literal 'series' label when seriesColumn is missing", () => {
    const chartSpec: Pick<ChartSpec, "x" | "y" | "seriesColumn" | "seriesKeys"> = {
      x: "Region",
      y: "Sales",
      seriesKeys: ["A", "B"],
    };
    const fallback = buildDeterministicChartInsightFallback({
      chartSpec,
      topX: "A",
      topY: 100,
      avgY: 50,
      yP75: 75,
      bottomThreshold: "20",
      formatY,
    });

    assert.match(fallback, /Top series "A"/);
    assert.doesNotMatch(fallback, /Region/);
  });
});
