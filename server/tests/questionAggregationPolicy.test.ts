import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasExplicitTimeGrain,
  hasExplicitBreakdownOrGrain,
  vagueTemporalTrendQuestion,
  shouldAllowWideWithoutAggRejection,
  shouldRejectWideWithoutAgg,
} from "../lib/questionAggregationPolicy.js";

describe("questionAggregationPolicy", () => {
  it("detects vague over-time questions as allowing wide non-aggregated responses", () => {
    const q = "What is the total sales revenue over time?";
    assert.equal(vagueTemporalTrendQuestion(q), true);
    assert.equal(hasExplicitBreakdownOrGrain(q), false);
    assert.equal(shouldAllowWideWithoutAggRejection(q), true);
  });

  it("detects explicit time grain from yearly phrasing", () => {
    const q = "What are yearly sales trends by segment?";
    assert.equal(hasExplicitTimeGrain(q), true);
    assert.equal(hasExplicitBreakdownOrGrain(q), true);
    assert.equal(vagueTemporalTrendQuestion(q), false);
  });

  it("detects explicit breakdown via by/per/group by/breakdown keywords", () => {
    const q = "How does sales revenue vary by ship mode?";
    assert.equal(hasExplicitBreakdownOrGrain(q), true);
    assert.equal(vagueTemporalTrendQuestion(q), false);
    assert.equal(shouldAllowWideWithoutAggRejection(q), false);
  });

  it("shouldRejectWideWithoutAgg is skipped for vague over-time questions", () => {
    const q = "What is the total sales revenue over time?";
    const reject = shouldRejectWideWithoutAgg({
      question: q,
      inputRowCount: 50,
      outputRowCount: 50,
      appliedAggregation: false,
    });
    assert.equal(reject, false);
  });

  it("shouldRejectWideWithoutAgg applies for explicit breakdown questions", () => {
    const q = "How does sales revenue vary by ship mode?";
    const reject = shouldRejectWideWithoutAgg({
      question: q,
      inputRowCount: 50,
      outputRowCount: 50,
      appliedAggregation: false,
    });
    assert.equal(reject, true);
  });
});

