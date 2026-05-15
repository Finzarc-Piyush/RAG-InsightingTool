import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripChartDataForPastAnalysis } from "../lib/pastAnalysisChartStrip.js";
import {
  patchPastAnalysisBusinessActions,
  patchPastAnalysisPivotArtifacts,
} from "../models/pastAnalysis.model.js";
import type { ChartSpec } from "../shared/schema.js";

/**
 * AMR2 · Verify the past_analyses write site captures the structured
 * AnswerEnvelope + InvestigationSummary and strips inline chart data before
 * persistence. The patch helpers (businessActions + pivotArtifacts) own the
 * fields that land AFTER the initial fire-and-forget write resolves —
 * they're exercised against the validation guard since Cosmos isn't stubbed
 * here (the W2.3 e2e integration test owns the live-container path).
 *
 * The actual `maybeWritePastAnalysisDoc` orchestration in
 * `chatStream.service.ts` is exercised indirectly by W2.3 end-to-end and by
 * AMR4's cache-hit response tests. This wave's tests pin the new primitives.
 */

const chart = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
  type: "bar",
  title: "Top 10 SKUs",
  x: "Products",
  y: "Value",
  ...overrides,
});

describe("AMR2 · stripChartDataForPastAnalysis", () => {
  it("drops the inline rows but preserves spec, insight, commentary, provenance", () => {
    const input = chart({
      data: [
        { Products: "MARICO", Value: 2200 },
        { Products: "PURITE", Value: 1700 },
      ],
      keyInsight: "MARICO leads at ~56% of the top-2 split.",
      businessCommentary: "Watch competitive pressure on PURITE in Q4.",
      _autoLayers: ["trend"],
      _agentProvenance: {
        toolCalls: [],
        sqlEquivalent: "SELECT Products, SUM(Value) FROM data GROUP BY Products",
        sources: [],
      },
    } as Partial<ChartSpec>);
    const [out] = stripChartDataForPastAnalysis([input]);
    assert.equal((out as ChartSpec & { data?: unknown }).data, undefined);
    assert.equal(out?.title, "Top 10 SKUs");
    assert.equal(out?.x, "Products");
    assert.equal(out?.y, "Value");
    assert.equal(
      (out as ChartSpec & { keyInsight?: string }).keyInsight,
      "MARICO leads at ~56% of the top-2 split."
    );
    assert.equal(
      (out as ChartSpec & { businessCommentary?: string }).businessCommentary,
      "Watch competitive pressure on PURITE in Q4."
    );
    assert.deepEqual(
      (out as ChartSpec & { _autoLayers?: string[] })._autoLayers,
      ["trend"]
    );
    assert.equal(
      (out as ChartSpec & { _agentProvenance?: { sqlEquivalent: string } })
        ._agentProvenance?.sqlEquivalent,
      "SELECT Products, SUM(Value) FROM data GROUP BY Products"
    );
  });

  it("handles a chart with no data array (already stripped) without error", () => {
    const input = chart({ keyInsight: "x" });
    const [out] = stripChartDataForPastAnalysis([input]);
    assert.equal((out as ChartSpec & { data?: unknown }).data, undefined);
    assert.equal((out as ChartSpec & { keyInsight?: string }).keyInsight, "x");
  });

  it("preserves array order across multiple charts", () => {
    const a = chart({ title: "A", data: [{ x: 1 }] });
    const b = chart({ title: "B", data: [{ x: 2 }] });
    const c = chart({ title: "C", data: [{ x: 3 }] });
    const out = stripChartDataForPastAnalysis([a, b, c]);
    assert.deepEqual(
      out.map((c) => c.title),
      ["A", "B", "C"]
    );
    for (const o of out) {
      assert.equal((o as ChartSpec & { data?: unknown }).data, undefined);
    }
  });

  it("does not mutate the input array", () => {
    const input = chart({ data: [{ x: 1 }] });
    const before = JSON.stringify(input);
    stripChartDataForPastAnalysis([input]);
    assert.equal(JSON.stringify(input), before);
  });
});

describe("AMR2 · patchPastAnalysisBusinessActions guards", () => {
  it("returns ok:false reason='empty' when items is empty (no Cosmos call)", async () => {
    const result = await patchPastAnalysisBusinessActions({
      sessionId: "s",
      turnId: "t",
      items: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty");
  });
});

describe("AMR2 · patchPastAnalysisPivotArtifacts guards", () => {
  it("returns ok:false reason='empty' when artifacts is empty (no Cosmos call)", async () => {
    const result = await patchPastAnalysisPivotArtifacts({
      sessionId: "s",
      turnId: "t",
      artifacts: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty");
  });
});
