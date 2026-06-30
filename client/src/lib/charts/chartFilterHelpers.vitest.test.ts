import { describe, expect, it } from "vitest";
import { formatAxisLabelFieldBlind } from "./chartFilterHelpers";

describe("chartFilterHelpers · formatAxisLabelFieldBlind (Indian: Cr / Lac / K)", () => {
  it("uses Indian magnitude tiers with a spaced suffix", () => {
    expect(formatAxisLabelFieldBlind(1234)).toBe("1.23 K");
    expect(formatAxisLabelFieldBlind(50_000)).toBe("50 K");
    expect(formatAxisLabelFieldBlind(2_400_000)).toBe("24 Lac");
    expect(formatAxisLabelFieldBlind(150_000_000)).toBe("15 Cr");
  });

  it("keeps the small-decimal and sub-1000 branches unchanged", () => {
    expect(formatAxisLabelFieldBlind(0.005)).toBe("0.0050");
    expect(formatAxisLabelFieldBlind(12.5)).toBe("12.50");
    expect(formatAxisLabelFieldBlind(500)).toBe("500");
  });

  it("preserves negative sign", () => {
    expect(formatAxisLabelFieldBlind(-2_400_000)).toBe("-24 Lac");
  });
});
