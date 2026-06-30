import { describe, expect, it } from "vitest";
import { formatChartTooltipValue } from "./chartNumberFormat";

describe("chartNumberFormat · formatChartTooltipValue (Indian: Cr / Lac / K)", () => {
  it("uses Indian magnitude tiers with a spaced suffix", () => {
    expect(formatChartTooltipValue(1234)).toBe("1.23 K");
    expect(formatChartTooltipValue(50_000)).toBe("50 K");
    expect(formatChartTooltipValue(481_000)).toBe("4.81 Lac");
    expect(formatChartTooltipValue(2_400_000)).toBe("24 Lac");
    expect(formatChartTooltipValue(311_587_406.72)).toBe("31.2 Cr");
    expect(formatChartTooltipValue(1_049_389_992.94)).toBe("104.9 Cr");
  });

  it("keeps small values readable", () => {
    expect(formatChartTooltipValue(5)).toBe("5");
    expect(formatChartTooltipValue(5.5)).toBe("5.5");
    expect(formatChartTooltipValue(150)).toBe("150");
  });

  it("returns em-dash for non-numeric", () => {
    expect(formatChartTooltipValue("abc")).toBe("—");
    expect(formatChartTooltipValue(null)).toBe("—");
  });
});
