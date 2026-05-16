import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessConfidence,
  decorateFindings,
  summarizeConfidenceTiers,
  narratorBudget,
  hedgeFor,
  type FindingEvidence,
} from "../lib/agents/runtime/scaleNarrativeByConfidence.js";

describe("WQ1 · assessConfidence — high tier", () => {
  it("rates a well-powered, significant, tight-CI finding as high", () => {
    const a = assessConfidence({ n: 100, pValue: 0.01, ciRelativeWidth: 0.1 });
    assert.equal(a.tier, "high");
    assert.equal(a.hedge, "");
    assert.ok(a.reasons.some((r) => r.includes("n=100")));
    assert.ok(a.reasons.some((r) => r.includes("p=")));
  });

  it("rates an evidence-less finding as medium (never high by default)", () => {
    const a = assessConfidence({});
    assert.equal(a.tier, "medium");
  });

  it("requires R² >= 0.5 for high when R² is supplied", () => {
    // n + p look high, but R² is mid → drops to medium
    const a = assessConfidence({ n: 100, pValue: 0.01, rSquared: 0.4 });
    assert.equal(a.tier, "medium");
  });

  it("R² >= 0.5 keeps a finding in the high tier", () => {
    const a = assessConfidence({ n: 100, pValue: 0.01, rSquared: 0.85 });
    assert.equal(a.tier, "high");
  });
});

describe("WQ1 · assessConfidence — low tier", () => {
  it("rates n<10 as low even when p-value is good", () => {
    const a = assessConfidence({ n: 5, pValue: 0.01 });
    assert.equal(a.tier, "low");
    assert.ok(a.reasons.some((r) => r.includes("small sample")));
  });

  it("rates p>0.15 as low even with large n", () => {
    const a = assessConfidence({ n: 200, pValue: 0.3 });
    assert.equal(a.tier, "low");
    assert.ok(a.reasons.some((r) => r.includes("weak significance")));
  });

  it("rates wide CI (>0.6) as low", () => {
    const a = assessConfidence({ n: 100, pValue: 0.01, ciRelativeWidth: 0.9 });
    assert.equal(a.tier, "low");
    assert.ok(a.reasons.some((r) => r.includes("wide CI")));
  });

  it("rates R²<0.2 as low", () => {
    const a = assessConfidence({ n: 100, pValue: 0.01, rSquared: 0.15 });
    assert.equal(a.tier, "low");
    assert.ok(a.reasons.some((r) => r.includes("poor model fit")));
  });

  it("collects all low-tier reasons (not just the first)", () => {
    const a = assessConfidence({ n: 5, pValue: 0.4 });
    assert.equal(a.tier, "low");
    assert.ok(a.reasons.length >= 2);
  });
});

describe("WQ1 · assessConfidence — medium tier", () => {
  it("rates n in [10, 30) with otherwise neutral signals as medium", () => {
    const a = assessConfidence({ n: 20 });
    assert.equal(a.tier, "medium");
    assert.ok(a.reasons.some((r) => r.includes("moderate sample")));
  });

  it("rates p in (0.05, 0.15] as medium", () => {
    const a = assessConfidence({ n: 100, pValue: 0.1 });
    assert.equal(a.tier, "medium");
    assert.ok(a.reasons.some((r) => r.includes("marginal significance")));
  });

  it("rates CI width in (0.3, 0.6] as medium", () => {
    const a = assessConfidence({ n: 100, pValue: 0.01, ciRelativeWidth: 0.45 });
    assert.equal(a.tier, "medium");
    assert.ok(a.reasons.some((r) => r.includes("wider CI")));
  });

  it("rates R² in [0.2, 0.5) as medium", () => {
    const a = assessConfidence({ n: 100, pValue: 0.01, rSquared: 0.35 });
    assert.equal(a.tier, "medium");
    assert.ok(a.reasons.some((r) => r.includes("modest fit")));
  });

  it("medium tier emits the standard hedge phrase", () => {
    const a = assessConfidence({ n: 20 });
    assert.equal(a.hedge, "The pattern is suggestive but the sample is moderate.");
  });
});

describe("WQ1 · decorateFindings", () => {
  it("attaches confidence to each finding using Map evidence", () => {
    const findings = [
      { id: "f1", label: "A" },
      { id: "f2", label: "B" },
    ];
    const evidence = new Map<string, FindingEvidence>([
      ["f1", { n: 100, pValue: 0.01 }],
      ["f2", { n: 5 }],
    ]);
    const out = decorateFindings(findings, evidence);
    assert.equal(out[0].confidence.tier, "high");
    assert.equal(out[1].confidence.tier, "low");
  });

  it("accepts a plain object as the evidence map", () => {
    const findings = [{ id: "f1" }];
    const out = decorateFindings(findings, { f1: { n: 20 } });
    assert.equal(out[0].confidence.tier, "medium");
  });

  it("defaults to medium with explicit reason when evidence is missing", () => {
    const findings = [{ id: "f1" }];
    const out = decorateFindings(findings, new Map());
    assert.equal(out[0].confidence.tier, "medium");
    assert.ok(out[0].confidence.reasons[0].includes("no evidence supplied"));
  });

  it("preserves original finding fields", () => {
    type F = { id: string; label: string; detail: string };
    const findings: F[] = [{ id: "f1", label: "A", detail: "deep" }];
    const out = decorateFindings(findings, { f1: { n: 100, pValue: 0.01 } });
    assert.equal(out[0].label, "A");
    assert.equal(out[0].detail, "deep");
    assert.equal(out[0].confidence.tier, "high");
  });
});

describe("WQ1 · summarizeConfidenceTiers", () => {
  it("counts tiers and emits a prompt-block-friendly line", () => {
    const summary = summarizeConfidenceTiers([
      { tier: "high", reasons: [], hedge: "" },
      { tier: "high", reasons: [], hedge: "" },
      { tier: "medium", reasons: [], hedge: "h" },
      { tier: "low", reasons: [], hedge: "l" },
    ]);
    assert.equal(summary.total, 4);
    assert.equal(summary.high, 2);
    assert.equal(summary.medium, 1);
    assert.equal(summary.low, 1);
    assert.match(summary.promptLine, /4 total/);
    assert.match(summary.promptLine, /2 high/);
  });

  it("handles an empty list", () => {
    const summary = summarizeConfidenceTiers([]);
    assert.equal(summary.total, 0);
    assert.match(summary.promptLine, /0 total/);
  });
});

describe("WQ1 · narratorBudget + hedgeFor", () => {
  it("emits longer budget for high-tier, shorter for low", () => {
    assert.ok(narratorBudget("high").maxSentences > narratorBudget("low").maxSentences);
  });

  it("requires hedge for low + medium but not high", () => {
    assert.equal(narratorBudget("high").hedgeRequired, false);
    assert.equal(narratorBudget("medium").hedgeRequired, true);
    assert.equal(narratorBudget("low").hedgeRequired, true);
  });

  it("hedgeFor returns empty string for high, non-empty for medium + low", () => {
    assert.equal(hedgeFor("high"), "");
    assert.ok(hedgeFor("medium").length > 0);
    assert.ok(hedgeFor("low").length > 0);
  });
});
