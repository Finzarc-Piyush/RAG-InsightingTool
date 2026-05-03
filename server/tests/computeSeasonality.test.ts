// WSE1 · seasonality math — pin parsing, index, peak consistency, strength,
// and summary line on synthetic fixtures. Pure unit tests, no DuckDB.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPositionFromIso,
  computeSeasonalityIndex,
  computePeakConsistency,
  seasonalityStrength,
  summarizeSeasonality,
  chooseSeasonalityGrain,
  positionLabel,
  type SeasonalityInput,
} from "../lib/seasonality/computeSeasonality.js";

describe("WSE1 · extractPositionFromIso", () => {
  it("parses YYYY-MM monthly", () => {
    assert.deepEqual(extractPositionFromIso("2024-03"), {
      year: 2024,
      position: 3,
      grain: "month",
    });
    assert.deepEqual(extractPositionFromIso("2024-12"), {
      year: 2024,
      position: 12,
      grain: "month",
    });
  });
  it("parses YYYY-Qn quarterly", () => {
    assert.deepEqual(extractPositionFromIso("2024-Q1"), {
      year: 2024,
      position: 1,
      grain: "quarter",
    });
    assert.deepEqual(extractPositionFromIso("2024-Q4"), {
      year: 2024,
      position: 4,
      grain: "quarter",
    });
  });
  it("parses fiscal-year quarterly", () => {
    assert.deepEqual(extractPositionFromIso("FY2024-Q1"), {
      year: 2024,
      position: 1,
      grain: "quarter",
    });
  });
  it("returns null on rolling/MAT/YTD/weekly labels", () => {
    assert.equal(extractPositionFromIso("L12M"), null);
    assert.equal(extractPositionFromIso("MAT-2024-12"), null);
    assert.equal(extractPositionFromIso("YTD-2024"), null);
    assert.equal(extractPositionFromIso("2024-W12"), null);
    assert.equal(extractPositionFromIso("2024"), null);
  });
  it("returns null on invalid input", () => {
    assert.equal(extractPositionFromIso(""), null);
    assert.equal(extractPositionFromIso("garbage"), null);
    // @ts-expect-error — runtime guard
    assert.equal(extractPositionFromIso(null), null);
  });
});

describe("WSE1 · computeSeasonalityIndex", () => {
  function rampPanel(): SeasonalityInput[] {
    // 5 years × 12 months. Q4 spike: each year, Nov is +50% over baseline,
    // Oct/Dec are +25%. All other months at 100.
    const rows: SeasonalityInput[] = [];
    const spike: Record<number, number> = {
      10: 1.25,
      11: 1.5,
      12: 1.25,
    };
    for (let y = 2018; y <= 2022; y++) {
      for (let p = 1; p <= 12; p++) {
        rows.push({ year: y, position: p, value: 100 * (spike[p] ?? 1) });
      }
    }
    return rows;
  }

  it("returns 12 rows for monthly grain (one per month)", () => {
    const rows = computeSeasonalityIndex(rampPanel(), "month");
    assert.equal(rows.length, 12);
  });

  it("Nov index ~1.36 on the Q4-spike fixture (1.5 vs avg ≈ 1.10)", () => {
    const rows = computeSeasonalityIndex(rampPanel(), "month");
    const nov = rows.find((r) => r.position === 11)!;
    // Average of position-means on this fixture:
    //   9 months × 100 + Oct 125 + Nov 150 + Dec 125 = 900 + 400 = 1300
    //   1300 / 12 = 108.33
    //   nov.index = 150 / 108.33 ≈ 1.385
    assert.ok(
      Math.abs(nov.index - 1.385) < 0.05,
      `Nov index ≈ 1.385, got ${nov.index}`
    );
  });

  it("flat panel returns indices clustered at 1.0", () => {
    const rows: SeasonalityInput[] = [];
    for (let y = 2018; y <= 2020; y++) {
      for (let p = 1; p <= 12; p++) rows.push({ year: y, position: p, value: 100 });
    }
    const idx = computeSeasonalityIndex(rows, "month");
    for (const r of idx) {
      assert.ok(Math.abs(r.index - 1) < 0.01, `${r.label} index ${r.index} not ≈ 1`);
    }
  });

  it("yearsObserved counts distinct years per position", () => {
    const rows = computeSeasonalityIndex(rampPanel(), "month");
    for (const r of rows) {
      assert.equal(r.yearsObserved, 5);
      assert.equal(r.observationsPerYear, 1);
    }
  });

  it("quarterly grain returns 4 rows", () => {
    const rows: SeasonalityInput[] = [];
    for (let y = 2018; y <= 2020; y++) {
      for (let q = 1; q <= 4; q++) {
        rows.push({ year: y, position: q, value: q === 4 ? 200 : 100 });
      }
    }
    const idx = computeSeasonalityIndex(rows, "quarter");
    assert.equal(idx.length, 4);
    const q4 = idx.find((r) => r.position === 4)!;
    // mean(Q1)=100, mean(Q2)=100, mean(Q3)=100, mean(Q4)=200; baseline=125; q4.index=1.6
    assert.ok(Math.abs(q4.index - 1.6) < 0.01);
  });
});

