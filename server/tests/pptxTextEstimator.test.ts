/**
 * Stream A · unit tests for the shared PPTX text-geometry estimators
 * (`master.ts`). These are what every layout uses to size a box to its text so
 * the insight/recommendation/methodology prose can't spill onto a chart or off
 * the slide. Pure functions — no PPTX engine needed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  charsPerLine,
  estimateLineCount,
  estimateTextHeight,
  measureInsightLanes,
} from "../lib/exports/pptx/master.js";
import type { ChartInsightLanes } from "../shared/chartInsightLanes.js";

describe("pptx text estimators", () => {
  it("charsPerLine returns a sane band for the content width at title/body sizes", () => {
    const atTitle = charsPerLine(12.33, 23);
    assert.ok(atTitle >= 60 && atTitle <= 95, `title cpl out of band: ${atTitle}`);
    const atBody = charsPerLine(11.77, 16);
    assert.ok(atBody > atTitle, "smaller font fits more chars per line");
  });

  it("charsPerLine never returns < 1 for degenerate inputs", () => {
    assert.equal(charsPerLine(0, 16), 1);
    assert.equal(charsPerLine(5, 0), 1);
  });

  it("estimateLineCount honours explicit newlines", () => {
    assert.equal(estimateLineCount("a\nb\nc", 100, 12), 3);
    assert.equal(estimateLineCount("", 100, 12), 1);
  });

  it("estimateLineCount wraps long text to multiple lines", () => {
    const long = "x".repeat(400);
    assert.ok(estimateLineCount(long, 11.77, 16) >= 3, "400 chars should wrap to 3+ lines");
  });

  it("estimateTextHeight is monotonic in text length", () => {
    const short = estimateTextHeight("one short line", 6, 14);
    const long = estimateTextHeight("word ".repeat(120), 6, 14);
    assert.ok(long > short, "more text → taller box");
    assert.ok(short > 0);
  });

  it("measureInsightLanes grows as lanes are added", () => {
    const w = 11.77;
    const opts = { headlinePt: 16, lanePt: 12, paraSpaceAfterPt: 4 };
    const headlineOnly: ChartInsightLanes = { headline: "GT drives 70% of net revenue" };
    const withWhy: ChartInsightLanes = { ...headlineOnly, why: "concentration in general trade" };
    const withWhyDo: ChartInsightLanes = { ...withWhy, do: "rebalance channel investment toward digital" };
    const h0 = measureInsightLanes(headlineOnly, w, opts);
    const h1 = measureInsightLanes(withWhy, w, opts);
    const h2 = measureInsightLanes(withWhyDo, w, opts);
    assert.ok(h1 > h0, "adding WHY increases height");
    assert.ok(h2 > h1, "adding DO increases height");
  });
});
