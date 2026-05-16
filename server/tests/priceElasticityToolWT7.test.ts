import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runPriceElasticity,
  priceElasticityArgsSchema,
  fitLogLogElasticity,
  interpretElasticity,
  type PriceElasticityArgs,
} from "../lib/agents/runtime/tools/priceElasticityTool.js";

const fullArgs = (overrides: Partial<PriceElasticityArgs> = {}): PriceElasticityArgs => ({
  priceColumn: "price",
  quantityColumn: "quantity",
  groupColumn: undefined,
  minObservations: 6,
  dimensionFilters: undefined,
  ...overrides,
});

/** Build a synthetic dataset where log(q) = a + b·log(p) holds exactly. */
function buildSyntheticElasticity(
  trueElasticity: number,
  trueIntercept: number,
  prices: number[],
): Array<Record<string, unknown>> {
  return prices.map((p) => ({
    price: p,
    quantity: Math.exp(trueIntercept + trueElasticity * Math.log(p)),
  }));
}

describe("WT7 · fitLogLogElasticity — pure OLS fit", () => {
  it("recovers the true slope on a noiseless log-linear dataset", () => {
    const data = buildSyntheticElasticity(-1.5, 5, [1, 2, 4, 8, 16, 32, 64]);
    const fit = fitLogLogElasticity(data, 6);
    assert.equal(fit.ok, true);
    if (!fit.ok) return;
    assert.ok(Math.abs(fit.elasticity + 1.5) < 1e-9, "slope recovers exactly");
    assert.ok(Math.abs(fit.intercept - 5) < 1e-9, "intercept recovers exactly");
    assert.ok(Math.abs(fit.r_squared - 1) < 1e-9, "R² = 1 for noiseless");
  });

  it("returns ok:false when fewer positive pairs than minObservations", () => {
    const data = buildSyntheticElasticity(-1, 0, [1, 2]);
    const fit = fitLogLogElasticity(data, 6);
    assert.equal(fit.ok, false);
    if (fit.ok) return;
    assert.match(fit.reason, /insufficient/);
  });

  it("skips rows with non-positive price or quantity", () => {
    const data = [
      { price: 1, quantity: 100 },
      { price: 2, quantity: 50 },
      { price: 0, quantity: 30 }, // skipped: price ≤ 0
      { price: 4, quantity: 25 },
      { price: 8, quantity: 12.5 },
      { price: 16, quantity: 6.25 },
      { price: 32, quantity: -1 }, // skipped: quantity ≤ 0
      { price: 64, quantity: 1.5625 },
    ];
    const fit = fitLogLogElasticity(data, 6);
    assert.equal(fit.ok, true);
    if (!fit.ok) return;
    assert.equal(fit.n, 6, "two rows skipped");
  });

  it("returns ok:false when all log-prices are identical (zero variance)", () => {
    const data = [
      { price: 5, quantity: 100 },
      { price: 5, quantity: 200 },
      { price: 5, quantity: 300 },
      { price: 5, quantity: 400 },
      { price: 5, quantity: 500 },
      { price: 5, quantity: 600 },
    ];
    const fit = fitLogLogElasticity(data, 6);
    assert.equal(fit.ok, false);
    if (fit.ok) return;
    assert.match(fit.reason, /identical/);
  });

  it("computes a near-zero standard error on noiseless data", () => {
    const data = buildSyntheticElasticity(-2, 8, [1, 2, 3, 4, 5, 6, 7, 8]);
    const fit = fitLogLogElasticity(data, 6);
    assert.equal(fit.ok, true);
    if (!fit.ok) return;
    assert.ok(fit.slope_se < 1e-12, "SE ≈ 0 for perfect fit");
  });
});

describe("WT7 · interpretElasticity — label rules", () => {
  it("flags non-significant fits", () => {
    assert.equal(interpretElasticity(-1.2, false), "not statistically significant");
  });
  it("labels |b| < 0.5 as highly inelastic", () => {
    assert.equal(interpretElasticity(-0.3, true), "highly inelastic");
  });
  it("labels |b| in [0.5, 1) as inelastic", () => {
    assert.equal(interpretElasticity(-0.7, true), "inelastic");
  });
  it("labels |b| ≈ 1 as unit elastic", () => {
    assert.equal(interpretElasticity(-1.05, true), "unit elastic");
  });
  it("labels |b| in [1.1, 2) as elastic", () => {
    assert.equal(interpretElasticity(-1.5, true), "elastic");
  });
  it("labels |b| ≥ 2 as highly elastic", () => {
    assert.equal(interpretElasticity(-2.3, true), "highly elastic");
  });
  it("flags positive coefficients as anomalous", () => {
    assert.equal(
      interpretElasticity(0.8, true),
      "anomalous (positive coefficient — possible Giffen good or data issue)",
    );
  });
});