describe("WSE1 · computePeakConsistency", () => {
  function q4SpikeRows(): SeasonalityInput[] {
    const rows: SeasonalityInput[] = [];
    const spike: Record<number, number> = { 10: 1.25, 11: 1.5, 12: 1.25 };
    for (let y = 2018; y <= 2022; y++) {
      for (let p = 1; p <= 12; p++) {
        rows.push({ year: y, position: p, value: 100 * (spike[p] ?? 1) });
      }
    }
    return rows;
  }

  it("Oct/Nov/Dec consistently peak across all 5 years (top-3)", () => {
    const out = computePeakConsistency(q4SpikeRows(), "month", 3, 0.6);
    assert.equal(out.totalYears, 5);
    const nov = out.rows.find((r) => r.position === 11)!;
    const oct = out.rows.find((r) => r.position === 10)!;
    const dec = out.rows.find((r) => r.position === 12)!;
    assert.equal(nov.fractionInTopK, 1, "Nov in top-3 every year");
    assert.equal(oct.fractionInTopK, 1, "Oct in top-3 every year");
    assert.equal(dec.fractionInTopK, 1, "Dec in top-3 every year");
    const peakPositions = out.consistentPeaks.map((p) => p.position).sort();
    assert.deepEqual(peakPositions, [10, 11, 12]);
  });

  it("year-shifting peak (different month leads each year) yields low consistency", () => {
    // 4 years; the peak shifts: 2018→Mar, 2019→Jun, 2020→Sep, 2021→Dec.
    const rows: SeasonalityInput[] = [];
    const peakByYear: Record<number, number> = {
      2018: 3,
      2019: 6,
      2020: 9,
      2021: 12,
    };
    for (const y of [2018, 2019, 2020, 2021]) {
      for (let p = 1; p <= 12; p++) {
        rows.push({ year: y, position: p, value: peakByYear[y] === p ? 300 : 100 });
      }
    }
    const out = computePeakConsistency(rows, "month", 1, 0.6);
    assert.equal(out.consistentPeaks.length, 0, "no single month peaked consistently");
    // Each peak month appeared in exactly 1 of 4 years = 0.25.
    for (const r of out.rows.filter((r) => r.fractionInTopK > 0)) {
      assert.equal(r.fractionInTopK, 0.25);
    }
  });

  it("rows are sorted by fractionInTopK desc", () => {
    const out = computePeakConsistency(q4SpikeRows(), "month", 3, 0.6);
    for (let i = 1; i < out.rows.length; i++) {
      assert.ok(
        out.rows[i].fractionInTopK <= out.rows[i - 1].fractionInTopK,
        "rows must be sorted desc"
      );
    }
  });
});

describe("WSE1 · seasonalityStrength", () => {
  it("classifies tiers from index range", () => {
    const mkIndex = (top: number, bottom: number) => [
      { position: 1, label: "Jan", mean: 0, count: 1, index: bottom, observationsPerYear: 1, yearsObserved: 1 },
      { position: 2, label: "Feb", mean: 0, count: 1, index: top, observationsPerYear: 1, yearsObserved: 1 },
    ];
    assert.equal(seasonalityStrength(mkIndex(1.6, 0.9)).tier, "strong");
    assert.equal(seasonalityStrength(mkIndex(1.3, 0.95)).tier, "moderate");
    assert.equal(seasonalityStrength(mkIndex(1.05, 0.98)).tier, "weak");
    assert.equal(seasonalityStrength(mkIndex(1.01, 1.0)).tier, "none");
  });
  it("returns range = top-bottom", () => {
    const r = seasonalityStrength([
      { position: 1, label: "Jan", mean: 0, count: 1, index: 1.6, observationsPerYear: 1, yearsObserved: 1 },
      { position: 2, label: "Feb", mean: 0, count: 1, index: 0.9, observationsPerYear: 1, yearsObserved: 1 },
    ]);
    assert.ok(Math.abs(r.range - 0.7) < 1e-9);
  });
});

