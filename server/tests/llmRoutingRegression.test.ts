import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LLM_PURPOSE,
  categoryForPurpose,
  type LlmCallPurpose,
} from "../lib/agents/runtime/llmCallPurpose.js";

/**
 * W3.11 · Regression guard for the model-routing table.
 *
 * The biggest cost lever in the roadmap is the MINI/PRIMARY categorization
 * in `llmCallPurpose.ts`. A silent misclassification — e.g., PLANNER
 * accidentally moving to MINI, or SCHEMA_BIND slipping back to PRIMARY —
 * quietly shifts spend or degrades quality. These assertions pin the expected
 * table so any change is an explicit code edit reviewed through this test.
 *
 * Sibling: golden-question A/B CLI (`scripts/llm-golden-compare.ts`, future
 * wave) runs LIVE against Azure OpenAI with curated questions from
 * `tests/fixtures/golden-questions.json` seeded from `past_analyses` after
 * the feedback loop is live.
 */

// Canonical category table — every purpose explicitly listed here. Any new
// LLM_PURPOSE value must be added both to the enum AND to this test, forcing
// a deliberate category decision during code review.
const EXPECTED_CATEGORY: Record<LlmCallPurpose, "MINI" | "PRIMARY"> = {
  // MINI — classification / extraction / simple repair
  [LLM_PURPOSE.MODE_CLASSIFY]: "MINI",
  [LLM_PURPOSE.INTENT_CLASSIFY]: "MINI",
  [LLM_PURPOSE.COMPLEX_QUERY_SCORE]: "MINI",
  [LLM_PURPOSE.SCHEMA_BIND]: "MINI",
  [LLM_PURPOSE.COLUMN_MATCH]: "MINI",
  [LLM_PURPOSE.QUERY_PARSE]: "MINI",
  [LLM_PURPOSE.TOOL_ARG_REPAIR]: "MINI",
  [LLM_PURPOSE.DATE_ENRICH]: "MINI",
  [LLM_PURPOSE.TEMPORAL_GRAIN]: "MINI",
  [LLM_PURPOSE.DATAOPS_INTENT]: "MINI",
  [LLM_PURPOSE.DATAOPS_DEFAULTS]: "MINI",
  [LLM_PURPOSE.DATAOPS_ML_PARAMS]: "MINI",
  [LLM_PURPOSE.DATAOPS_COMPUTED_COL]: "MINI",
  [LLM_PURPOSE.CLARIFY_QUESTION]: "MINI",
  [LLM_PURPOSE.SUGGEST_FOLLOW_UPS]: "MINI",
  [LLM_PURPOSE.VERIFIER_SIMPLE]: "MINI",
  // PRIMARY — reasoning / synthesis / quality-sensitive output
  [LLM_PURPOSE.HYPOTHESIS]: "PRIMARY",
  [LLM_PURPOSE.PLANNER]: "PRIMARY",
  [LLM_PURPOSE.REFLECTOR]: "PRIMARY",
  [LLM_PURPOSE.VERIFIER_DEEP]: "PRIMARY",
  [LLM_PURPOSE.NARRATOR]: "PRIMARY",
  [LLM_PURPOSE.FINAL_ANSWER]: "PRIMARY",
  [LLM_PURPOSE.COORDINATOR]: "PRIMARY",
  [LLM_PURPOSE.ANALYSIS_BRIEF]: "PRIMARY",
  [LLM_PURPOSE.VISUAL_PLANNER]: "PRIMARY",
  [LLM_PURPOSE.BUILD_DASHBOARD]: "PRIMARY",
  [LLM_PURPOSE.SQL_GEN]: "PRIMARY",
  [LLM_PURPOSE.SESSION_CONTEXT]: "PRIMARY",
  [LLM_PURPOSE.DATASET_PROFILE]: "PRIMARY",
  [LLM_PURPOSE.INSIGHT_GEN]: "PRIMARY",
  [LLM_PURPOSE.CORRELATION_INSIGHT]: "PRIMARY",
  [LLM_PURPOSE.CHART_JSON_REPAIR]: "PRIMARY",
  [LLM_PURPOSE.CONVERSATIONAL]: "PRIMARY",
  [LLM_PURPOSE.ML_MODEL_SUMMARY]: "PRIMARY",
};

describe("W3.11 · model-routing regression guard", () => {
  it("every LLM_PURPOSE value has an expected category declared in this test", () => {
    const enumValues = Object.values(LLM_PURPOSE) as LlmCallPurpose[];
    const expectedKeys = Object.keys(EXPECTED_CATEGORY);
    for (const v of enumValues) {
      assert.ok(
        expectedKeys.includes(v),
        `LLM_PURPOSE "${v}" is not listed in EXPECTED_CATEGORY — add the category assertion here so the decision is reviewed`
      );
    }
  });

  it("every declared expectation matches the live categoryForPurpose()", () => {
    for (const [purpose, expected] of Object.entries(EXPECTED_CATEGORY)) {
      const actual = categoryForPurpose(purpose as LlmCallPurpose);
      assert.strictEqual(
        actual,
        expected,
        `purpose "${purpose}" expected category "${expected}" but got "${actual}" — intentional change must update this test`
      );
    }
  });

  it("MINI purpose count is within the expected range (a big swing is suspicious)", () => {
    const miniCount = Object.values(EXPECTED_CATEGORY).filter((c) => c === "MINI").length;
    // Current baseline: 16 MINI purposes. Allow small drift (12–22) without
    // failing, but big moves require a deliberate test update that documents
    // the category shift in review.
    assert.ok(
      miniCount >= 12 && miniCount <= 22,
      `expected 12–22 MINI purposes, got ${miniCount} — a big shift here changes cost significantly; confirm and update this bound`
    );
  });

  it("PRIMARY purpose count is within the expected range", () => {
    const primaryCount = Object.values(EXPECTED_CATEGORY).filter((c) => c === "PRIMARY").length;
    // Current baseline: 18 PRIMARY purposes. Same drift guard as MINI.
    assert.ok(
      primaryCount >= 14 && primaryCount <= 24,
      `expected 14–24 PRIMARY purposes, got ${primaryCount}`
    );
  });

  it("no duplicate purpose string values", () => {
    const values = Object.values(LLM_PURPOSE);
    const uniq = new Set(values);
    assert.strictEqual(
      uniq.size,
      values.length,
      "duplicate purpose string detected — routing table would collide"
    );
  });

  it("no duplicate enum keys (TypeScript catches this at compile, belt + braces)", () => {
    const keys = Object.keys(LLM_PURPOSE);
    const uniq = new Set(keys);
    assert.strictEqual(uniq.size, keys.length);
  });
});
