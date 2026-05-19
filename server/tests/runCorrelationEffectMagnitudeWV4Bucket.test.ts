/**
 * Wave WV4-bucket · effectMagnitude on `run_correlation` via Cohen's |r|.
 *
 * Follow-on to WQ8 (which added the categorical `effectMagnitude` channel
 * to `FindingEvidence`). WQ8 wired the channel on `run_significance_test`
 * via Cohen's d / Cramér's V; this wave extends the same pattern to
 * `run_correlation` so a correlation finding now carries enough evidence
 * for the WQ1 classifier to grade "r = 0.05 on n = 10,000" (statistically
 * real, practically negligible) as LOW — overriding p ≤ 0.05 + strong n.
 *
 * Bucket thresholds are Cohen's (1988) standard conventions for |r|:
 *   < 0.1 → negligible
 *   < 0.3 → small
 *   < 0.5 → medium
 *   ≥ 0.5 → large
 *
 * Coverage:
 *  1) `bucketCorrelationR` thresholds at every boundary + sign-invariance
 *     + defensive returns on non-finite / out-of-range input.
 *  2) Roundtrip — the strongest correlation's |r| feeds an `effectMagnitude`
 *     into the WV2 formatter and the WW2 extractor recovers it.
 *  3) Source-inspection wiring on `registerTools.ts` — the WV4 block now
 *     imports `bucketCorrelationR`, calls it on `strongest.correlation`,
 *     and conditionally sets `evidence.effectMagnitude`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { bucketCorrelationR } from "../lib/correlationMath.js";
import { composeFindingDetail } from "../lib/agents/runtime/formatFindingEvidence.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";
import type { FindingEvidence } from "../lib/agents/runtime/scaleNarrativeByConfidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Wave WV4-bucket · bucketCorrelationR · Cohen threshold pins", () => {
  it("r = 0 buckets to negligible", () => {
    assert.equal(bucketCorrelationR(0), "negligible");
  });

  it("|r| just below 0.1 → negligible; at 0.1 → small (interval [0.1, 0.3))", () => {
    assert.equal(bucketCorrelationR(0.09), "negligible");
    assert.equal(bucketCorrelationR(0.1), "small");
    assert.equal(bucketCorrelationR(0.2), "small");
  });

  it("|r| at 0.3 → medium (interval [0.3, 0.5))", () => {
    assert.equal(bucketCorrelationR(0.29), "small");
    assert.equal(bucketCorrelationR(0.3), "medium");
    assert.equal(bucketCorrelationR(0.49), "medium");
  });

  it("|r| at 0.5 and above → large", () => {
    assert.equal(bucketCorrelationR(0.5), "large");
    assert.equal(bucketCorrelationR(0.7), "large");
    assert.equal(bucketCorrelationR(1.0), "large");
  });

  it("sign-invariant — negative r buckets identically to its absolute value", () => {
    assert.equal(bucketCorrelationR(-0.05), "negligible");
    assert.equal(bucketCorrelationR(-0.25), "small");
    assert.equal(bucketCorrelationR(-0.4), "medium");
    assert.equal(bucketCorrelationR(-1), "large");
  });

  it("returns null on non-finite or out-of-range input", () => {
    assert.equal(bucketCorrelationR(NaN), null);
    assert.equal(bucketCorrelationR(Infinity), null);
    assert.equal(bucketCorrelationR(-Infinity), null);
    assert.equal(bucketCorrelationR(1.5), null);
    assert.equal(bucketCorrelationR(-1.5), null);
  });
});

describe("Wave WV4-bucket · roundtrip — formatter + extractor preserve the bucket from |r|", () => {
  const cases: Array<{ name: string; r: number; expected: "negligible" | "small" | "medium" | "large" }> = [
    { name: "negligible (r = 0.05)", r: 0.05, expected: "negligible" },
    { name: "small (r = 0.2)", r: 0.2, expected: "small" },
    { name: "medium (r = 0.4)", r: 0.4, expected: "medium" },
    { name: "large (r = 0.7)", r: 0.7, expected: "large" },
    { name: "large (anti-correlation r = -0.9)", r: -0.9, expected: "large" },
  ];
  for (const { name, r, expected } of cases) {
    it(`recovers ${name}`, () => {
      const bucket = bucketCorrelationR(r);
      assert.equal(bucket, expected);
      const evidence: FindingEvidence = {
        n: 200,
        rSquared: r * r,
        effectMagnitude: bucket!,
      };
      const detail = composeFindingDetail("Driver model fit on revenue.", evidence);
      const recovered = extractFindingEvidence(detail);
      assert.equal(recovered.effectMagnitude, expected);
      assert.equal(recovered.n, 200);
      assert.equal(recovered.rSquared!.toFixed(2), (r * r).toFixed(2));
    });
  }
});

describe("Wave WV4-bucket · WQ1 grades 'real but negligible' as LOW via the bucket", () => {
  it("a high-r² with low |r| (impossible by math) is not the test target; verify the practical anti-pattern: large n + strong p + negligible effect → LOW", async () => {
    // The load-bearing semantic — verified against the canonical WQ1
    // classifier — is that effectMagnitude="negligible" overrides any
    // HIGH-passing combination of n / p / R² / CI. Pinned in
    // effectMagnitudeFindingEvidenceWQ8.test.ts; here we only confirm
    // the bucket the wave emits aligns with that classifier contract.
    const { assessConfidence } = await import("../lib/agents/runtime/scaleNarrativeByConfidence.js");
    const ev: FindingEvidence = {
      n: 10000,
      rSquared: 0.0025, // r ≈ 0.05
      effectMagnitude: bucketCorrelationR(0.05)!,
    };
    const a = assessConfidence(ev);
    assert.equal(a.tier, "low");
    assert.ok(
      a.reasons.some((reason) => /negligible effect size/i.test(reason)),
      `LOW reasons must mention negligible effect; got ${a.reasons.join(" | ")}`,
    );
  });

  it("a large effect (|r| ≥ 0.5) on solid n yields HIGH with explicit large-effect reason", async () => {
    const { assessConfidence } = await import("../lib/agents/runtime/scaleNarrativeByConfidence.js");
    // rSquared deliberately omitted — at r = 0.7, R² = 0.49 just misses the
    // WQ1 HIGH gate (R² >= 0.5), so including it would force MEDIUM and
    // confuse the test target (which is "does the bucket itself contribute
    // to HIGH?"). The real WV4 emit path includes both rSquared AND
    // effectMagnitude; downstream classifier behaviour for that combination
    // is pinned in effectMagnitudeFindingEvidenceWQ8.test.ts.
    const ev: FindingEvidence = {
      n: 200,
      effectMagnitude: bucketCorrelationR(0.7)!,
    };
    const a = assessConfidence(ev);
    assert.equal(a.tier, "high");
    assert.ok(
      a.reasons.some((reason) => /large effect size/i.test(reason)),
      `HIGH reasons must mention large effect; got ${a.reasons.join(" | ")}`,
    );
  });
});

describe("Wave WV4-bucket · registerTools.ts wiring (source-inspection)", () => {
  const srcPath = resolve(__dirname, "../lib/agents/runtime/tools/registerTools.ts");
  const src = readFileSync(srcPath, "utf8");

  it("imports bucketCorrelationR from correlationMath", () => {
    assert.ok(
      /import\s+\{\s*bucketCorrelationR\s*\}\s+from\s+["']\.\.\/\.\.\/\.\.\/correlationMath\.js["']/.test(src),
      "registerTools.ts must import bucketCorrelationR from ../../../correlationMath.js",
    );
  });

  it("calls bucketCorrelationR on strongest.correlation inside the WV4 block", () => {
    assert.ok(
      src.includes("bucketCorrelationR(strongest.correlation)"),
      "WV4 block must call bucketCorrelationR(strongest.correlation)",
    );
  });

  it("assigns the bucket to evidence.effectMagnitude under a truthy guard", () => {
    // Guard form: `if (bucket) { evidence.effectMagnitude = bucket; }`
    // — the null return from out-of-range r must not poison the evidence.
    assert.match(
      src,
      /const\s+bucket\s*=\s*bucketCorrelationR\(strongest\.correlation\)[\s;]*\s*if\s*\(\s*bucket\s*\)\s*\{[\s\S]{0,80}evidence\.effectMagnitude\s*=\s*bucket/,
      "WV4 block must guard bucket null and assign to evidence.effectMagnitude",
    );
  });
});
