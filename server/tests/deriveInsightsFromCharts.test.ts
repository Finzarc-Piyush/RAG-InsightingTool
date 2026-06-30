/**
 * Wave SU-KI1 · `deriveInsightsFromCharts` must never echo the chart TITLE as
 * an "insight". Pre-fix, a chart with an empty `keyInsight` produced
 * `{ text: "Insight: " + chart.title }` — so a plain lookup ("total NR by
 * Channel") rendered a useless "Key Insight: total_nr by Channel" bullet.
 * Post-fix, only charts carrying a real `keyInsight` produce a bullet.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveInsightsFromCharts } from "../services/chat/chatResponse.service.js";

describe("Wave SU-KI1 · deriveInsightsFromCharts", () => {
  it("does NOT echo the chart title when keyInsight is empty", () => {
    const out = deriveInsightsFromCharts([
      { title: "total_nr by Channel", type: "bar" },
    ]);
    assert.deepEqual(out, []);
  });

  it("treats whitespace-only keyInsight as empty (no bullet)", () => {
    const out = deriveInsightsFromCharts([
      { title: "x by y", keyInsight: "   " },
    ]);
    assert.deepEqual(out, []);
  });

  it("surfaces a real keyInsight verbatim", () => {
    const out = deriveInsightsFromCharts([
      { title: "total_nr by Channel", keyInsight: "GT leads at 6.55B, 2.4× MT." },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "GT leads at 6.55B, 2.4× MT.");
    assert.equal(out[0].id, 1);
  });

  it("re-numbers sequentially when insight-less charts are dropped", () => {
    const out = deriveInsightsFromCharts([
      { title: "chart A" }, // no keyInsight → dropped
      { title: "chart B", keyInsight: "B insight" },
      { title: "chart C", keyInsight: "C insight" },
    ]);
    assert.deepEqual(
      out,
      [
        { id: 1, text: "B insight" },
        { id: 2, text: "C insight" },
      ]
    );
  });

  it("returns [] for empty / missing input", () => {
    assert.deepEqual(deriveInsightsFromCharts([]), []);
    assert.deepEqual(deriveInsightsFromCharts(undefined as any), []);
  });
});
