import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forecastSeries } from "../lib/forecasting/forecastSeries.js";

/**
 * Wave F1 · Pins the pure-Node forecaster's contract.
 *
 * - Linear trend extrapolation produces directionally-correct forecasts.
 * - Auto-detected seasonality reduces residual variance.
 * - Confidence intervals widen with horizon (sqrt(h) scaling).
 * - Refuses inputs that can't ground a forecast (< 4 observations,
 *   non-finite horizon).
 */

describe("Wave F1 · forecastSeries — happy paths", () => {
  it("perfectly linear upward trend → forecast extends the line", () => {
    // y = 10*i + 100 for i in [0, 7]
    const history = Array.from({ length: 8 }, (_, i) => ({
      label: `2024-${String(i + 1).padStart(2, "0")}`,
      value: 10 * i + 100,
    }));
    const result = forecastSeries({ history, horizon: 3, seasonality: "none" });
    assert.ok(result.ok);
    if (result.ok) {
      // Slope 10, intercept 100, next index 8: 180; 9: 190; 10: 200.
      assert.ok(Math.abs(result.forecast[0].pointForecast - 180) < 1e-6);
      assert.ok(Math.abs(result.forecast[1].pointForecast - 190) < 1e-6);
      assert.ok(Math.abs(result.forecast[2].pointForecast - 200) < 1e-6);
      // Trend R² = 1 (perfect fit).
      assert.ok(result.trendR2 > 0.99);
      assert.equal(result.method, "linear_trend");
      assert.equal(result.residualStd, 0);
    }
  });

  it("flat series → forecast equals the mean, CI = 0 (no variance)", () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      label: `M${i}`,
      value: 50,
    }));
    const result = forecastSeries({ history, horizon: 2, seasonality: "none" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.forecast[0].pointForecast, 50);
      assert.equal(result.forecast[0].lowerCI, 50);
      assert.equal(result.forecast[0].upperCI, 50);
    }
  });

  it("CI widens with horizon (sqrt(h) scaling)", () => {
    // Slight noise around a linear trend so residualStd > 0.
    const history = [
      { label: "M1", value: 100 },
      { label: "M2", value: 110 },
      { label: "M3", value: 119 },
      { label: "M4", value: 131 },
      { label: "M5", value: 140 },
      { label: "M6", value: 152 },
    ];
    const result = forecastSeries({ history, horizon: 4, seasonality: "none" });
    assert.ok(result.ok);
    if (result.ok) {
      const widths = result.forecast.map((f) => f.upperCI - f.lowerCI);
      // Strictly monotonic widening — sqrt(1), sqrt(2), sqrt(3), sqrt(4)
      for (let i = 1; i < widths.length; i++) {
        assert.ok(widths[i] > widths[i - 1]);
      }
      // Width at h=4 ≈ 2× width at h=1 (sqrt(4)/sqrt(1) = 2).
      assert.ok(widths[3] / widths[0] > 1.9);
      assert.ok(widths[3] / widths[0] < 2.1);
    }
  });
});

describe("Wave F1 · seasonality auto-detection", () => {
  it("detects quarterly (period=4) when a pronounced 4-period sine wave overlays the trend", () => {
    // 16 quarters with a strong 4-period seasonal pattern + mild trend.
    // Seasonal pattern: +30, -30, +20, -20 repeating.
    const seasonal = [30, -30, 20, -20];
    const history = Array.from({ length: 16 }, (_, i) => ({
      label: `Q${i}`,
      value: 100 + 5 * i + seasonal[i % 4]!,
    }));
    const result = forecastSeries({ history, horizon: 4, seasonality: "auto" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.method, "linear_trend_plus_seasonal");
      assert.equal(result.seasonalPeriod, 4);
    }
  });

  it("explicit seasonality=12 forces monthly seasonality when ≥ 24 observations", () => {
    const history = Array.from({ length: 24 }, (_, i) => ({
      label: `M${i}`,
      value: 100 + (i % 12) * 5,
    }));
    const result = forecastSeries({ history, horizon: 6, seasonality: 12 });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.seasonalPeriod, 12);
    }
  });

  it("seasonality=none skips detection even when a strong pattern exists", () => {
    const seasonal = [30, -30, 20, -20];
    const history = Array.from({ length: 16 }, (_, i) => ({
      label: `Q${i}`,
      value: 100 + 5 * i + seasonal[i % 4]!,
    }));
    const result = forecastSeries({ history, horizon: 4, seasonality: "none" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.method, "linear_trend");
      assert.equal(result.seasonalPeriod, undefined);
    }
  });
});

describe("Wave F1 · rejections", () => {
  it("rejects < 4 observations", () => {
    const result = forecastSeries({
      history: [{ label: "a", value: 1 }, { label: "b", value: 2 }],
      horizon: 4,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /at least 4/);
  });

  it("rejects horizon=0 or > 120", () => {
    const h = Array.from({ length: 8 }, (_, i) => ({ label: `M${i}`, value: i }));
    assert.equal(forecastSeries({ history: h, horizon: 0 }).ok, false);
    assert.equal(forecastSeries({ history: h, horizon: 121 }).ok, false);
  });

  it("skips null / non-finite values during cleanup", () => {
    const history = [
      { label: "M1", value: 100 },
      { label: "M2", value: null },
      { label: "M3", value: 120 },
      { label: "M4", value: NaN },
      { label: "M5", value: 140 },
      { label: "M6", value: 160 },
    ];
    const result = forecastSeries({
      history,
      horizon: 2,
      seasonality: "none",
    });
    assert.ok(result.ok);
    if (result.ok) {
      // Only 4 finite values pass: [100, 120, 140, 160]. Trend slope = 20.
      // Next index after the 4 cleaned values: 4, 5 → 180, 200.
      assert.ok(Math.abs(result.forecast[0].pointForecast - 180) < 1e-6);
      assert.ok(Math.abs(result.forecast[1].pointForecast - 200) < 1e-6);
    }
  });
});
