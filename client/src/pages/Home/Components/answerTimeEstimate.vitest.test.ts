/**
 * Pin the coarse answer-time band: monotonic in step depth, always clamped,
 * and the dashboard-build band must strictly contain the normal band.
 */
import { describe, it, expect } from "vitest";
import { estimateAnswerBand, formatSeconds } from "./answerTimeEstimate";

describe("estimateAnswerBand", () => {
  it("returns a sane band for a fresh turn (no steps)", () => {
    const { low, high } = estimateAnswerBand({ dashboardActive: false, stepCount: 0 });
    expect(low).toBeGreaterThanOrEqual(6);
    expect(high).toBeGreaterThan(low + 7);
    expect(high).toBeLessThanOrEqual(120);
  });

  it("widens (non-decreasing low) as more steps are emitted", () => {
    let prevLow = 0;
    for (const stepCount of [0, 3, 6, 10, 20]) {
      const { low, high } = estimateAnswerBand({ dashboardActive: false, stepCount });
      expect(low).toBeGreaterThanOrEqual(prevLow);
      expect(high).toBeGreaterThan(low);
      prevLow = low;
    }
  });

  it("clamps even absurd step counts", () => {
    const { low, high } = estimateAnswerBand({ dashboardActive: false, stepCount: 10_000 });
    expect(low).toBeLessThanOrEqual(70);
    expect(high).toBeLessThanOrEqual(120);
    expect(high).toBeGreaterThan(low);
  });

  it("dashboard band contains the normal band", () => {
    const normal = estimateAnswerBand({ dashboardActive: false, stepCount: 8 });
    const dash = estimateAnswerBand({ dashboardActive: true, stepCount: 8 });
    expect(dash.low).toBeGreaterThanOrEqual(normal.low);
    expect(dash.high).toBeGreaterThanOrEqual(normal.high);
    expect(dash.low).toBeGreaterThanOrEqual(38);
  });
});

describe("formatSeconds", () => {
  it("formats sub-minute as seconds", () => {
    expect(formatSeconds(0)).toBe("0s");
    expect(formatSeconds(8)).toBe("8s");
    expect(formatSeconds(59)).toBe("59s");
  });

  it("formats minutes with and without remainder", () => {
    expect(formatSeconds(60)).toBe("1m");
    expect(formatSeconds(64)).toBe("1m 4s");
    expect(formatSeconds(125)).toBe("2m 5s");
  });

  it("guards negatives and fractions", () => {
    expect(formatSeconds(-5)).toBe("0s");
    expect(formatSeconds(12.9)).toBe("12s");
  });
});
