/**
 * Pin the coarse answer-time band: monotonic in step depth, always clamped, the
 * deep/dashboard band must strictly contain the normal band, and the deep band
 * must reach minutes (the old ~38–85s undershot real multi-minute runs by 3–5×).
 */
import { describe, it, expect } from "vitest";
import { estimateAnswerBand, formatBand, formatSeconds } from "./answerTimeEstimate";

describe("estimateAnswerBand", () => {
  it("returns a sane band for a fresh turn (no steps)", () => {
    const { low, high } = estimateAnswerBand({
      dashboardActive: false,
      deepInvestigation: false,
      stepCount: 0,
    });
    expect(low).toBeGreaterThanOrEqual(6);
    expect(high).toBeGreaterThan(low + 7);
    expect(high).toBeLessThanOrEqual(120);
  });

  it("widens (non-decreasing low) as more steps are emitted", () => {
    let prevLow = 0;
    for (const stepCount of [0, 3, 6, 10, 20]) {
      const { low, high } = estimateAnswerBand({
        dashboardActive: false,
        deepInvestigation: false,
        stepCount,
      });
      expect(low).toBeGreaterThanOrEqual(prevLow);
      expect(high).toBeGreaterThan(low);
      prevLow = low;
    }
  });

  it("clamps even absurd step counts", () => {
    const { low, high } = estimateAnswerBand({
      dashboardActive: false,
      deepInvestigation: false,
      stepCount: 10_000,
    });
    expect(low).toBeLessThanOrEqual(240);
    expect(high).toBeLessThanOrEqual(360);
    expect(high).toBeGreaterThan(low);
  });

  it("deep investigation reaches minutes EARLY — before the server dashboard step", () => {
    const { low, high } = estimateAnswerBand({
      dashboardActive: false, // dashboard step not seen yet
      deepInvestigation: true, // but we already know it's deep
      stepCount: 3,
    });
    expect(low).toBeGreaterThanOrEqual(120);
    expect(high).toBeGreaterThanOrEqual(240);
  });

  it("deep/dashboard band contains the normal band", () => {
    const normal = estimateAnswerBand({
      dashboardActive: false,
      deepInvestigation: false,
      stepCount: 8,
    });
    const dash = estimateAnswerBand({
      dashboardActive: true,
      deepInvestigation: false,
      stepCount: 8,
    });
    expect(dash.low).toBeGreaterThanOrEqual(normal.low);
    expect(dash.high).toBeGreaterThanOrEqual(normal.high);
    expect(dash.low).toBeGreaterThanOrEqual(120);
  });
});

describe("formatBand", () => {
  it("renders short bands as compact seconds", () => {
    expect(formatBand(9, 28)).toBe("~9–28s");
  });

  it("renders multi-minute bands as rounded minutes", () => {
    expect(formatBand(120, 240)).toBe("~2–4 min");
  });

  it("never collapses to a zero-width minute range", () => {
    const out = formatBand(90, 95);
    expect(out).toMatch(/~\d+–\d+ min/);
    const [lo, hi] = out.replace(/[~a-z ]/g, "").split("–").map(Number);
    expect(hi).toBeGreaterThan(lo);
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
