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
    });
  });
});
