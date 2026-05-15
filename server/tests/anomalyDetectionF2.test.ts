import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectAnomalies } from "../lib/anomalyDetection.js";

/**
 * Wave F2 · Pins the pure-Node anomaly-detection helpers.
 *
 * IQR (Tukey) catches outliers in skewed distributions; z-score catches
 * extreme deviations under near-normal data. "both" returns the union,
 * with each anomaly tagged by the method(s) that flagged it.
 */

describe("Wave F2 · detectAnomalies · happy paths", () => {
  it("IQR flags an obvious outlier in a tightly-clustered series", () => {
    const result = detectAnomalies({
      values: [10, 11, 9, 10, 11, 12, 10, 9, 11, 100], // 100 is the spike
      method: "iqr",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.anomalies.length, 1);
      assert.equal(result.anomalies[0].value, 100);
      assert.equal(result.anomalies[0].direction, "high");
      assert.ok(result.anomalies[0].flaggedBy.includes("iqr"));
    }
  });

  it("z-score flags both extreme high and low outliers", () => {
    const result = detectAnomalies({
      values: [50, 51, 49, 50, 51, 49, 50, 200, 51, 50, -100],
      method: "zscore",
      zK: 2.0,
    });
    assert.ok(result.ok);
    if (result.ok) {
      const values = result.anomalies.map((a) => a.value).sort((a, b) => a - b);
      assert.deepEqual(values, [-100, 200]);
    }
  });

  it("'both' method returns the union (each anomaly tagged by every method that flagged it)", () => {
    const result = detectAnomalies({
      values: [10, 11, 9, 10, 11, 12, 10, 9, 11, 100],
      method: "both",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(result.anomalies.length >= 1);
      const top = result.anomalies[0];
      assert.equal(top.value, 100);
      // 100 vs cluster [9..12] is flagged by BOTH methods.
      assert.ok(top.flaggedBy.includes("iqr"));
      assert.ok(top.flaggedBy.includes("zscore"));
    }
  });

  it("flat series → no anomalies", () => {
    const result = detectAnomalies({
      values: [50, 50, 50, 50, 50, 50, 50],
      method: "both",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.anomalies.length, 0);
      assert.equal(result.stats.std, 0);
      assert.equal(result.stats.iqr, 0);
    }
  });

  it("labels round-trip onto anomaly entries", () => {
    const result = detectAnomalies({
      values: [10, 11, 9, 10, 12, 100, 11],
      labels: ["W1", "W2", "W3", "W4", "W5", "W6", "W7"],
      method: "iqr",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.anomalies[0].label, "W6");
      assert.equal(result.anomalies[0].index, 5);
    }
  });

  it("severity sorts anomalies by magnitude (largest deviation first)", () => {
    const result = detectAnomalies({
      values: [10, 11, 9, 10, 11, 12, 10, 9, 11, 100, 50],
      method: "both",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.ok(result.anomalies.length >= 2);
      // 100 deviates farther than 50 → comes first.
      assert.ok(result.anomalies[0].severity >= result.anomalies[1].severity);
    }
  });
});

describe("Wave F2 · stats payload", () => {
  it("returns median, IQR, mean, std, and upper/lower fences", () => {
    const result = detectAnomalies({
      values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      method: "iqr",
    });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.stats.n, 10);
      assert.equal(result.stats.median, 5.5);
      assert.equal(result.stats.q1, 3.25);
      assert.equal(result.stats.q3, 7.75);
      assert.equal(result.stats.iqr, 4.5);
      assert.ok(Math.abs(result.stats.mean - 5.5) < 1e-9);
    }
  });
});

describe("Wave F2 · rejections", () => {
  it("rejects < 5 observations", () => {
    const result = detectAnomalies({
      values: [1, 2, 3, 4],
      method: "iqr",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /at least 5/);
  });

  it("skips non-finite values and applies the gate against the cleaned count", () => {
    const result = detectAnomalies({
      values: [1, NaN, 2, null as unknown as number, 3, 4],
      method: "iqr",
    });
    // After cleaning: [1, 2, 3, 4] = 4 obs → still rejected.
    assert.equal(result.ok, false);
  });

  it("non-array → error", () => {
    const result = detectAnomalies({
      values: null as unknown as number[],
    });
    assert.equal(result.ok, false);
  });
});
