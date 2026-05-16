/**
 * Wave WV6 · `run_price_elasticity` migrated to WV2's `composeFindingDetail`.
 *
 * Third per-tool migration in the WV4 series. Where WV4 covered correlation's
 * R² + n and WV5 covered significance-test p + n, WV6 covers price-elasticity
 * R² + n (the headline group's fit when groupColumn is set, otherwise the
 * single global fit). Closes the dormancy debt for elasticity findings.
 *
 * Coverage:
 *  - Both summary branches (single-fit + per-group) now end with the
 *    canonical evidence suffix.
 *  - Roundtrip: extractFindingEvidence on the full summary recovers n + R²
 *    modulo display rounding.
 *  - Source-inspection wiring asserts composeFindingDetail import +
 *    wv6EvidenceSuffix variable + use on both summary branches.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runPriceElasticity } from "../lib/agents/runtime/tools/priceElasticityTool.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Wave WV6 · run_price_elasticity emits canonical FindingEvidence suffix (single fit)", () => {
  it("no-group success summary ends with canonical ' (n = N; R² = X.XX)'", () => {
    // Constructed price/quantity data with a clean negative elasticity ≈ -2.
    // q = price^(-2) → log(q) = -2 · log(price). N=20.
    const N = 20;
    const data = Array.from({ length: N }, (_, i) => {
      const price = 1 + i * 0.5; // 1.0, 1.5, ..., 10.5
      const quantity = Math.pow(price, -2);
      return { price, quantity };
    });
    const result = runPriceElasticity(data, {
      priceColumn: "price",
      quantityColumn: "quantity",
      minObservations: 6,
    });
    assert.equal(result.ok, true);
    // Canonical suffix appears at the end. R² should be ~1.0 for clean data.
    assert.match(result.summary, / \(n = 20; R² = [01]\.\d{2}\)$/);
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.n, 20);
    assert.ok(recovered.rSquared !== undefined, "R² recovered from summary");
    // Clean power-law data fits the log-log model exactly → R² ≈ 1.
    assert.ok(
      recovered.rSquared! >= 0.99,
      `expected R² ≈ 1 for clean log-log data, got ${recovered.rSquared}`,
    );
  });
});

describe("Wave WV6 · run_price_elasticity emits canonical FindingEvidence suffix (per-group)", () => {
  it("groupColumn success summary ends with canonical suffix for the most-elastic group", () => {
    const data: Record<string, any>[] = [];
    // Group A: elasticity ≈ -2 (more elastic), 15 obs
    for (let i = 0; i < 15; i++) {
      const price = 1 + i * 0.5;
      data.push({ price, quantity: Math.pow(price, -2), sku: "A" });
    }
    // Group B: elasticity ≈ -0.5 (less elastic), 15 obs
    for (let i = 0; i < 15; i++) {
      const price = 1 + i * 0.5;
      data.push({ price, quantity: Math.pow(price, -0.5), sku: "B" });
    }
    const result = runPriceElasticity(data, {
      priceColumn: "price",
      quantityColumn: "quantity",
      groupColumn: "sku",
      minObservations: 6,
    });
    assert.equal(result.ok, true);
    // Most elastic is A (|β| = 2 vs 0.5). Suffix uses A's n + R².
    assert.match(result.summary, / \(n = 15; R² = [01]\.\d{2}\)$/);
    const recovered = extractFindingEvidence(result.summary);
    assert.equal(recovered.n, 15);
    assert.ok(recovered.rSquared !== undefined);
  });
});

describe("Wave WV6 · source-inspection wiring", () => {
  it("priceElasticityTool.ts imports composeFindingDetail + FindingEvidence", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/tools/priceElasticityTool.ts"),
      "utf8",
    );
    assert.ok(
      src.includes('from "../formatFindingEvidence.js"'),
      "priceElasticityTool.ts must import composeFindingDetail",
    );
    assert.ok(
      src.includes("import type { FindingEvidence }"),
      "priceElasticityTool.ts must import the FindingEvidence type",
    );
  });

  it("both summary branches concatenate wv6EvidenceSuffix", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/tools/priceElasticityTool.ts"),
      "utf8",
    );
    assert.ok(
      src.includes("wv6EvidenceSuffix"),
      "must construct wv6EvidenceSuffix",
    );
    // Count concatenations onto a summary template — should appear in both
    // the args.groupColumn branch AND the no-group branch.
    const concatCount = (src.match(/wv6EvidenceSuffix/g) ?? []).length;
    assert.ok(
      concatCount >= 3,
      `expected ≥3 references to wv6EvidenceSuffix (1 assignment + 2 concatenations), saw ${concatCount}`,
    );
  });
});
