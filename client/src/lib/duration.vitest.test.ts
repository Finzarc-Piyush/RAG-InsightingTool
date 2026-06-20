import { describe, expect, it } from "vitest";
import { formatHoursAsDuration } from "./duration";

describe("formatHoursAsDuration", () => {
  it("formats hm (default), rounding to the minute", () => {
    expect(formatHoursAsDuration(3.5325)).toBe("3h 32m");
    expect(formatHoursAsDuration(0)).toBe("0h 00m");
    expect(formatHoursAsDuration(8)).toBe("8h 00m");
  });
  it("formats hms and decimal", () => {
    expect(formatHoursAsDuration(3.5325, "hms")).toBe("03:31:57");
    expect(formatHoursAsDuration(3.5325, "decimal")).toBe("3.53h");
  });
  it("renders non-finite / null as em-dash", () => {
    expect(formatHoursAsDuration(null)).toBe("—");
    expect(formatHoursAsDuration(undefined)).toBe("—");
    expect(formatHoursAsDuration(NaN)).toBe("—");
  });
});
