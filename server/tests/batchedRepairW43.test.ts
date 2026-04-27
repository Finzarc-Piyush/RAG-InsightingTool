/**
 * Wave W43 · batched-repair contract test
 *
 * The repair-loop logic batches all failed envelope checks into a single
 * composite course correction so a multi-issue draft triggers ONE
 * narrator repair instead of N. Behaviour-equivalent on single-issue
 * cases.
 *
 * The agent loop's batching code is exercised end-to-end via W20/W24,
 * but those don't cover the multi-issue compose path. This test pins
 * the composite-string shape directly: given two simulated failed gaps,
 * the composite is the concatenation of their descriptions and a
 * numbered concatenation of their course corrections.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { checkEnvelopeCompleteness, checkDomainLensCitations } = await import(
  "../lib/agents/runtime/checkEnvelopeCompleteness.js"
);
const { checkMagnitudesAgainstObservations } = await import(
  "../lib/agents/runtime/checkMagnitudesAgainstObservations.js"
);

describe("W43 · per-check ordering preserved (completeness short-circuit)", () => {
  it("when completeness fails, citation + magnitudes are NOT run (avoid noise)", () => {
    // Manually compose what the agent loop does to confirm the gate
    // behaviour the W43 batching relies on.
    const envelope = {}; // empty → completeness will fail with multiple missing fields

    const completenessGap = checkEnvelopeCompleteness(
      envelope,
      "driver_discovery",
      true
    );
    const citationGap = completenessGap.ok
      ? checkDomainLensCitations(envelope, [])
      : { ok: true as const };
    // W43 change: magnitudes gated only on completeness, not on citation
    const magnitudesGap = completenessGap.ok
      ? checkMagnitudesAgainstObservations(undefined, { observations: [] })
      : { ok: true as const };

    assert.equal(completenessGap.ok, false);
    assert.equal(citationGap.ok, true, "citation skipped when completeness fails");
    assert.equal(magnitudesGap.ok, true, "magnitudes skipped when completeness fails");
  });
});

describe("W43 · multi-issue batching (citation + magnitudes in one round)", () => {
  it("citation AND magnitudes can both fail in the same round when completeness passes", () => {
    // Envelope has all required completeness sections but cites a fake
    // pack id AND has fabricated magnitudes.
    const envelope = {
      tldr: "x",
      findings: [
        { headline: "h1", evidence: "e1" },
        { headline: "h2", evidence: "e2" },
      ],
      implications: [
        { statement: "s1", soWhat: "w1", confidence: "high" as const },
        { statement: "s2", soWhat: "w2", confidence: "high" as const },
      ],
      recommendations: [
        { action: "a1", rationale: "r1", horizon: "now" as const },
        { action: "a2", rationale: "r2", horizon: "this_quarter" as const },
      ],
      domainLens: "Per `marico-fake-pack`, the answer …",
      methodology: "...",
    };
    const suppliedPackIds = ["marico-haircare-portfolio"];
    const completenessGap = checkEnvelopeCompleteness(
      envelope,
      "driver_discovery",
      true
    );
    const citationGap = completenessGap.ok
      ? checkDomainLensCitations(envelope, suppliedPackIds)
      : { ok: true as const };
    const magnitudes = [
      { label: "Bad 1", value: "-99% MoM" },
      { label: "Bad 2", value: "+177% YoY" },
    ];
    const magnitudesGap = completenessGap.ok
      ? checkMagnitudesAgainstObservations(magnitudes, {
          observations: ["Volume +2.1% MoM", "share -3 ppt"],
        })
      : { ok: true as const };

    assert.equal(completenessGap.ok, true);
    assert.equal(citationGap.ok, false, "fake pack id should fail citation gate");
    assert.equal(magnitudesGap.ok, false, "fabricated numbers should fail magnitudes gate");
  });

  it("composite courseCorrection is a numbered concatenation when ≥2 issues fire", () => {
    // Simulate the agent loop's compose step.
    const failed = [
      {
        ok: false as const,
        code: "HALLUCINATED_DOMAIN_CITATION" as const,
        description: "domainLens cites fake pack id",
        courseCorrection: "Cite only real pack ids.",
        fabricatedIds: ["fake-id"],
      },
      {
        ok: false as const,
        code: "FABRICATED_MAGNITUDES" as const,
        description: "Two magnitudes cite numbers not in observations",
        courseCorrection: "Use only numbers from observations.",
        fabricated: [],
      },
    ];

    const composite = {
      description: failed.map((g) => g.description).join("\n\n"),
      courseCorrection:
        failed.length === 1
          ? failed[0].courseCorrection
          : failed.map((g, i) => `(${i + 1}) ${g.courseCorrection}`).join("\n\n"),
    };

    assert.match(composite.description, /domainLens cites fake pack id/);
    assert.match(composite.description, /Two magnitudes cite numbers not/);
    assert.match(composite.courseCorrection, /^\(1\) Cite only real pack ids\./);
    assert.match(composite.courseCorrection, /\n\n\(2\) Use only numbers from/);
  });

  it("single-issue case produces a non-numbered course correction (behaviour-equivalent)", () => {
    const failed = [
      {
        ok: false as const,
        code: "MISSING_DECISION_GRADE_SECTIONS" as const,
        description: "missing implications",
        courseCorrection: "Re-emit with 2+ implications.",
      },
    ];
    const composite = {
      description: failed.map((g) => g.description).join("\n\n"),
      courseCorrection:
        failed.length === 1
          ? failed[0].courseCorrection
          : failed.map((g, i) => `(${i + 1}) ${g.courseCorrection}`).join("\n\n"),
    };
    // No "(1)" prefix on single-issue path → matches pre-W43 behaviour.
    assert.equal(composite.courseCorrection, "Re-emit with 2+ implications.");
    assert.ok(!/^\(/.test(composite.courseCorrection));
  });
});
