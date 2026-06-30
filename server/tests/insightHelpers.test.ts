import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendEnvelopeInsight,
  mergeInsights,
  normalizeInsightText,
} from "../lib/agents/runtime/insightHelpers.js";
import type { Insight } from "../shared/schema.js";

/**
 * W-INS-DEDUP · the tool-insight merge seam (agentLoop) used a raw
 * `push(...result.insights)` with NO dedup, so the same set emitted across two
 * tool turns stacked into "7 insights then the same 7 again" (14 total). These
 * pin that `mergeInsights` collapses an identical second batch, keeps genuinely
 * different insights, renumbers sequentially, and treats bold-marker / casing /
 * whitespace differences as duplicates.
 */
describe("mergeInsights — de-duplicating tool-insight appender", () => {
  const batchOf = (n: number): Insight[] =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, text: `Insight number ${i + 1}` }));

  it("drops an identical second batch (7 → 7, not 14)", () => {
    const merged: Insight[] = [];
    mergeInsights(merged, batchOf(7));
    mergeInsights(merged, batchOf(7)); // same 7 emitted again by a replan/re-run
    assert.equal(merged.length, 7);
    assert.deepEqual(
      merged.map((i) => i.id),
      [1, 2, 3, 4, 5, 6, 7],
    );
  });

  it("keeps genuinely different insights and assigns sequential ids", () => {
    const merged: Insight[] = [];
    mergeInsights(merged, [{ id: 1, text: "GT leads at 63.4%" }]);
    mergeInsights(merged, [{ id: 9, text: "CSD trails at 28.1%" }]);
    assert.equal(merged.length, 2);
    assert.deepEqual(
      merged.map((i) => i.id),
      [1, 2],
    );
  });

  it("treats bold-marker / casing / whitespace-only differences as duplicates", () => {
    const merged: Insight[] = [{ id: 1, text: "**GT** leads at 63.4%" }];
    mergeInsights(merged, [{ id: 2, text: "gt leads  at 63.4%" }]);
    assert.equal(merged.length, 1);
  });

  it("skips blank / whitespace-only incoming insights", () => {
    const merged: Insight[] = [];
    mergeInsights(merged, [{ id: 1, text: "   " }, { id: 2, text: "Real one" }]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.text, "Real one");
  });

  it("is a no-op for empty / undefined incoming", () => {
    const merged: Insight[] = [{ id: 1, text: "keep me" }];
    mergeInsights(merged, []);
    mergeInsights(merged, undefined);
    assert.equal(merged.length, 1);
  });
});

describe("appendEnvelopeInsight — normalized-text dedup", () => {
  it("skips a normalized duplicate of an existing entry", () => {
    const merged: Insight[] = [{ id: 1, text: "**GT** leads at 63.4%" }];
    appendEnvelopeInsight(merged, "GT leads at 63.4%");
    assert.equal(merged.length, 1);
  });

  it("appends a distinct key insight with the next id", () => {
    const merged: Insight[] = [{ id: 1, text: "first" }];
    appendEnvelopeInsight(merged, "second");
    assert.deepEqual(merged, [
      { id: 1, text: "first" },
      { id: 2, text: "second" },
    ]);
  });
});

describe("normalizeInsightText", () => {
  it("drops bold markers, collapses whitespace, lowercases", () => {
    assert.equal(normalizeInsightText("**GT**  Leads "), "gt leads");
  });

  it("returns empty string for nullish input", () => {
    assert.equal(normalizeInsightText(undefined), "");
    assert.equal(normalizeInsightText(""), "");
  });
});
