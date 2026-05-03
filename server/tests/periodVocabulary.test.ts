import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchPeriod, __internal__ } from "../lib/wideFormat/periodVocabulary.js";

describe("periodVocabulary.matchPeriod", () => {
  describe("months", () => {
    const cases: Array<[string, string, number]> = [
      ["Jan 2024", "2024-01", 0.9],
      ["Jan-2024", "2024-01", 0.9],
      ["Jan '24", "2024-01", 0.9],
      ["Jan24", "2024-01", 0.9],
      ["January 2024", "2024-01", 0.9],
      ["Dec-24", "2024-12", 0.9],
      ["Feb 99", "1999-02", 0.9],
      ["2024-01", "2024-01", 0.85],
      ["2024/03", "2024-03", 0.85],
      ["2024-Jan", "2024-01", 0.9],
    ];
    for (const [tok, iso, minConf] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "month");
        assert.equal(m!.iso, iso);
        assert.ok(m!.confidence >= minConf);
      });
    }

    it("bare 'Jan' matches with low confidence", () => {
      const m = matchPeriod("Jan");
      assert.ok(m);
      assert.equal(m!.kind, "month");
      assert.equal(m!.iso, "XXXX-01");
      assert.ok(m!.confidence < 0.7);
    });
  });

  describe("quarters", () => {
    const cases: Array<[string, string]> = [
      ["Q1 2024", "2024-Q1"],
      ["Q2-24", "2024-Q2"],
      ["1Q24", "2024-Q1"],
      ["4Q 2024", "2024-Q4"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m);
        assert.equal(m!.kind, "quarter");
        assert.equal(m!.iso, iso);
      });
    }

    it("bare 'Q1' matches with low confidence", () => {
      const m = matchPeriod("Q1");
      assert.ok(m);
      assert.equal(m!.iso, "XXXX-Q1");
      assert.ok(m!.confidence < 0.7);
    });
  });

  describe("years", () => {
    it("'2024' matches as year with guarded confidence", () => {
      const m = matchPeriod("2024");
      assert.ok(m);
      assert.equal(m!.kind, "year");
      assert.equal(m!.iso, "2024");
      assert.ok(m!.confidence < 0.7, "plain year is intentionally ambiguous");
    });

    it("'FY24' → FY2024", () => {
      const m = matchPeriod("FY24");
      assert.ok(m);
      assert.equal(m!.iso, "FY2024");
    });

    it("'FY 2023' → FY2023", () => {
      const m = matchPeriod("FY 2023");
      assert.ok(m);
      assert.equal(m!.iso, "FY2023");
    });

    it("'9999' does not match (outside plausible year range)", () => {
      assert.equal(matchPeriod("9999"), null);
    });
  });

  describe("weeks", () => {
    const cases: Array<[string, string]> = [
      ["W12", "XXXX-W12"],
      ["W12 2024", "2024-W12"],
      ["Week 12", "XXXX-W12"],
      ["Week 12 2024", "2024-W12"],
      ["2024-W12", "2024-W12"],
      ["WE 2024-03-17", "WE-2024-03-17"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected week match for ${tok}`);
        assert.equal(m!.kind, "week");
        assert.equal(m!.iso, iso);
      });
    }
  });

  describe("Nielsen specials", () => {
    it("'MAT Dec-24' → MAT-2024-12", () => {
      const m = matchPeriod("MAT Dec-24");
      assert.ok(m);
      assert.equal(m!.kind, "mat");
      assert.equal(m!.iso, "MAT-2024-12");
    });

    it("'MAT 2024-12' → MAT-2024-12", () => {
      const m = matchPeriod("MAT 2024-12");
      assert.ok(m);
      assert.equal(m!.iso, "MAT-2024-12");
    });

    it("'YTD 2024' → YTD-2024", () => {
      const m = matchPeriod("YTD 2024");
      assert.ok(m);
      assert.equal(m!.kind, "ytd");
      assert.equal(m!.iso, "YTD-2024");
    });

    it("'YTD Dec-24' → YTD-2024-12", () => {
      const m = matchPeriod("YTD Dec-24");
      assert.ok(m);
      assert.equal(m!.iso, "YTD-2024-12");
    });

    it("'2024 YTD' → YTD-2024", () => {
      const m = matchPeriod("2024 YTD");
      assert.ok(m);
      assert.equal(m!.iso, "YTD-2024");
    });

    it("rolling windows L4W / L12W / L52W / P4W / P13W / P52W", () => {
      for (const token of ["L4W", "L12W", "L52W", "P4W", "P13W", "P52W"]) {
        const m = matchPeriod(token);
        assert.ok(m, `expected match for ${token}`);
        assert.equal(m!.kind, "rolling");
        assert.equal(m!.iso, token);
      }
    });

    it("L7W not a recognized rolling window", () => {
      assert.equal(matchPeriod("L7W"), null);
    });
  });

  describe("negative cases", () => {
    for (const tok of ["", "   ", "Brand A", "Value Sales", "Region", "Total Market", "abc123"]) {
      it(`'${tok}' does not match`, () => {
        assert.equal(matchPeriod(tok), null);
      });
    }
  });

  describe("internal matchers export", () => {
    it("exposes per-matcher functions for targeted tests", () => {
      assert.equal(typeof __internal__.matchMat, "function");
      assert.equal(typeof __internal__.matchRolling, "function");
      assert.equal(typeof __internal__.matchLatestN, "function");
      assert.equal(typeof __internal__.matchHalfYear, "function");
      assert.equal(typeof __internal__.matchPeriodToDate, "function");
      assert.equal(typeof __internal__.matchPeriodCode, "function");
    });
  });

  describe("Latest N Months (Nielsen rolling-window comparatives)", () => {
    const cases: Array<[string, string]> = [
      ["Latest 12 Mths", "L12M"],
      ["Latest 12 Months", "L12M"],
      ["Latest 6 Mths", "L6M"],
      ["Latest 12 Mths YA", "L12M-YA"],
      ["Latest 12 Mths 2YA", "L12M-2YA"],
      ["Latest 12 Mths TY", "L12M-TY"],
      ["latest-12-mths-2ya", "L12M-2YA"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "latest_n");
        assert.equal(m!.iso, iso);
        assert.ok(m!.confidence >= 0.85);
      });
    }
  });

  describe("YTD comparative qualifiers", () => {
    const cases: Array<[string, string]> = [
      ["YTD TY", "YTD-TY"],
      ["YTD YA", "YTD-YA"],
      ["YTD 2YA", "YTD-2YA"],
      ["ytd-2ya", "YTD-2YA"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "ytd");
        assert.equal(m!.iso, iso);
        assert.ok(m!.confidence >= 0.85);
      });
    }
  });

  describe("week-ending in DMY slash format", () => {
    const cases: Array<[string, string]> = [
      ["w/e 23/03/23", "WE-2023-03-23"],
      ["we 23/03/23", "WE-2023-03-23"],
      ["W/E 23/12/2024", "WE-2024-12-23"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "week");
        assert.equal(m!.iso, iso);
      });
    }
  });

  describe("compound headers with trailing w/e decoration (Marico-VN shape)", () => {
    const cases: Array<[string, string, string]> = [
      ["Q1 23 - w/e 23/03/23", "quarter", "2023-Q1"],
      ["Q4 25 - w/e 23/12/25", "quarter", "2025-Q4"],
      ["Latest 12 Mths 2YA - w/e 23/12/23", "latest_n", "L12M-2YA"],
      ["Latest 12 Mths YA - w/e 23/12/24", "latest_n", "L12M-YA"],
      ["Latest 12 Mths - w/e 23/12/25", "latest_n", "L12M"],
    ];
    for (const [tok, kind, iso] of cases) {
      it(`${tok} → ${kind}/${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, kind);
        assert.equal(m!.iso, iso);
        assert.ok(m!.confidence >= 0.85);
      });
    }
  });

  describe("Latest N — multi-unit (Marico India / MENA shapes)", () => {
    const cases: Array<[string, string]> = [
      ["Latest 4 Wks", "L4W"],
      ["Latest 12 Weeks", "L12W"],
      ["Latest 4 Wks YA", "L4W-YA"],
      ["Last 4 Weeks", "L4W"],
      ["Last 4 Wks YA", "L4W-YA"],
      ["Trailing 12 Mths", "L12M"],
      ["Rolling 12 Months 2YA", "L12M-2YA"],
      ["Latest 2 Yrs", "L2Y"],
      ["Latest 1 Year", "L1Y"],
      ["Latest 2 Yrs YA", "L2Y-YA"],
      ["Latest 30 Days", "L30D"],
      ["Latest 7 Day", "L7D"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "latest_n");
        assert.equal(m!.iso, iso);
      });
    }
  });

  describe("MAT comparatives (Marico India / MENA)", () => {
    const cases: Array<[string, string]> = [
      ["MAT TY", "MAT-TY"],
      ["MAT YA", "MAT-YA"],
      ["MAT 2YA", "MAT-2YA"],
      ["MAT Dec-24 YA", "MAT-2024-12-YA"],
      ["MAT Dec 24 2YA", "MAT-2024-12-2YA"],
      ["MAT 2024-12 YA", "MAT-2024-12-YA"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "mat");
        assert.equal(m!.iso, iso);
      });
    }
  });

  describe("FY / CY comparatives (Marico India fiscal vs calendar)", () => {
    const cases: Array<[string, string]> = [
      ["FY24 YA", "FY2024-YA"],
      ["FY 2024 2YA", "FY2024-2YA"],
      ["CY 2024", "2024"],
      ["Calendar Year 2023", "2023"],
      ["CY 2024 YA", "2024-YA"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "year");
        assert.equal(m!.iso, iso);
      });
    }
  });

  describe("Half-year (H1/H2) with comparatives", () => {
    const cases: Array<[string, string]> = [
      ["H1 24", "2024-H1"],
      ["H2 2024", "2024-H2"],
      ["H1 23 YA", "2023-H1-YA"],
      ["H2 23 2YA", "2023-H2-2YA"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.iso, iso);
      });
    }
  });

  describe("MTD / QTD / WTD period-to-date columns", () => {
    const cases: Array<[string, string]> = [
      ["MTD", "MTD"],
      ["QTD", "QTD"],
      ["WTD", "WTD"],
      ["MTD YA", "MTD-YA"],
      ["MTD 2YA", "MTD-2YA"],
      ["QTD TY", "QTD-TY"],
      ["WTD YA", "WTD-YA"],
      ["MTD May 24", "MTD-2024-05"],
      ["MTD Jun-2024", "MTD-2024-06"],
      ["QTD Q1 24", "QTD-2024-Q1"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, "ytd");
        assert.equal(m!.iso, iso);
      });
    }
  });

  describe("Nielsen 4-week period codes (P1-P13 with year)", () => {
    const cases: Array<[string, string]> = [
      ["P1 24", "2024-P1"],
      ["P13 23", "2023-P13"],
      ["P1 2024", "2024-P1"],
      ["P1 24 YA", "2024-P1-YA"],
      ["P7 23 2YA", "2023-P7-2YA"],
    ];
    for (const [tok, iso] of cases) {
      it(`${tok} → ${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.iso, iso);
      });
    }
    it("rolling P4W is still distinct from P4 (rolling matcher)", () => {
      const m = matchPeriod("P4W");
      assert.ok(m);
      assert.equal(m!.kind, "rolling");
      assert.equal(m!.iso, "P4W");
    });
  });

  describe("trailing m/e and p/e decoration", () => {
    const cases: Array<[string, string, string]> = [
      ["MAT Dec-24 - m/e 31/12/24", "mat", "MAT-2024-12"],
      ["P1 24 - p/e 28/01/24", "rolling", "2024-P1"],
      ["Q1 24 - month ending 31/03/24", "quarter", "2024-Q1"],
    ];
    for (const [tok, kind, iso] of cases) {
      it(`${tok} → ${kind}/${iso}`, () => {
        const m = matchPeriod(tok);
        assert.ok(m, `expected match for ${tok}`);
        assert.equal(m!.kind, kind);
        assert.equal(m!.iso, iso);
      });
    }
  });
});
