import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkEnvelopeCompleteness,
  type AnswerEnvelope,
} from "../lib/agents/runtime/checkEnvelopeCompleteness.js";

const completeEnvelope: AnswerEnvelope = {
  tldr: "Saffola lost share in MT this quarter.",
  findings: [
    { headline: "South-MT volume dropped 8% MoM", evidence: "...", magnitude: "-8%" },
    { headline: "Premium SKU mix shifted", evidence: "...", magnitude: "-3 ppt" },
  ],
  implications: [
    {
      statement: "South-MT volume drop is brand-specific to Saffola.",
      soWhat: "Likely a pricing or pack-mix response — not category softness.",
      confidence: "high",
    },
    {
      statement: "Premium SKU mix loss compounds the volume drop.",
      soWhat: "Margin per unit slipping; brand-equity work needed.",
      confidence: "medium",
    },
  ],
  recommendations: [
    {
      action: "Audit MT pack-size mix vs. private label",
      rationale: "1L SKUs overlap top private-label price points",
      horizon: "this_quarter",
    },
    {
      action: "Tighten promo-depth rules in MT",
      rationale: "Promo elasticity slipped 12% vs benchmark",
      horizon: "now",
    },
  ],
};

describe("W17 · checkEnvelopeCompleteness — passes", () => {
  it("passes when envelope is undefined (fallback path)", () => {
    const r = checkEnvelopeCompleteness(undefined, "driver_discovery");
    assert.equal(r.ok, true);
  });

  it("passes when questionShape is undefined (no analytical brief)", () => {
    const r = checkEnvelopeCompleteness(completeEnvelope, undefined);
    assert.equal(r.ok, true);
  });

  it("passes when questionShape is 'none' (conversational turn)", () => {
    const r = checkEnvelopeCompleteness({ tldr: "x" }, "none");
    assert.equal(r.ok, true);
  });

  it("passes when questionShape is 'descriptive' (lookup/summary; no padding required)", () => {
    // A descriptive question deserves a small answer; the gate must not
    // force-pad implications/recommendations on lookups.
    const r = checkEnvelopeCompleteness({ tldr: "Total revenue is $12.4M." }, "descriptive");
    assert.equal(r.ok, true);
  });

  it("passes when all required sections are populated", () => {
    const r = checkEnvelopeCompleteness(completeEnvelope, "driver_discovery");
    assert.equal(r.ok, true);
  });

  it("passes when implications and recommendations each carry exactly 1 entry (floor lowered to 1)", () => {
    const env: AnswerEnvelope = {
      ...completeEnvelope,
      implications: [completeEnvelope.implications![0]],
      recommendations: [completeEnvelope.recommendations![0]],
    };
    const r = checkEnvelopeCompleteness(env, "driver_discovery");
    assert.equal(r.ok, true);
  });

  // Finding #8 — the lighter analytical shapes are ADVISORY, not hard-gated:
  // forcing implications/recommendations onto "compare A vs B" / "show the
  // trend" manufactured the unrequested bloat we want to avoid. The narrator
  // still adds them when warranted; the gate just no longer FORCES expansion.
  it("passes for 'comparison' even with no implications/recommendations (advisory)", () => {
    const r = checkEnvelopeCompleteness({ tldr: "East is 23% above West." }, "comparison");
    assert.equal(r.ok, true);
  });

  it("passes for 'trend' even with no implications/recommendations (advisory)", () => {
    const r = checkEnvelopeCompleteness({ tldr: "Visits rose 14% over the window." }, "trend");
    assert.equal(r.ok, true);
  });

  it("passes for 'exploration' even with no implications/recommendations (advisory)", () => {
    const r = checkEnvelopeCompleteness({ tldr: "Several segments stand out." }, "exploration");
    assert.equal(r.ok, true);
  });
});

describe("W17 · checkEnvelopeCompleteness — fails", () => {
  it("fails when implications is empty for a non-descriptive analytical shape", () => {
    const env: AnswerEnvelope = { ...completeEnvelope, implications: [] };
    const r = checkEnvelopeCompleteness(env, "driver_discovery");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "MISSING_DECISION_GRADE_SECTIONS");
      assert.match(r.description, /implications \(have 0, need ≥1/);
    }
  });

  it("fails when recommendations is empty for a non-descriptive analytical shape", () => {
    const env: AnswerEnvelope = { ...completeEnvelope, recommendations: [] };
    const r = checkEnvelopeCompleteness(env, "variance_diagnostic");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.description, /recommendations \(have 0, need ≥1/);
  });

  it("aggregates multiple missing sections into one description (diagnostic shape)", () => {
    const env: AnswerEnvelope = { tldr: "x" };
    const r = checkEnvelopeCompleteness(env, "driver_discovery");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.description, /implications/);
      assert.match(r.description, /recommendations/);
      assert.match(r.description, /questionShape=driver_discovery/);
      // domain "context" framing (domainLens) is no longer demanded.
      assert.ok(!/domainLens/.test(r.description));
    }
  });

  it("emits a non-empty courseCorrection that re-asserts the no-invent rule", () => {
    const r = checkEnvelopeCompleteness({}, "driver_discovery");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.courseCorrection, /do not invent new numbers/);
      assert.match(r.courseCorrection, /CONTEXT BUNDLE/);
      // never re-introduce a domain-pack citation instruction.
      assert.ok(!/marico-haircare/.test(r.courseCorrection));
    }
  });
});
