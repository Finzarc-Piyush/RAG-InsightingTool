/**
 * PVT6 · pin the recalibrated enrichment ETA estimator.
 *
 * Pre-fix: rowTerm capped at 22s alone for 10k+ rows, low band ~45-58s,
 * high band ~70-82s — 2-3× the observed wall-clock (~15s for a 10k × 44
 * dataset). Users distrust the app when ETAs are this far off.
 *
 * New formula targets the centre at ~15-27s for the typical FMCG shape.
 */
import { describe, it, expect } from "vitest";
import { estimateBand } from "./DatasetEnrichmentLoader";

describe("PVT6 · estimateBand", () => {
  it("centres on observed ~15s for the Marico-shape 10k × 44 dataset", () => {
    const { low, high } = estimateBand(10006, 44);
    expect(low).toBeGreaterThanOrEqual(13);
    expect(low).toBeLessThanOrEqual(17);
    expect(high).toBeGreaterThanOrEqual(low + 6);
    expect(high).toBeLessThanOrEqual(30);
  });

  it("scales gracefully for small datasets (1k × 26)", () => {
    const { low, high } = estimateBand(1000, 26);
    expect(low).toBeGreaterThanOrEqual(8);
    expect(low).toBeLessThanOrEqual(15);
    expect(high).toBeLessThanOrEqual(28);
  });

  it("does not run away for very large datasets (100k × 100)", () => {
    const { low, high } = estimateBand(100_000, 100);
    expect(low).toBeLessThanOrEqual(20);
    expect(high).toBeLessThanOrEqual(35);
  });

  it("trims band for late-stage steps", () => {
    const base = estimateBand(10000, 44);
    const buildingContext = estimateBand(10000, 44, "building_context");
    const persisting = estimateBand(10000, 44, "persisting");
    expect(buildingContext.low).toBeLessThanOrEqual(base.low);
    expect(persisting.low).toBeLessThan(buildingContext.low);
  });

  it("guards low against zero and tiny inputs", () => {
    const { low, high } = estimateBand(0, 0);
    expect(low).toBeGreaterThanOrEqual(8);
    expect(high).toBeGreaterThan(low);
  });
});
