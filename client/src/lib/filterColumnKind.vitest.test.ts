import { describe, it, expect } from "vitest";
import { classifyFilterColumn } from "@/lib/filterColumnKind";

describe("classifyFilterColumn", () => {
  const numeric = ["Value"];
  const dates = ["Period"];
  const temporal = ["PeriodIso"]; // PeriodIso threaded via wideFormatTransform

  it("classifies derived temporal facets as 'period' (auto-detected by name)", () => {
    for (const c of [
      "Quarter · Period",
      "Year · Period",
      "Half-year · Period",
      "Month · Period",
      "Week · Period",
      "Day · Period",
    ]) {
      expect(classifyFilterColumn(c, numeric, dates, temporal)).toBe("period");
    }
  });

  it("classifies the threaded PeriodIso column as 'period'", () => {
    expect(classifyFilterColumn("PeriodIso", numeric, dates, temporal)).toBe("period");
  });

  it("keeps the raw date column as 'date' and numeric as 'numeric'", () => {
    expect(classifyFilterColumn("Period", numeric, dates, temporal)).toBe("date");
    expect(classifyFilterColumn("Value", numeric, dates, temporal)).toBe("numeric");
  });

  it("leaves genuinely categorical columns (incl. PeriodKind) as 'text'", () => {
    // PeriodKind ("quarter" / "ytd" / "latest_n") is a category, not a period.
    expect(classifyFilterColumn("PeriodKind", numeric, dates, temporal)).toBe("text");
    expect(classifyFilterColumn("Markets", numeric, dates, temporal)).toBe("text");
    expect(classifyFilterColumn("Products", numeric, dates, temporal)).toBe("text");
  });
});
