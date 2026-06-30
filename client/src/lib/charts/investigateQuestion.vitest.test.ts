import { describe, it, expect } from "vitest";
import {
  chartSubject,
  buildChartInvestigationPrompt,
} from "./investigateQuestion";

describe("C1 · buildChartInvestigationPrompt", () => {
  it("uses the chart title as the subject when present", () => {
    expect(chartSubject({ title: "Value sales by Channel" })).toBe(
      "Value sales by Channel"
    );
  });

  it("falls back to 'y by x' then to a generic label", () => {
    expect(chartSubject({ y: "Volume", x: "Region" })).toBe("Volume by Region");
    expect(chartSubject({ x: "Brand" })).toBe("Brand");
    expect(chartSubject({})).toBe("this chart");
  });

  it("produces a diagnostic + strategic prompt (drives full-depth analysis)", () => {
    const q = buildChartInvestigationPrompt({ title: "Sales by Channel" });
    // Must reference the subject and ask why + actions so the server classifies
    // it as diagnostic + strategic (full depth), not a shallow restatement.
    expect(q).toContain('Sales by Channel');
    expect(q.toLowerCase()).toContain("driving");
    expect(q.toLowerCase()).toContain("why");
    expect(q.toLowerCase()).toContain("actions should we take");
    // Never a disjunctive "or" (would be an ambiguous, unanswerable ask).
    expect(/\bor\b/i.test(q)).toBe(false);
  });

  it("includes the series dimension when present", () => {
    const q = buildChartInvestigationPrompt({
      title: "Sales trend",
      seriesColumn: "Brand",
    });
    expect(q).toContain("across Brand");
  });
});
