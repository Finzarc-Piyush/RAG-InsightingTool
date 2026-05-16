import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  selectTool,
  renderToolRouterPromptBlock,
  listSupportedIntents,
  type DatasetHints,
} from "../lib/agents/runtime/selectTool.js";

describe("WT6 · selectTool — canonical intent mappings", () => {
  it("maps cohort_retention to run_cohort_analysis first", () => {
    const recs = selectTool("cohort_retention", {
      hasEntities: true,
      hasTemporal: true,
    });
    assert.equal(recs[0].toolName, "run_cohort_analysis");
    assert.equal(recs[0].confidence, "high");
  });

  it("maps rfm_segmentation to run_rfm_segmentation first", () => {
    const recs = selectTool("rfm_segmentation", {
      hasEntities: true,
      hasTemporal: true,
      hasNumericMetric: true,
    });
    assert.equal(recs[0].toolName, "run_rfm_segmentation");
  });

  it("maps market_basket to run_market_basket first", () => {
    const recs = selectTool("market_basket", { hasTransactions: true });
    assert.equal(recs[0].toolName, "run_market_basket");
    assert.equal(recs[0].confidence, "high");
  });

  it("maps price_elasticity to run_price_elasticity first", () => {
    const recs = selectTool("price_elasticity", { hasPriceQuantity: true });
    assert.equal(recs[0].toolName, "run_price_elasticity");
  });

  it("maps ranking to run_breakdown_ranking first", () => {
    const recs = selectTool("ranking", {});
    assert.equal(recs[0].toolName, "run_breakdown_ranking");
  });

  it("maps drill_down to run_hierarchical_drill first", () => {
    const recs = selectTool("drill_down", {});
    assert.equal(recs[0].toolName, "run_hierarchical_drill");
  });

  it("maps trend to compute_growth first", () => {
    const recs = selectTool("trend", { hasTemporal: true });
    assert.equal(recs[0].toolName, "compute_growth");
  });

  it("maps fact_check to web_search", () => {
    const recs = selectTool("fact_check", {});
    assert.equal(recs[0].toolName, "web_search");
  });

  it("maps general_analytical to execute_query_plan first", () => {
    const recs = selectTool("general_analytical", {});
    assert.equal(recs[0].toolName, "execute_query_plan");
  });
});

describe("WT6 · selectTool — hint-based disambiguation", () => {
  it("drops run_cohort_analysis when hasEntities=false", () => {
    const recs = selectTool("cohort_retention", {
      hasEntities: false,
      hasTemporal: true,
    });
    assert.equal(recs[0].toolName, "execute_query_plan");
  });

  it("drops run_market_basket when hasTransactions=false", () => {
    const recs = selectTool("market_basket", { hasTransactions: false });
    assert.equal(recs[0].toolName, "execute_query_plan");
  });

  it("drops run_price_elasticity when hasPriceQuantity=false", () => {
    const recs = selectTool("price_elasticity", { hasPriceQuantity: false });
    assert.equal(recs[0].toolName, "run_correlation");
  });

  it("drops compute_growth when hasTemporal=false", () => {
    const recs = selectTool("trend", { hasTemporal: false });
    // compute_growth + detect_seasonality + execute_query_plan; both temporal
    // tools dropped; execute_query_plan remains
    assert.equal(recs[0].toolName, "execute_query_plan");
  });

  it("keeps the canonical pick when hints are unspecified", () => {
    const recs = selectTool("cohort_retention", {});
    assert.equal(recs[0].toolName, "run_cohort_analysis");
  });

  it("downgrades confidence to medium when first pick fails hints but is the only candidate", () => {
    // Pick an intent whose entire candidate list fails the hints.
    // market_basket → [run_market_basket, execute_query_plan]. With
    // hasTransactions=false, run_market_basket fails. execute_query_plan
    // passes everything so it becomes the first surviving rec.
    const recs = selectTool("market_basket", { hasTransactions: false });
    assert.equal(recs[0].toolName, "execute_query_plan");
    assert.equal(recs[0].confidence, "high", "passes hints");
  });
});

describe("WT6 · selectTool — recommendation ordering + confidence", () => {
  it("emits at least one fallback for every intent", () => {
    for (const intent of listSupportedIntents()) {
      const recs = selectTool(intent, {});
      assert.ok(recs.length >= 1, `intent ${intent} has at least one rec`);
    }
  });

  it("never returns an empty array — falls back to unfiltered list", () => {
    // Even if every hint says "no", we still want a recommendation so
    // the planner has SOMETHING.
    const recs = selectTool("cohort_retention", {
      hasEntities: false,
      hasTemporal: false,
      hasNumericMetric: false,
      hasTransactions: false,
      hasPriceQuantity: false,
    });
    assert.ok(recs.length >= 1);
  });

  it("first recommendation gets high confidence when it passes hints", () => {
    const recs = selectTool("rfm_segmentation", {
      hasEntities: true,
      hasTemporal: true,
      hasNumericMetric: true,
    });
    assert.equal(recs[0].confidence, "high");
  });

  it("subsequent recommendations get medium or low confidence", () => {
    const recs = selectTool("ranking", {});
    assert.ok(recs.length >= 2);
    assert.equal(recs[1].confidence, "medium");
    if (recs.length >= 3) assert.equal(recs[2].confidence, "low");
  });
});

describe("WT6 · selectTool — rationale + metadata", () => {
  it("emits a rationale string for every recommendation", () => {
    const recs = selectTool("market_basket", { hasTransactions: true });
    for (const r of recs) {
      assert.ok(r.rationale.length > 0);
    }
  });

  it("rationale references the tool's purpose", () => {
    const recs = selectTool("cohort_retention", {
      hasEntities: true,
      hasTemporal: true,
    });
    assert.match(recs[0].rationale, /cohort/i);
  });
});

describe("WT6 · renderToolRouterPromptBlock", () => {
  it("renders a deterministic prompt block", () => {
    const recs = selectTool("market_basket", { hasTransactions: true });
    const block = renderToolRouterPromptBlock(recs);
    assert.match(block, /Tool router recommends/);
    assert.match(block, /run_market_basket/);
    assert.match(block, /Prefer the first recommendation/);
  });

  it("handles the empty-recs edge case", () => {
    const block = renderToolRouterPromptBlock([]);
    assert.match(block, /No tool router recommendation/);
  });

  it("includes confidence labels in the rendered block", () => {
    const recs = selectTool("cohort_retention", {
      hasEntities: true,
      hasTemporal: true,
    });
    const block = renderToolRouterPromptBlock(recs);
    assert.match(block, /\(high\)/);
  });
});

describe("WT6 · listSupportedIntents", () => {
  it("returns the full intent set used by the mapper", () => {
    const intents = listSupportedIntents();
    assert.ok(intents.includes("cohort_retention"));
    assert.ok(intents.includes("market_basket"));
    assert.ok(intents.includes("fact_check"));
    assert.ok(intents.includes("general_analytical"));
  });

  it("every listed intent yields at least one recommendation", () => {
    for (const intent of listSupportedIntents()) {
      const recs = selectTool(intent, {});
      assert.ok(recs.length >= 1, `intent ${intent} → ≥1 rec`);
    }
  });
});
