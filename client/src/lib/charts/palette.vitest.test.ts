import { describe, expect, it } from "vitest";
import {
  qualitativeColor,
  sequentialColor,
  divergingColor,
  qualitativePalette,
  sequentialPalette,
  divergingPalette,
  QUALITATIVE_PALETTE_SIZE,
  SEQUENTIAL_PALETTE_SIZE,
  DIVERGING_PALETTE_SIZE,
} from "./palette";

describe("palette · qualitative", () => {
  it("returns hsl(var(--chart-N)) for each index", () => {
    expect(qualitativeColor(0)).toBe("hsl(var(--chart-1))");
    expect(qualitativeColor(1)).toBe("hsl(var(--chart-2))");
    expect(qualitativeColor(11)).toBe("hsl(var(--chart-12))");
    expect(qualitativeColor(23)).toBe("hsl(var(--chart-24))");
  });

  it("wraps at the palette size (cycles)", () => {
    expect(qualitativeColor(QUALITATIVE_PALETTE_SIZE)).toBe("hsl(var(--chart-1))");
    expect(qualitativeColor(QUALITATIVE_PALETTE_SIZE + 1)).toBe("hsl(var(--chart-2))");
    expect(qualitativeColor(2 * QUALITATIVE_PALETTE_SIZE)).toBe("hsl(var(--chart-1))");
  });

  it("handles negative indices via modulo", () => {
    expect(qualitativeColor(-1)).toBe(`hsl(var(--chart-${QUALITATIVE_PALETTE_SIZE}))`);
    expect(qualitativeColor(-QUALITATIVE_PALETTE_SIZE)).toBe("hsl(var(--chart-1))");
  });

  it("qualitativePalette() returns one string per palette color by default", () => {
    const p = qualitativePalette();
    expect(p.length).toBe(QUALITATIVE_PALETTE_SIZE);
    expect(p[0]).toBe("hsl(var(--chart-1))");
    expect(p[QUALITATIVE_PALETTE_SIZE - 1]).toBe(
      `hsl(var(--chart-${QUALITATIVE_PALETTE_SIZE}))`
    );
  });
});

describe("palette · sequential", () => {
  it("clamps input to [0,1]", () => {
    expect(sequentialColor(-0.5)).toBe("hsl(var(--chart-seq-1))");
    expect(sequentialColor(0)).toBe("hsl(var(--chart-seq-1))");
    expect(sequentialColor(1)).toBe(`hsl(var(--chart-seq-${SEQUENTIAL_PALETTE_SIZE}))`);
    expect(sequentialColor(1.5)).toBe(`hsl(var(--chart-seq-${SEQUENTIAL_PALETTE_SIZE}))`);
  });

  it("midpoint maps to middle step", () => {
    expect(sequentialColor(0.5)).toBe("hsl(var(--chart-seq-5))");
  });

  it("returns mid step for NaN", () => {
    expect(sequentialColor(NaN)).toBe("hsl(var(--chart-seq-5))");
  });

  it("sequentialPalette(N) returns N evenly spaced strings", () => {
    const p = sequentialPalette(3);
    expect(p.length).toBe(3);
    expect(p[0]).toBe("hsl(var(--chart-seq-1))");
    expect(p[2]).toBe(`hsl(var(--chart-seq-${SEQUENTIAL_PALETTE_SIZE}))`);
  });
});

describe("palette · diverging", () => {
  it("center maps to step 6 (neutral)", () => {
    expect(divergingColor(0)).toBe("hsl(var(--chart-div-6))");
  });

  it("extremes map to step 1 and step 11", () => {
    expect(divergingColor(-1)).toBe("hsl(var(--chart-div-1))");
    expect(divergingColor(1)).toBe(`hsl(var(--chart-div-${DIVERGING_PALETTE_SIZE}))`);
  });

  it("clamps out-of-range values", () => {
    expect(divergingColor(-3)).toBe("hsl(var(--chart-div-1))");
    expect(divergingColor(3)).toBe(`hsl(var(--chart-div-${DIVERGING_PALETTE_SIZE}))`);
  });

  it("returns center for NaN", () => {
    expect(divergingColor(NaN)).toBe("hsl(var(--chart-div-6))");
  });

  it("divergingPalette(N) returns N strings starting and ending at extremes", () => {
    const p = divergingPalette(5);
    expect(p.length).toBe(5);
    expect(p[0]).toBe("hsl(var(--chart-div-1))");
    expect(p[4]).toBe(`hsl(var(--chart-div-${DIVERGING_PALETTE_SIZE}))`);
  });
});
