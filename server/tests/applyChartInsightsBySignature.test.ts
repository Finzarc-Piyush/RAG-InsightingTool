import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyChartInsightsBySignature } from "../lib/applyChartInsightsBySignature.js";
import type { ChartSpec } from "../shared/schema.js";

// Minimal chart shapes — applyChartInsightsBySignature only reads
// type/x/y/seriesColumn (for the signature) + the insight fields.
const chart = (over: Partial<ChartSpec>): ChartSpec =>
  ({ type: "bar", x: "Cluster Name", y: "pjp_adherence_rate", ...over }) as ChartSpec;

describe("applyChartInsightsBySignature", () => {
  it("copies keyInsight + businessCommentary onto a matching bare chart", () => {
    const targets = [chart({})];
    const enriched = [
      chart({ keyInsight: "Cluster 2 WEST lags at 16%.", businessCommentary: "Field gap." }),
    ];
    const { charts, patchedCount } = applyChartInsightsBySignature(targets, enriched);
    assert.equal(patchedCount, 1);
    assert.equal(charts[0].keyInsight, "Cluster 2 WEST lags at 16%.");
    assert.equal(charts[0].businessCommentary, "Field gap.");
    // New object returned, input not mutated.
    assert.notEqual(charts[0], targets[0]);
    assert.equal(targets[0].keyInsight, undefined);
  });

  it("never clobbers an insight already present on the target", () => {
    const targets = [chart({ keyInsight: "curated" })];
    const enriched = [chart({ keyInsight: "live" })];
    const { charts, patchedCount } = applyChartInsightsBySignature(targets, enriched);
    assert.equal(patchedCount, 0);
    assert.equal(charts[0].keyInsight, "curated");
    assert.equal(charts[0], targets[0]); // unchanged → same reference
  });

  it("matches by axis signature regardless of title/data differences", () => {
    const targets = [chart({ title: "pjp_adherence_rate by Cluster Name", data: [] })];
    const enriched = [chart({ title: "different title", keyInsight: "matched" })];
    const { charts } = applyChartInsightsBySignature(targets, enriched);
    assert.equal(charts[0].keyInsight, "matched");
  });

  it("leaves charts with no matching enriched signature untouched", () => {
    const targets = [chart({ x: "ASM" })];
    const enriched = [chart({ x: "Cluster Name", keyInsight: "x" })];
    const { charts, patchedCount } = applyChartInsightsBySignature(targets, enriched);
    assert.equal(patchedCount, 0);
    assert.equal(charts[0], targets[0]);
    assert.equal(charts[0].keyInsight, undefined);
  });

  it("treats whitespace-only target insight as empty and fills it", () => {
    const targets = [chart({ keyInsight: "   " })];
    const enriched = [chart({ keyInsight: "real" })];
    const { charts, patchedCount } = applyChartInsightsBySignature(targets, enriched);
    assert.equal(patchedCount, 1);
    assert.equal(charts[0].keyInsight, "real");
  });
});
