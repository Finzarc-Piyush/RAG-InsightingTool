import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * W-DX2 · the per-chart insight generator already emitted a "likely reason"
 * folded inside keyInsight — but ungated and only loosely hedged. This wave
 * aligns it with the answer envelope's hedged causal lane: the "why" must be a
 * clearly-hedged hypothesis and must never carry a number.
 *
 * NOTE (deliberate deviation from the sketch): the "why" is NOT relocated to
 * businessCommentary, because that field is domain-pack-gated
 * (`wantsBusinessCommentary = Boolean(domainBlock)`) — moving it there would
 * DROP the "why" for non-FMCG datasets (e.g. Titanic). Tightening the existing
 * in-keyInsight reason to the same hedge + no-number rails closes the safety gap
 * without that regression. This source-inspection test pins the discipline.
 */
const src = readFileSync(
  resolve(new URL("../lib/insightGenerator.ts", import.meta.url).pathname),
  "utf-8"
);

describe("chart insight WHY: lane is a hedged, number-free hypothesis", () => {
  it("the WHY: lane mandates a hedge", () => {
    // The reason now lives in a dedicated optional "WHY: " lane (the chart-insight
    // rework) rather than a free-prose "LIKELY REASON" step, but the discipline
    // is unchanged: it must open with a hedge.
    assert.match(src, /start the line literally with "WHY: "/);
    assert.match(src, /MUST open with a hedge/);
  });

  it("forbids a number inside the WHY lane", () => {
    assert.match(src, /MUST NOT contain any number/);
  });

  it("the system prompt frames the WHY line as a hedged hypothesis", () => {
    assert.match(src, /It is a HYPOTHESIS: ALWAYS introduce it with a hedge/);
    assert.match(src, /NEVER attach a number to it/);
  });
});
