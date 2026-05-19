/**
 * Wave WQ8 · effect-size as fifth FindingEvidence field.
 *
 * Closes a known gap in the WQ1 classifier: before this wave the four
 * tiering signals (n, pValue, rSquared, ciRelativeWidth) could pass
 * "statistically significant but practically negligible" findings as
 * HIGH-confidence. Cohen's d / Cramér's V already buckets the effect
 * into negligible / small / medium / large on the significance-test
 * tool output; this wave plumbs that bucket through the
 * FindingEvidence → formatFindingEvidence → narrator-extractor →
 * assessConfidence chain so the classifier can grade a trivial-effect
 * finding as LOW regardless of n / p / CI.
 *
 * The classifier signal is the load-bearing piece. The formatter and
 * extractor changes exist solely so the same field survives the
 * tool-summary → blackboard-finding-detail prose roundtrip without a
 * schema migration on `Finding`.
 *
 * Test layout:
 *  1) assessConfidence — negligible effect is a hard-fail LOW signal
 *     even when n / p / CI / R² individually pass HIGH thresholds.
 *  2) assessConfidence — "large" effect contributes a HIGH reason;
 *     "medium" / "small" surface as MEDIUM reasons; effect alone is
 *     enough evidence to leave the "no statistical evidence" default.
 *  3) formatEvidenceForFindingDetail — emits the `effect = X` token
 *     in canonical order (after the CI block, inside the parens).
 *  4) extractFindingEvidence — recovers the bucket from prose; tolerant
 *     of `effect =`, `effect:`, `effect-size:`, `effect_magnitude:`.
 *  5) Roundtrip — formatter + extractor preserve effectMagnitude.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  assessConfidence,
  type FindingEvidence,
} from "../lib/agents/runtime/scaleNarrativeByConfidence.js";
import {
  composeFindingDetail,
  formatEvidenceForFindingDetail,
} from "../lib/agents/runtime/formatFindingEvidence.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";

describe("Wave WQ8 · assessConfidence — negligible effect overrides HIGH-passing fields", () => {
  it("downgrades to LOW when effect is negligible even with strong n / p / CI / R²", () => {
    const ev: FindingEvidence = {
      n: 5000,
      pValue: 0.0001,
      ciRelativeWidth: 0.05,
      rSquared: 0.92,
      effectMagnitude: "negligible",
    };
    const a = assessConfidence(ev);
    assert.equal(a.tier, "low");
    assert.ok(
      a.reasons.some((r) => /negligible effect size/i.test(r)),
      `LOW reasons must mention negligible effect; got ${a.reasons.join(" | ")}`,
    );
  });

  it("downgrades to LOW when effect is negligible and ONLY effect is supplied", () => {
    const a = assessConfidence({ effectMagnitude: "negligible" });
    assert.equal(a.tier, "low");
  });

  it("downgrades to LOW when effect is negligible and p is also weak (both reasons)", () => {
    const a = assessConfidence({ pValue: 0.4, effectMagnitude: "negligible" });
    assert.equal(a.tier, "low");
    // Both signals should surface in reasons — neither is hidden by the other.
    assert.ok(
      a.reasons.some((r) => /weak significance/i.test(r)),
      "weak p must appear in reasons alongside negligible effect",
    );
    assert.ok(
      a.reasons.some((r) => /negligible effect/i.test(r)),
      "negligible effect must appear in reasons alongside weak p",
    );
  });
});

describe("Wave WQ8 · assessConfidence — non-negligible effect contributes to tiering", () => {
  it("'large' effect with strong p / n yields HIGH and mentions the effect bucket", () => {
    const a = assessConfidence({ n: 200, pValue: 0.001, effectMagnitude: "large" });
    assert.equal(a.tier, "high");
    assert.ok(
      a.reasons.some((r) => /large effect/i.test(r)),
      `HIGH reasons must mention large effect; got ${a.reasons.join(" | ")}`,
    );
  });

  it("'medium' effect with strong p / n yields HIGH and mentions the effect bucket", () => {
    const a = assessConfidence({ n: 200, pValue: 0.001, effectMagnitude: "medium" });
    assert.equal(a.tier, "high");
    assert.ok(
      a.reasons.some((r) => /medium effect/i.test(r)),
      `HIGH reasons must mention medium effect; got ${a.reasons.join(" | ")}`,
    );
  });

  it("'small' effect (with otherwise HIGH-passing fields) drops to MEDIUM", () => {
    // 'small' fails the high-passes gate; finding lands in the catch-all medium
    // branch where the small-effect reason surfaces.
    const a = assessConfidence({ n: 200, pValue: 0.001, effectMagnitude: "small" });
    assert.equal(a.tier, "medium");
    assert.ok(
      a.reasons.some((r) => /small effect/i.test(r)),
      `MEDIUM reasons must mention small effect; got ${a.reasons.join(" | ")}`,
    );
  });

  it("effectMagnitude alone counts as evidence (no longer 'no evidence supplied')", () => {
    // 'small' alone — no other signals. Should NOT default to the
    // "no statistical evidence supplied" reason.
    const a = assessConfidence({ effectMagnitude: "small" });
    assert.notEqual(a.tier, undefined);
    assert.ok(
      !a.reasons.some((r) => /no statistical evidence/i.test(r)),
      `effectMagnitude must register as evidence; got ${a.reasons.join(" | ")}`,
    );
  });

  it("undefined effect leaves classifier behaviour unchanged (pre-WQ8 baseline)", () => {
    // Pre-WQ8: { n: 200, p: 0.001 } → HIGH with two reasons.
    const a = assessConfidence({ n: 200, pValue: 0.001 });
    assert.equal(a.tier, "high");
    assert.ok(a.reasons.some((r) => /solid sample/i.test(r)));
    assert.ok(a.reasons.some((r) => /statistically significant/i.test(r)));
    // No effect mention when none was supplied.
    assert.ok(!a.reasons.some((r) => /effect size/i.test(r)));
  });
});

describe("Wave WQ8 · formatEvidenceForFindingDetail emits 'effect = X' token", () => {
  it("appends effect token after CI in the parenthesised block", () => {
    const out = formatEvidenceForFindingDetail({
      n: 850,
      pValue: 0.01,
      rSquared: 0.71,
      ciRelativeWidth: 0.15,
      effectMagnitude: "large",
    });
    assert.match(
      out,
      /^ \(n = 850; p = 0\.01; R² = 0\.71; ±15% of the estimate; effect = large\)$/,
    );
  });

  it("emits just the effect token when only effect is supplied", () => {
    const out = formatEvidenceForFindingDetail({ effectMagnitude: "negligible" });
    assert.equal(out, " (effect = negligible)");
  });

  it("emits all four magnitude buckets verbatim", () => {
    const buckets: Array<FindingEvidence["effectMagnitude"]> = [
      "negligible",
      "small",
      "medium",
      "large",
    ];
    for (const bucket of buckets) {
      const out = formatEvidenceForFindingDetail({ effectMagnitude: bucket });
      assert.equal(out, ` (effect = ${bucket})`);
    }
  });

  it("ignores unrecognised effectMagnitude values defensively", () => {
    // TS type-blocks this in normal code; cast forces a runtime sanity check.
    const out = formatEvidenceForFindingDetail({
      effectMagnitude: "huge" as unknown as FindingEvidence["effectMagnitude"],
    });
    assert.equal(out, "");
  });
});

describe("Wave WQ8 · extractFindingEvidence recovers effectMagnitude from prose", () => {
  it("recovers from 'effect = large' (canonical formatter output)", () => {
    const ev = extractFindingEvidence("Driver fit. (n = 200; p = 0.001; effect = large)");
    assert.equal(ev.effectMagnitude, "large");
  });

  it("recovers from 'effect: medium' (free prose with colon)", () => {
    const ev = extractFindingEvidence("The effect: medium across the sample.");
    assert.equal(ev.effectMagnitude, "medium");
  });

  it("recovers from 'effect-size: small'", () => {
    const ev = extractFindingEvidence("Effect-size: small for this segment.");
    assert.equal(ev.effectMagnitude, "small");
  });

  it("recovers from 'effect_magnitude: negligible' (tool-table column name)", () => {
    const ev = extractFindingEvidence("Test ran. effect_magnitude: negligible across groups.");
    assert.equal(ev.effectMagnitude, "negligible");
  });

  it("returns undefined when no effect mention is present", () => {
    const ev = extractFindingEvidence("Plain finding with no effect mention.");
    assert.equal(ev.effectMagnitude, undefined);
  });

  it("ignores unrecognised effect words", () => {
    const ev = extractFindingEvidence("Driver fit. (effect = enormous)");
    assert.equal(ev.effectMagnitude, undefined);
  });
});

describe("Wave WQ8 · roundtrip — formatter + extractor preserve effectMagnitude", () => {
  const cases: Array<{ name: string; ev: FindingEvidence }> = [
    { name: "negligible alone", ev: { effectMagnitude: "negligible" } },
    { name: "large alone", ev: { effectMagnitude: "large" } },
    { name: "all five fields", ev: { n: 60, pValue: 0.04, rSquared: 0.55, ciRelativeWidth: 0.2, effectMagnitude: "medium" } },
    { name: "small + n only", ev: { n: 25, effectMagnitude: "small" } },
  ];
  for (const { name, ev } of cases) {
    it(`recovers ${name}`, () => {
      const detail = composeFindingDetail("Some context.", ev);
      const recovered = extractFindingEvidence(detail);
      assert.equal(recovered.effectMagnitude, ev.effectMagnitude);
      if (ev.n !== undefined) assert.equal(recovered.n, Math.round(ev.n));
    });
  }
});
