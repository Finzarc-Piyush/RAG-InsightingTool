/**
 * Wave WV6-bucket · `bucketPriceElasticity` + end-to-end wiring through
 * `runPriceElasticity` into the canonical FindingEvidence suffix.
 *
 * Mirrors `runCorrelationEffectMagnitudeWV4Bucket.test.ts` but on the
 * elasticity-coefficient side: maps fitted |β| (with the significance
 * flag) onto the four-bucket effectMagnitude taxonomy so the downstream
 * WQ1 confidence classifier can distinguish "highly inelastic with tight
 * n" (real but practically negligible response) from "highly elastic
 * with tight n" (real and large).
 *
 * Coverage:
 *   1. Pure-fn `bucketPriceElasticity` pins (boundary + sign + sig flag).
 *   2. Roundtrip: `composeFindingDetail` emits "effect = X" → `extractFindingEvidence`
 *      recovers the bucket.
 *   3. End-to-end: `runPriceElasticity` on clean log-log data emits a
 *      summary whose canonical suffix carries "effect = large" for β ≈ -2.
 *   4. End-to-end: the per-group branch carries the bucket on the headline.
 *   5. Anomalous-positive-β: bucket omitted from the suffix (returns null,
 *      so the field is dropped rather than misleading).
 *
 * No new convention codified — third per-tool bucket migration after
 * WV4-bucket (correlation) and the family of WQ8 bucket emitters for
 * Cohen-d / Cramér-V on significance tests. Two siblings ship the same
 * pattern; the soft convention "magnitude bucket lives next to the
 * fit function that produces the coefficient" is implicit from the
 * placement in `priceElasticityTool.ts` next to `interpretElasticity`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  bucketPriceElasticity,
  runPriceElasticity,
} from "../lib/agents/runtime/tools/priceElasticityTool.js";
import { composeFindingDetail } from "../lib/agents/runtime/formatFindingEvidence.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";

// ─────────────────────────── bucketPriceElasticity ───────────────────────────

describe("Wave WV6-bucket · bucketPriceElasticity · threshold pins", () => {
  it("not significant → negligible (regardless of β magnitude)", () => {
    // Loud β with insignificant t-stat is "no measurable response"; the
    // WQ1 classifier should downgrade narrative.
    assert.equal(bucketPriceElasticity(-2.5, false), "negligible");
    assert.equal(bucketPriceElasticity(-0.1, false), "negligible");
    assert.equal(bucketPriceElasticity(0.2, false), "negligible");
  });

  it("positive β (Giffen-good anomaly) → null", () => {
    // Sign anomaly. Caller decides whether to skip emitting the bucket
    // or downgrade narrative. The tool drops the field rather than
    // shipping a "large" for a positive coefficient.
    assert.equal(bucketPriceElasticity(0.5, true), null);
    assert.equal(bucketPriceElasticity(3.0, true), null);
  });

  it("non-finite β → null", () => {
    assert.equal(bucketPriceElasticity(NaN, true), null);
    assert.equal(bucketPriceElasticity(Infinity, true), null);
    assert.equal(bucketPriceElasticity(-Infinity, true), null);
  });

  it("|β| < 0.5 + significant → small (highly inelastic)", () => {
    assert.equal(bucketPriceElasticity(-0.1, true), "small");
    assert.equal(bucketPriceElasticity(-0.3, true), "small");
    assert.equal(bucketPriceElasticity(-0.49, true), "small");
  });

  it("|β| boundary at 0.5 falls to medium (closed lower bound)", () => {
    // The < 0.5 / < 1.5 ladder puts |β| = 0.5 exactly on "medium" since
    // the bucket fn uses strict less-than for the inelastic boundary.
    assert.equal(bucketPriceElasticity(-0.5, true), "medium");
  });

  it("0.5 ≤ |β| < 1.5 + significant → medium (inelastic + unit + most of elastic)", () => {
    assert.equal(bucketPriceElasticity(-0.7, true), "medium");
    assert.equal(bucketPriceElasticity(-1.0, true), "medium"); // unit elastic
    assert.equal(bucketPriceElasticity(-1.49, true), "medium");
  });

  it("|β| boundary at 1.5 falls to large (closed lower bound)", () => {
    assert.equal(bucketPriceElasticity(-1.5, true), "large");
  });

  it("|β| ≥ 1.5 + significant → large (highly elastic)", () => {
    assert.equal(bucketPriceElasticity(-1.5, true), "large");
    assert.equal(bucketPriceElasticity(-2.0, true), "large");
    assert.equal(bucketPriceElasticity(-5.0, true), "large");
  });

  it("β = 0 + significant → small (technically degenerate, but ladder-consistent)", () => {
    // |0| < 0.5 → small. A truly-zero coefficient that's also flagged
    // significant is degenerate; the bucket fn doesn't try to be smart
    // about this edge — it follows the ladder.
    assert.equal(bucketPriceElasticity(0, true), "small");
  });
});

// ─────────────────────────── Roundtrip with formatter + extractor ───────────────────────────

describe("Wave WV6-bucket · roundtrip — formatter + extractor preserve the bucket", () => {
  it("|β| ≈ 0.3 → small bucket → 'effect = small' → recovered", () => {
    const bucket = bucketPriceElasticity(-0.3, true);
    assert.equal(bucket, "small");
    const suffix = composeFindingDetail("Elasticity fit.", {
      n: 80,
      rSquared: 0.6,
      effectMagnitude: bucket!,
    });
    assert.match(suffix, /effect = small/);
    const recovered = extractFindingEvidence(suffix);
    assert.equal(recovered.effectMagnitude, "small");
    assert.equal(recovered.n, 80);
  });

  it("|β| ≈ 2.0 → large bucket → 'effect = large' → recovered", () => {
    const bucket = bucketPriceElasticity(-2.0, true);
    assert.equal(bucket, "large");
    const suffix = composeFindingDetail("Elasticity fit.", {
      n: 200,
      effectMagnitude: bucket!,
    });
    assert.match(suffix, /effect = large/);
    const recovered = extractFindingEvidence(suffix);
    assert.equal(recovered.effectMagnitude, "large");
  });

  it("not-significant → negligible → 'effect = negligible' → recovered", () => {
    const bucket = bucketPriceElasticity(-2.0, false);
    assert.equal(bucket, "negligible");
    const suffix = composeFindingDetail("Elasticity fit.", {
      effectMagnitude: bucket!,
    });
    assert.match(suffix, /effect = negligible/);
    const recovered = extractFindingEvidence(suffix);
    assert.equal(recovered.effectMagnitude, "negligible");
  });
});

// ─────────────────────────── End-to-end through runPriceElasticity ───────────────────────────

describe("Wave WV6-bucket · runPriceElasticity emits effectMagnitude on the canonical suffix", () => {
  it("clean β ≈ -2 single-fit data → 'effect = large' in the summary", () => {
    // q = price^(-2) → log(q) = -2 · log(price), N=20.
    const N = 20;
    const data = Array.from({ length: N }, (_, i) => {
      const price = 1 + i * 0.5;
      const quantity = Math.pow(price, -2);
      return { price, quantity };
    });
    const result = runPriceElasticity(data, {
      priceColumn: "price",
      quantityColumn: "quantity",
      minObservations: 6,
    });
    assert.equal(result.ok, true);
    assert.match(
      result.summary,
      /effect = large/,
      `expected 'effect = large' in summary for β ≈ -2; got: ${result.summary}`,
    );
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.effectMagnitude, "large");
  });

  it("clean β ≈ -0.3 single-fit data → 'effect = small' in the summary", () => {
    // q = price^(-0.3) → log(q) = -0.3 · log(price), N=24.
    const N = 24;
    const data = Array.from({ length: N }, (_, i) => {
      const price = 1 + i * 0.4;
      const quantity = Math.pow(price, -0.3);
      return { price, quantity };
    });
    const result = runPriceElasticity(data, {
      priceColumn: "price",
      quantityColumn: "quantity",
      minObservations: 6,
    });
    assert.equal(result.ok, true);
    assert.match(
      result.summary,
      /effect = small/,
      `expected 'effect = small' in summary for β ≈ -0.3; got: ${result.summary}`,
    );
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.effectMagnitude, "small");
  });

  it("per-group branch carries the bucket on the headline (most-elastic group)", () => {
    // Two groups: one with β ≈ -2 (large), one with β ≈ -0.4 (small).
    // The "most elastic" (largest |β|) is the headline; should emit "large".
    const data: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      const price = 1 + i * 0.5;
      data.push({ price, quantity: Math.pow(price, -2), brand: "A" });
    }
    for (let i = 0; i < 20; i++) {
      const price = 1 + i * 0.5;
      data.push({ price, quantity: Math.pow(price, -0.4), brand: "B" });
    }
    const result = runPriceElasticity(data, {
      priceColumn: "price",
      quantityColumn: "quantity",
      groupColumn: "brand",
      minObservations: 6,
    });
    assert.equal(result.ok, true);
    assert.match(
      result.summary,
      /effect = large/,
      `expected 'effect = large' on the most-elastic headline; got: ${result.summary}`,
    );
  });

  it("anomalous positive β fit → bucket omitted from suffix (no misleading magnitude)", () => {
    // q = price^(+0.5) → log(q) = +0.5 · log(price) (positive coefficient,
    // Giffen-good shape). The bucket fn returns null; the suffix should
    // not contain "effect = X" for any X.
    const N = 16;
    const data = Array.from({ length: N }, (_, i) => {
      const price = 1 + i * 0.5;
      const quantity = Math.pow(price, 0.5);
      return { price, quantity };
    });
    const result = runPriceElasticity(data, {
      priceColumn: "price",
      quantityColumn: "quantity",
      minObservations: 6,
    });
    assert.equal(result.ok, true);
    // Coefficient is positive → bucket returns null → no "effect = X" appears.
    assert.doesNotMatch(
      result.summary,
      /effect = /,
      `expected NO 'effect = X' for positive β (anomalous); got: ${result.summary}`,
    );
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.effectMagnitude, undefined);
  });
});
