import { describe, it, expect } from "vitest";
import {
  maxRenderPointsForDensity,
  capScatterPoints,
} from "./scatterDecimation";

describe("scatterDecimation", () => {
  it("maps density to the legacy point caps", () => {
    expect(maxRenderPointsForDensity("low", 999999)).toBe(2000);
    expect(maxRenderPointsForDensity("medium", 999999)).toBe(10000);
    expect(maxRenderPointsForDensity("high", 999999)).toBe(20000);
    // `all` means no cap → returns the full length
    expect(maxRenderPointsForDensity("all", 12345)).toBe(12345);
    // unknown falls back to medium
    expect(maxRenderPointsForDensity("nope" as any, 5)).toBe(10000);
  });

  it("returns the input untouched when already under the cap", () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ i }));
    expect(capScatterPoints(rows, "low")).toBe(rows);
  });

  it("never caps under `all` density", () => {
    const rows = Array.from({ length: 50000 }, (_, i) => ({ i }));
    expect(capScatterPoints(rows, "all")).toBe(rows);
  });

  it("decimates above the cap, preserving every-Nth distribution and order", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ i }));
    const out = capScatterPoints(rows, "low"); // cap = 2000
    expect(out.length).toBeLessThanOrEqual(2000);
    // step = ceil(5000/2000) = 3 → indices 0,3,6,... matches legacy filter(idx%step===0)
    expect(out[0]).toEqual({ i: 0 });
    expect(out[1]).toEqual({ i: 3 });
    expect(out[2]).toEqual({ i: 6 });
    // strictly increasing (stable order)
    for (let k = 1; k < out.length; k++) {
      expect((out[k] as { i: number }).i).toBeGreaterThan(
        (out[k - 1] as { i: number }).i
      );
    }
  });
});
