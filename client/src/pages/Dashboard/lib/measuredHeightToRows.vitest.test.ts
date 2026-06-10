import { describe, expect, it } from "vitest";
import { measuredHeightToRows } from "./measuredHeightToRows";

const ROW_HEIGHT = 32;
const MARGIN: [number, number] = [16, 16];

describe("Wave S4 · measuredHeightToRows", () => {
  it("maps an exact multi-row height to the right row count", () => {
    // (320 + 16) / (32 + 16) = 336 / 48 = 7 rows exactly.
    expect(measuredHeightToRows(320, ROW_HEIGHT, MARGIN)).toBe(7);
  });

  it("ceils sub-row remainders up", () => {
    // (330 + 16) / 48 = 7.20 → 8 rows.
    expect(measuredHeightToRows(330, ROW_HEIGHT, MARGIN)).toBe(8);
  });

  it("returns the 1-row minimum for zero / negative / non-finite input", () => {
    expect(measuredHeightToRows(0, ROW_HEIGHT, MARGIN)).toBe(1);
    expect(measuredHeightToRows(-50, ROW_HEIGHT, MARGIN)).toBe(1);
    expect(measuredHeightToRows(Number.NaN, ROW_HEIGHT, MARGIN)).toBe(1);
  });

  it("is monotonic non-decreasing in measured height", () => {
    let prev = 0;
    for (const px of [10, 48, 100, 200, 500, 1000]) {
      const rows = measuredHeightToRows(px, ROW_HEIGHT, MARGIN);
      expect(rows).toBeGreaterThanOrEqual(prev);
      prev = rows;
    }
  });
});
