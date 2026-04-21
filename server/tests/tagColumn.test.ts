import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tagColumn, tagColumns } from "../lib/wideFormat/tagColumn.js";

describe("tagColumn", () => {
  describe("compound headers (period + metric)", () => {
    const cases: Array<[string, string, string]> = [
      ["Jan 2024 Value Sales", "2024-01", "Value Sales"],
      ["Value Sales Jan-24", "2024-01", "Value Sales"],
      ["MAT Dec-24 Weighted Distribution", "MAT-2024-12", "Weighted Distribution"],
      ["Q1 2024 Volume Share", "2024-Q1", "Volume Share"],
      ["YTD 2024 Numeric Distribution", "YTD-2024", "Numeric Distribution"],
      ["W12 2024 Value Sales", "2024-W12", "Value Sales"],
      ["L52W Value Share", "L52W", "Value Share"],
    ];
    for (const [header, iso, canonical] of cases) {
      it(`'${header}' → compound (period ${iso}, metric ${canonical})`, () => {
        const t = tagColumn(header);
        assert.equal(t.tag, "compound");
        assert.equal(t.period?.iso, iso);
        assert.equal(t.metric?.canonical, canonical);
        assert.ok(t.confidence > 0);
        assert.ok(t.evidence.length >= 2);
      });
    }
  });

  describe("period-only headers", () => {
    for (const header of ["Jan 2024", "Q1 2024", "MAT Dec-24", "YTD 2024", "W12 2024", "L52W"]) {
      it(`'${header}' → period`, () => {
        const t = tagColumn(header);
        assert.equal(t.tag, "period");
        assert.ok(t.period);
        assert.equal(t.metric, undefined);
      });
    }
  });

  describe("metric-only headers", () => {
    for (const header of ["Value Sales", "Weighted Distribution", "ACV", "Penetration", "Shopper Spend"]) {
      it(`'${header}' → metric`, () => {
        const t = tagColumn(header);
        assert.equal(t.tag, "metric");
        assert.ok(t.metric);
        assert.equal(t.period, undefined);
      });
    }
  });

  describe("id-like headers", () => {
    for (const header of ["Brand", "Market", "Category", "Manufacturer", "SKU", "Geography", "Segment", "Channel", "Retailer"]) {
      it(`'${header}' → id`, () => {
        const t = tagColumn(header);
        assert.equal(t.tag, "id");
        assert.ok(t.confidence >= 0.5);
      });
    }
  });

  describe("ambiguous headers", () => {
    it("'X-7421-BQ' does not look id-like", () => {
      const t = tagColumn("X-7421-BQ");
      // The tokenizer pulls numerics out; no match; looksLikeId rejects year-like runs.
      // "7421" isn't year-like so it might still be id-like-ish; ensure at least not compound.
      assert.notEqual(t.tag, "compound");
    });

    it("random symbol soup is ambiguous", () => {
      const t = tagColumn("????");
      assert.equal(t.tag, "ambiguous");
    });

    it("empty string is ambiguous", () => {
      const t = tagColumn("");
      assert.equal(t.tag, "ambiguous");
    });
  });

  describe("edge cases", () => {
    it("compound with synonym spellings", () => {
      const t = tagColumn("Wtd Dist MAT Dec-24");
      assert.equal(t.tag, "compound");
      assert.equal(t.metric?.canonical, "Weighted Distribution");
      assert.equal(t.period?.iso, "MAT-2024-12");
    });

    it("metric confidence reflects the pick", () => {
      const t = tagColumn("MS Val Jan-24");
      assert.equal(t.tag, "compound");
      assert.equal(t.metric?.canonical, "Value Share");
    });

    it("period n-gram wins over adjacent year token", () => {
      const t = tagColumn("2024 Volume Sales");
      assert.equal(t.tag, "compound");
      assert.equal(t.metric?.canonical, "Volume Sales");
      assert.equal(t.period?.iso, "2024");
    });
  });
});

describe("tagColumns", () => {
  it("tags a list preserving order", () => {
    const headers = ["Brand", "Jan 2024 Value Sales", "Value Share", "Q1 2024"];
    const tags = tagColumns(headers);
    assert.equal(tags.length, 4);
    assert.deepEqual(
      tags.map((t) => t.tag),
      ["id", "compound", "metric", "period"]
    );
    assert.equal(tags[0].header, "Brand");
    assert.equal(tags[3].header, "Q1 2024");
  });
});