describe("WSE1 · summarizeSeasonality", () => {
  function q4Setup() {
    const rows: SeasonalityInput[] = [];
    const spike: Record<number, number> = { 10: 1.25, 11: 1.5, 12: 1.25 };
    for (let y = 2018; y <= 2022; y++) {
      for (let p = 1; p <= 12; p++) {
        rows.push({ year: y, position: p, value: 100 * (spike[p] ?? 1) });
      }
    }
    const index = computeSeasonalityIndex(rows, "month");
    const cons = computePeakConsistency(rows, "month", 3, 0.6);
    const strength = seasonalityStrength(index);
    return { rows, index, cons, strength };
  }

  it("names the consistent peak months and cites consistency fraction", () => {
    const { index, cons, strength } = q4Setup();
    const summary = summarizeSeasonality(index, cons, strength, "month");
    // Should mention Nov, Oct, Dec, and "5 of 5".
    assert.match(summary, /Nov|Oct|Dec/);
    assert.match(summary, /5 of 5/);
  });

  it("flags 'no seasonality' on a flat fixture", () => {
    const rows: SeasonalityInput[] = [];
    for (let y = 2018; y <= 2020; y++) {
      for (let p = 1; p <= 12; p++) rows.push({ year: y, position: p, value: 100 });
    }
    const index = computeSeasonalityIndex(rows, "month");
    const cons = computePeakConsistency(rows, "month", 3, 0.6);
    const strength = seasonalityStrength(index);
    const summary = summarizeSeasonality(index, cons, strength, "month");
    assert.match(summary, /No meaningful|no.+seasonality/i);
  });

  it("refuses on insufficient years", () => {
    const rows: SeasonalityInput[] = [];
    for (let p = 1; p <= 12; p++) rows.push({ year: 2024, position: p, value: 100 });
    const index = computeSeasonalityIndex(rows, "month");
    const cons = computePeakConsistency(rows, "month", 3, 0.6);
    const strength = seasonalityStrength(index);
    const summary = summarizeSeasonality(index, cons, strength, "month");
    assert.match(summary, /Insufficient/i);
  });
});

describe("WSE1 · chooseSeasonalityGrain", () => {
  it("picks 'month' on multi-year monthly coverage", () => {
    assert.equal(
      chooseSeasonalityGrain({ distinctYears: 3, distinctMonthsInOneYear: 12 }),
      "month"
    );
  });
  it("picks 'quarter' when only quarterly coverage exists", () => {
    assert.equal(
      chooseSeasonalityGrain({ distinctYears: 3, distinctQuartersInOneYear: 4 }),
      "quarter"
    );
  });
  it("returns null on single-year data", () => {
    assert.equal(
      chooseSeasonalityGrain({ distinctYears: 1, distinctMonthsInOneYear: 12 }),
      null
    );
  });
  it("returns null when neither grain has enough coverage", () => {
    assert.equal(
      chooseSeasonalityGrain({ distinctYears: 3, distinctMonthsInOneYear: 3 }),
      null
    );
  });
});

describe("WSE1 · positionLabel", () => {
  it("month labels", () => {
    assert.equal(positionLabel("month", 1), "Jan");
    assert.equal(positionLabel("month", 11), "Nov");
    assert.equal(positionLabel("month", 12), "Dec");
  });
  it("quarter labels", () => {
    assert.equal(positionLabel("quarter", 1), "Q1");
    assert.equal(positionLabel("quarter", 4), "Q4");
  });
  it("fallback labels for out-of-range", () => {
    assert.equal(positionLabel("month", 13), "M13");
    assert.equal(positionLabel("quarter", 5), "Q5");
  });
});
