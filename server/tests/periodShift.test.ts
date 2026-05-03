// WGR1 · period-shift utilities — pin YoY/QoQ/MoM/WoW shifts for
// every supported ISO label shape produced by the wide-format
// matcher and the standard date parser.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  priorPeriodKey,
  chooseAutoGrain,
  periodsPerYearForKind,
} from "../lib/growth/periodShift.js";

describe("WGR1 · priorPeriodKey — YoY", () => {
  it("shifts standard YYYY-MM by one year", () => {
    assert.equal(priorPeriodKey("2024-03", "yoy"), "2023-03");
    assert.equal(priorPeriodKey("2025-12", "yoy"), "2024-12");
  });
  it("shifts YYYY-Q[1-4]", () => {
    assert.equal(priorPeriodKey("2024-Q3", "yoy"), "2023-Q3");
    assert.equal(priorPeriodKey("2024-Q1", "yoy"), "2023-Q1");
  });
  it("shifts YYYY-Wnn", () => {
    assert.equal(priorPeriodKey("2024-W12", "yoy"), "2023-W12");
  });
  it("shifts plain YYYY and FYYYYY", () => {
    assert.equal(priorPeriodKey("2024", "yoy"), "2023");
    assert.equal(priorPeriodKey("FY2024", "yoy"), "FY2023");
  });
  it("shifts half-year labels", () => {
    assert.equal(priorPeriodKey("2024-H1", "yoy"), "2023-H1");
  });
  it("shifts MAT-anchored labels", () => {
    assert.equal(priorPeriodKey("MAT-2024-12", "yoy"), "MAT-2023-12");
    assert.equal(priorPeriodKey("MTD-2024-03", "yoy"), "MTD-2023-03");
    assert.equal(priorPeriodKey("QTD-2024-Q1", "yoy"), "QTD-2023-Q1");
    assert.equal(priorPeriodKey("YTD-2024", "yoy"), "YTD-2023");
  });
  it("shifts WE- weekly-ending labels", () => {
    assert.equal(priorPeriodKey("WE-2024-03-17", "yoy"), "WE-2023-03-17");
  });
});

describe("WGR1 · priorPeriodKey — Nielsen comparative qualifier shifts", () => {
  it("L12M family", () => {
    assert.equal(priorPeriodKey("L12M", "yoy"), "L12M-YA");
    assert.equal(priorPeriodKey("L12M-YA", "yoy"), "L12M-2YA");
    assert.equal(priorPeriodKey("L12M-2YA", "yoy"), "L12M-3YA");
    assert.equal(priorPeriodKey("L12M-3YA", "yoy"), null);
  });
  it("YTD comparative family", () => {
    assert.equal(priorPeriodKey("YTD", "yoy"), "YTD-YA");
    assert.equal(priorPeriodKey("YTD-TY", "yoy"), "YTD-YA");
    assert.equal(priorPeriodKey("YTD-YA", "yoy"), "YTD-2YA");
    assert.equal(priorPeriodKey("YTD-2YA", "yoy"), "YTD-3YA");
  });
  it("MAT comparative family", () => {
    assert.equal(priorPeriodKey("MAT", "yoy"), "MAT-YA");
    assert.equal(priorPeriodKey("MAT-TY", "yoy"), "MAT-YA");
    assert.equal(priorPeriodKey("MAT-YA", "yoy"), "MAT-2YA");
  });
  it("MTD/QTD/WTD comparative families", () => {
    assert.equal(priorPeriodKey("MTD-TY", "yoy"), "MTD-YA");
    assert.equal(priorPeriodKey("QTD-YA", "yoy"), "QTD-2YA");
    assert.equal(priorPeriodKey("WTD-2YA", "yoy"), "WTD-3YA");
  });
  it("rolling windows L4W / L52W follow same pattern", () => {
    assert.equal(priorPeriodKey("L52W", "yoy"), "L52W-YA");
    assert.equal(priorPeriodKey("L4W-YA", "yoy"), "L4W-2YA");
  });
});

describe("WGR1 · priorPeriodKey — QoQ", () => {
  it("shifts quarter back, crossing years", () => {
    assert.equal(priorPeriodKey("2024-Q3", "qoq"), "2024-Q2");
    assert.equal(priorPeriodKey("2024-Q1", "qoq"), "2023-Q4");
  });
  it("returns null for non-quarter labels", () => {
    assert.equal(priorPeriodKey("2024-03", "qoq"), null);
    assert.equal(priorPeriodKey("L12M", "qoq"), null);
  });
});

describe("WGR1 · priorPeriodKey — MoM", () => {
  it("shifts month back, crossing years", () => {
    assert.equal(priorPeriodKey("2024-03", "mom"), "2024-02");
    assert.equal(priorPeriodKey("2024-01", "mom"), "2023-12");
  });
  it("returns null for non-month labels", () => {
    assert.equal(priorPeriodKey("2024-Q3", "mom"), null);
    assert.equal(priorPeriodKey("YTD-TY", "mom"), null);
  });
});

describe("WGR1 · priorPeriodKey — WoW", () => {
  it("shifts week back, crossing years", () => {
    assert.equal(priorPeriodKey("2024-W12", "wow"), "2024-W11");
    assert.equal(priorPeriodKey("2024-W01", "wow"), "2023-W52");
  });
  it("returns null for non-week labels", () => {
    assert.equal(priorPeriodKey("2024-Q3", "wow"), null);
  });
});

describe("WGR1 · priorPeriodKey — robustness", () => {
  it("returns null on empty / non-string input", () => {
    assert.equal(priorPeriodKey("", "yoy"), null);
    assert.equal(priorPeriodKey("   ", "yoy"), null);
    // @ts-expect-error — runtime null guard
    assert.equal(priorPeriodKey(null, "yoy"), null);
    // @ts-expect-error — runtime undefined guard
    assert.equal(priorPeriodKey(undefined, "yoy"), null);
  });
  it("returns null on unrecognised label shapes", () => {
    assert.equal(priorPeriodKey("not-a-period", "yoy"), null);
    assert.equal(priorPeriodKey("FOOBAR-2024", "yoy"), null);
  });
});

describe("WGR1 · chooseAutoGrain", () => {
  it("picks yoy when ≥2 years are covered", () => {
    assert.equal(chooseAutoGrain({ distinctYears: 2 }), "yoy");
    assert.equal(chooseAutoGrain({ distinctYears: 5 }), "yoy");
  });
  it("picks wow on weekly cadence within a year", () => {
    assert.equal(
      chooseAutoGrain({ distinctYears: 1, weekly: true }),
      "wow"
    );
  });
  it("picks qoq on multi-quarter single-year coverage", () => {
    assert.equal(
      chooseAutoGrain({
        distinctYears: 1,
        distinctQuartersInOneYear: 4,
      }),
      "qoq"
    );
  });
  it("picks mom on multi-month single-year coverage", () => {
    assert.equal(
      chooseAutoGrain({
        distinctYears: 1,
        distinctMonthsInOneYear: 6,
      }),
      "mom"
    );
  });
  it("falls back to yoy when no signal", () => {
    assert.equal(chooseAutoGrain({ distinctYears: 1 }), "yoy");
    assert.equal(chooseAutoGrain({ distinctYears: 0 }), "yoy");
  });
});

describe("WGR1 · periodsPerYearForKind", () => {
  it("returns standard cadence counts", () => {
    assert.equal(periodsPerYearForKind("month"), 12);
    assert.equal(periodsPerYearForKind("quarter"), 4);
    assert.equal(periodsPerYearForKind("week"), 52);
    assert.equal(periodsPerYearForKind("year"), 1);
  });
});