describe("WT7 · runPriceElasticity — overall fit", () => {
  it("returns a single-row table when groupColumn omitted", () => {
    const rows = buildSyntheticElasticity(-1.5, 5, [1, 2, 4, 8, 16, 32, 64]);
    const result = runPriceElasticity(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.table.rows.length, 1);
    const out = result.table.rows[0] as Record<string, unknown>;
    assert.equal(out.elasticity, -1.5);
    assert.equal(out.r_squared, 1);
    assert.equal(out.interpretation, "elastic");
  });

  it("omits the groupColumn from output columns when not given", () => {
    const rows = buildSyntheticElasticity(-1, 5, [1, 2, 4, 8, 16, 32]);
    const result = runPriceElasticity(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(!result.table.columns.includes("group"));
    assert.equal(result.table.columns[0], "n");
  });
});

describe("WT7 · runPriceElasticity — per-group fit", () => {
  it("emits one row per group meeting minObservations", () => {
    const sku1 = buildSyntheticElasticity(-1.5, 5, [1, 2, 4, 8, 16, 32]).map((r) => ({
      ...r,
      sku: "A",
    }));
    const sku2 = buildSyntheticElasticity(-0.5, 4, [1, 2, 4, 8, 16, 32]).map((r) => ({
      ...r,
      sku: "B",
    }));
    const result = runPriceElasticity([...sku1, ...sku2], fullArgs({ groupColumn: "sku" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.table.rows.length, 2);
    const skuA = result.table.rows.find((r: any) => r.sku === "A") as Record<string, unknown>;
    const skuB = result.table.rows.find((r: any) => r.sku === "B") as Record<string, unknown>;
    assert.equal(skuA.elasticity, -1.5);
    assert.equal(skuB.elasticity, -0.5);
  });

  it("sorts groups by |elasticity| descending", () => {
    const sku1 = buildSyntheticElasticity(-0.5, 4, [1, 2, 4, 8, 16, 32]).map((r) => ({
      ...r,
      sku: "A",
    }));
    const sku2 = buildSyntheticElasticity(-2.0, 4, [1, 2, 4, 8, 16, 32]).map((r) => ({
      ...r,
      sku: "B",
    }));
    const result = runPriceElasticity([...sku1, ...sku2], fullArgs({ groupColumn: "sku" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      (result.table.rows[0] as Record<string, unknown>).sku,
      "B",
      "most-elastic group first",
    );
  });

  it("skips groups below minObservations and counts them in numericPayload", () => {
    const sku1 = buildSyntheticElasticity(-1, 4, [1, 2, 4, 8, 16, 32]).map((r) => ({
      ...r,
      sku: "A",
    }));
    const sku2 = buildSyntheticElasticity(-1, 4, [1, 2]).map((r) => ({ ...r, sku: "B" }));
    const result = runPriceElasticity([...sku1, ...sku2], fullArgs({ groupColumn: "sku" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.table.rows.length, 1, "only SKU A passes minObservations");
    const payload = JSON.parse(result.numericPayload!);
    assert.equal(payload.groupsSkipped, 1);
    assert.equal(payload.skipped[0].group, "B");
  });

  it("includes groupColumn as the first column when set", () => {
    const sku1 = buildSyntheticElasticity(-1, 4, [1, 2, 4, 8, 16, 32]).map((r) => ({
      ...r,
      sku: "A",
    }));
    const result = runPriceElasticity(sku1, fullArgs({ groupColumn: "sku" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.table.columns[0], "sku");
  });
});

describe("WT7 · runPriceElasticity — filters + failures", () => {
  it("applies dimensionFilters before bucketing", () => {
    const rows = [
      ...buildSyntheticElasticity(-1, 4, [1, 2, 4, 8, 16, 32]).map((r) => ({
        ...r,
        region: "North",
      })),
      ...buildSyntheticElasticity(-1, 4, [1, 2]).map((r) => ({ ...r, region: "South" })),
    ];
    const result = runPriceElasticity(
      rows,
      fullArgs({
        dimensionFilters: [{ column: "region", op: "in", values: ["North"] }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Only North rows are kept (6 rows → fit passes)
    const out = result.table.rows[0] as Record<string, unknown>;
    assert.equal(out.n, 6);
  });

  it("returns ok:false for empty dataset", () => {
    const result = runPriceElasticity([], fullArgs());
    assert.equal(result.ok, false);
  });

  it("returns ok:false when no group meets minObservations", () => {
    const rows = buildSyntheticElasticity(-1, 4, [1, 2]);
    const result = runPriceElasticity(rows, fullArgs());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.summary, /minimum/);
  });
});

describe("WT7 · runPriceElasticity — schema", () => {
  it("accepts valid args with defaults", () => {
    const parsed = priceElasticityArgsSchema.safeParse({
      priceColumn: "p",
      quantityColumn: "q",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.minObservations, 6);
      assert.equal(parsed.data.groupColumn, undefined);
    }
  });

  it("rejects minObservations below 3", () => {
    const parsed = priceElasticityArgsSchema.safeParse({
      priceColumn: "p",
      quantityColumn: "q",
      minObservations: 2,
    });
    assert.equal(parsed.success, false);
  });

  it("rejects unknown keys (.strict)", () => {
    const parsed = priceElasticityArgsSchema.safeParse({
      priceColumn: "p",
      quantityColumn: "q",
      bogus: true,
    });
    assert.equal(parsed.success, false);
  });
});
