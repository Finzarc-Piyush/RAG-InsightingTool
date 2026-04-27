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
  domainLens: "Per `marico-haircare-portfolio`, Saffola edible oils …",
};

describe("W17 · checkEnvelopeCompleteness — passes", () => {
  it("passes when envelope is undefined (fallback path)", () => {
    const r = checkEnvelopeCompleteness(undefined, "driver_discovery", true);
    assert.equal(r.ok, true);
  });

  it("passes when questionShape is undefined (no analytical brief)", () => {
    const r = checkEnvelopeCompleteness(completeEnvelope, undefined, true);
    assert.equal(r.ok, true);
  });

  it("passes when questionShape is 'none' (conversational turn)", () => {
    const r = checkEnvelopeCompleteness({ tldr: "x" }, "none", true);
    assert.equal(r.ok, true);
  });

  it("passes when all required sections are populated and domain context was supplied", () => {
    const r = checkEnvelopeCompleteness(completeEnvelope, "driver_discovery", true);
    assert.equal(r.ok, true);
  });

  it("passes when domainLens missing but no domain context was supplied", () => {
    const env: AnswerEnvelope = { ...completeEnvelope, domainLens: undefined };
    const r = checkEnvelopeCompleteness(env, "driver_discovery", false);
    assert.equal(r.ok, true);
  });
});

describe("W17 · checkEnvelopeCompleteness — fails", () => {
  it("fails when implications < 2", () => {
    const env: AnswerEnvelope = { ...completeEnvelope, implications: [completeEnvelope.implications![0]] };
    const r = checkEnvelopeCompleteness(env, "driver_discovery", true);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "MISSING_DECISION_GRADE_SECTIONS");
      assert.match(r.description, /implications \(have 1, need ≥2/);
    }
  });

  it("fails when recommendations < 2", () => {
    const env: AnswerEnvelope = { ...completeEnvelope, recommendations: [] };
    const r = checkEnvelopeCompleteness(env, "variance_diagnostic", true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.description, /recommendations \(have 0, need ≥2/);
  });

  it("fails when domainLens missing AND domain context was supplied", () => {
    const env: AnswerEnvelope = { ...completeEnvelope, domainLens: undefined };
    const r = checkEnvelopeCompleteness(env, "driver_discovery", true);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.description, /domainLens/);
      assert.match(r.courseCorrection, /marico-haircare-portfolio/);
    }
  });

  it("aggregates multiple missing sections into one description", () => {
    const env: AnswerEnvelope = { tldr: "x" };
    const r = checkEnvelopeCompleteness(env, "trend", true);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.description, /implications/);
      assert.match(r.description, /recommendations/);
      assert.match(r.description, /domainLens/);
      assert.match(r.description, /questionShape=trend/);
    }
  });

  it("courseCorrection omits domain pack instruction when domain wasn't supplied", () => {
    const env: AnswerEnvelope = { tldr: "x" };
    const r = checkEnvelopeCompleteness(env, "trend", false);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(!/marico-haircare/.test(r.courseCorrection));
    }
  });

  it("emits a non-empty courseCorrection that re-asserts the no-invent rule", () => {
    const r = checkEnvelopeCompleteness({}, "comparison", true);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.courseCorrection, /do not invent new numbers/);
      assert.match(r.courseCorrection, /CONTEXT BUNDLE/);
    }
  });
});
