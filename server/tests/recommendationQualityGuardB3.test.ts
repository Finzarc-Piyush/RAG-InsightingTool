import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isGenericRecommendation,
  filterGenericRecommendations,
} from "../lib/recommendationQualityGuard.js";

describe("B3 · recommendationQualityGuard", () => {
  it("drops vague-verb filler with no lever and no number", () => {
    assert.equal(isGenericRecommendation({ action: "Monitor performance closely" }), true);
    assert.equal(isGenericRecommendation({ action: "Consider improving sales" }), true);
    assert.equal(isGenericRecommendation({ action: "Keep an eye on the market" }), true);
    assert.equal(isGenericRecommendation({ action: "Focus on growth" }), true);
    assert.equal(isGenericRecommendation({ action: "Leverage your strengths" }), true);
    assert.equal(isGenericRecommendation({ action: "" }), true);
    assert.equal(isGenericRecommendation(undefined), true);
  });

  it("keeps strong-verb recommendations (non-vague action)", () => {
    assert.equal(
      isGenericRecommendation({ action: "Reallocate trade spend toward the East" }),
      false
    );
    assert.equal(
      isGenericRecommendation({ action: "Defend metro share with a Q4 shelf-pricing audit" }),
      false
    );
    assert.equal(isGenericRecommendation({ action: "Delist the bottom 3 SKUs" }), false);
  });

  it("keeps a vague verb when it names a concrete lever", () => {
    // "Monitor" is vague, but "metro shelf-share" is a lever → actionable.
    assert.equal(
      isGenericRecommendation({ action: "Monitor metro shelf-share weekly" }),
      false
    );
    assert.equal(
      isGenericRecommendation({ action: "Improve Q-com assortment depth" }),
      false
    );
  });

  it("keeps a vague verb when a number appears in action/rationale/impact", () => {
    assert.equal(
      isGenericRecommendation({
        action: "Increase sales",
        rationale: "volume fell 12% YoY",
      }),
      false
    );
    assert.equal(
      isGenericRecommendation({
        action: "Boost performance",
        expectedImpact: "recover ~₹3M of quarterly revenue",
      }),
      false
    );
  });

  it("filterGenericRecommendations is pure subtraction and preserves order", () => {
    const recs = [
      { action: "Reallocate ₹3M of trade spend to the East", rationale: "East grew 18%" },
      { action: "Monitor performance" },
      { action: "Delist the bottom 3 SKUs", rationale: "they are 2% of volume" },
      { action: "Keep an eye on things" },
    ];
    const out = filterGenericRecommendations(recs)!;
    assert.equal(out.length, 2);
    assert.equal(out[0].action, "Reallocate ₹3M of trade spend to the East");
    assert.equal(out[1].action, "Delist the bottom 3 SKUs");
  });

  it("preserves undefined (absent field stays absent, never becomes [])", () => {
    assert.equal(filterGenericRecommendations(undefined), undefined);
    assert.equal(filterGenericRecommendations(null), undefined);
  });
});
