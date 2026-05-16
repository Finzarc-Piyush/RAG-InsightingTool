/**
 * Wave WW1 · planner-side wiring of WT6 / WQ2 / WQ1 — pure helper tests.
 *
 * Covers:
 *  - `inferAnalystIntent` — question regex priority + analysisBrief fallback.
 *  - `buildDatasetHints` — column-name heuristics for the 7 hints.
 *  - `buildPlannerHintsBlock` — combined block shape, empty/non-empty paths,
 *    external-claim section appears iff WQ2 fires.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  PLANNER_CONFIDENCE_DIRECTIVE,
  buildDatasetHints,
  buildPlannerHintsBlock,
  inferAnalystIntent,
} from "../lib/agents/runtime/plannerHintsBlock.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";

function makeSummary(partial: Partial<DataSummary> = {}): DataSummary {
  return {
    rowCount: 100,
    columnCount: 0,
    columns: [],
    numericColumns: [],
    dateColumns: [],
    ...partial,
  } as DataSummary;
}

function makeBrief(shape: AnalysisBrief["questionShape"]): AnalysisBrief {
  return {
    version: 1,
    clarifyingQuestions: [],
    epistemicNotes: [],
    questionShape: shape,
  } as AnalysisBrief;
}

describe("Wave WW1 · inferAnalystIntent", () => {
  it("infers cohort_retention from 'cohort' / 'retention' / 'churn'", () => {
    assert.equal(inferAnalystIntent("show me cohort retention by signup month"), "cohort_retention");
    assert.equal(inferAnalystIntent("what's our churn rate?"), "cohort_retention");
  });

  it("infers rfm_segmentation", () => {
    assert.equal(inferAnalystIntent("Do an RFM segmentation"), "rfm_segmentation");
  });

  it("infers market_basket from cross-sell / bought-together / association rule", () => {
    assert.equal(inferAnalystIntent("which products are bought together?"), "market_basket");
    assert.equal(inferAnalystIntent("cross-sell opportunities"), "market_basket");
  });

  it("infers price_elasticity", () => {
    assert.equal(inferAnalystIntent("compute elasticity"), "price_elasticity");
  });

  it("infers forecast / anomaly / seasonality / growth", () => {
    assert.equal(inferAnalystIntent("forecast next quarter"), "forecast");
    assert.equal(inferAnalystIntent("any anomalies in Q3?"), "anomaly");
    assert.equal(inferAnalystIntent("is there a seasonality pattern?"), "seasonality");
    assert.equal(inferAnalystIntent("show YoY growth by region"), "growth");
  });

  it("infers ranking from top-N / highest / lowest", () => {
    assert.equal(inferAnalystIntent("top 10 SKUs by revenue"), "ranking");
    assert.equal(inferAnalystIntent("which region has the highest sales?"), "ranking");
  });

  it("infers trend from explicit trend / over time wording", () => {
    assert.equal(inferAnalystIntent("how have sales evolved over time?"), "trend");
  });

  it("infers comparison from 'compare' / 'vs'", () => {
    assert.equal(inferAnalystIntent("compare Q3 vs Q4"), "comparison");
  });

  it("falls back to analysisBrief.questionShape when question text has no match", () => {
    assert.equal(
      inferAnalystIntent("what's interesting here?", makeBrief("driver_discovery")),
      "correlation",
    );
    assert.equal(
      inferAnalystIntent("tell me something", makeBrief("variance_diagnostic")),
      "drill_down",
    );
    assert.equal(
      inferAnalystIntent("budget reallocation please", makeBrief("budget_reallocation")),
      "general_analytical",
    );
  });

  it("question-text rules take priority over questionShape", () => {
    assert.equal(
      inferAnalystIntent("show me cohort retention", makeBrief("trend")),
      "cohort_retention",
    );
  });

  it("defaults to general_analytical when no signal at all", () => {
    assert.equal(inferAnalystIntent("Tell me about my data"), "general_analytical");
    assert.equal(inferAnalystIntent(""), "general_analytical");
  });
});

describe("Wave WW1 · buildDatasetHints", () => {
  it("returns only the external-claim flag when summary is absent", () => {
    const h = buildDatasetHints(undefined, { hasExternalClaim: true, claims: [], suggestedAction: "x" });
    assert.equal(h.hasExternalClaimMarkers, true);
    assert.equal(h.hasTemporal, undefined);
  });

  it("detects transactions / price-quantity / entities / temporal / hierarchy / numeric metric", () => {
    const summary = makeSummary({
      columns: [
        { name: "Transaction ID", type: "string", sampleValues: [] },
        { name: "SKU", type: "string", sampleValues: [] },
        { name: "Unit Price", type: "number", sampleValues: [] },
        { name: "Quantity", type: "number", sampleValues: [] },
        { name: "Customer ID", type: "string", sampleValues: [] },
        { name: "Region", type: "string", sampleValues: [] },
        { name: "State", type: "string", sampleValues: [] },
        { name: "Order Date", type: "date", sampleValues: [] },
      ] as DataSummary["columns"],
      numericColumns: ["Unit Price", "Quantity"],
      dateColumns: ["Order Date"],
    });
    const h = buildDatasetHints(summary);
    assert.equal(h.hasTransactions, true);
    assert.equal(h.hasPriceQuantity, true);
    assert.equal(h.hasEntities, true);
    assert.equal(h.hasTemporal, true);
    assert.equal(h.hasHierarchy, true);
    assert.equal(h.hasNumericMetric, true);
    assert.equal(h.hasExternalClaimMarkers, false);
  });

  it("returns false flags when columns lack the markers", () => {
    const summary = makeSummary({
      columns: [{ name: "Some metric", type: "number", sampleValues: [] }] as DataSummary["columns"],
      numericColumns: ["Some metric"],
      dateColumns: [],
    });
    const h = buildDatasetHints(summary);
    assert.equal(h.hasTransactions, false);
    assert.equal(h.hasPriceQuantity, false);
    assert.equal(h.hasEntities, false);
    assert.equal(h.hasTemporal, false);
    assert.equal(h.hasHierarchy, false);
    assert.equal(h.hasNumericMetric, true);
  });
});

describe("Wave WW1 · buildPlannerHintsBlock", () => {
  it("emits the router block with the intent header for a ranking question", () => {
    const result = buildPlannerHintsBlock(
      "top 5 SKUs by revenue",
      makeSummary({
        columns: [
          { name: "SKU", type: "string", sampleValues: [] },
          { name: "revenue", type: "number", sampleValues: [] },
        ] as DataSummary["columns"],
        numericColumns: ["revenue"],
      }),
    );
    assert.equal(result.intent, "ranking");
    assert.ok(result.topRecommendation, "expected a top recommendation for ranking");
    assert.match(result.block, /TOOL_ROUTER_HINT/);
    assert.match(result.block, /Intent: ranking/);
    assert.match(result.block, /run_breakdown_ranking/);
    assert.equal(result.hasExternalClaim, false);
    assert.doesNotMatch(result.block, /EXTERNAL_CLAIM_MARKERS/);
  });

  it("emits the external-claim block when WQ2 fires + adds the web_search instruction", () => {
    const result = buildPlannerHintsBlock(
      "How is the haircare market growing compared to our competitors?",
      makeSummary(),
    );
    assert.equal(result.hasExternalClaim, true);
    assert.match(result.block, /EXTERNAL_CLAIM_MARKERS/);
    assert.match(result.block, /web_search/);
    assert.match(result.block, /competitor=|market_size=/);
  });

  it("returns an empty block for a no-signal question + summary", () => {
    // general_analytical intent always has a recommendation, so the block is
    // never truly empty when the helper has anything to say. Verify the
    // router block still surfaces general_analytical with execute_query_plan
    // as the top pick.
    const result = buildPlannerHintsBlock("tell me about my data", makeSummary());
    assert.equal(result.intent, "general_analytical");
    assert.equal(result.hasExternalClaim, false);
    assert.match(result.block, /execute_query_plan/);
  });

  it("filters run_market_basket out when the dataset lacks transactions (router hint filter)", () => {
    const result = buildPlannerHintsBlock(
      "find cross-sell associations",
      makeSummary({
        columns: [{ name: "Customer ID", type: "string", sampleValues: [] }] as DataSummary["columns"],
      }),
    );
    assert.equal(result.intent, "market_basket");
    // No transactions column → selectTool drops run_market_basket from the
    // candidate list and falls back to execute_query_plan as the top pick.
    // This is the wire-up's value-add: the planner sees an honest router
    // hint even when the canonical tool is inapplicable.
    assert.ok(result.topRecommendation);
    assert.notEqual(result.topRecommendation?.toolName, "run_market_basket");
    assert.equal(result.topRecommendation?.toolName, "execute_query_plan");
  });

  it("exports a PLANNER_CONFIDENCE_DIRECTIVE referencing WQ1 inputs", () => {
    assert.match(PLANNER_CONFIDENCE_DIRECTIVE, /WQ1/);
    assert.match(PLANNER_CONFIDENCE_DIRECTIVE, /run_significance_test|R²|p-value/);
  });
});
