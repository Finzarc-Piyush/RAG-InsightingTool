import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchMetric } from "../lib/wideFormat/metricVocabulary.js";

describe("metricVocabulary.matchMetric", () => {
  describe("Value Sales", () => {
    for (const tok of [
      "Value Sales",
      "VALUE SALES",
      "value",
      "Value",
      "Rupee Sales",
      "$ Sales",
      "INR Sales",
      "Sales Value",
      "Val Sales",
      "Value Offtake",
    ]) {
      it(`'${tok}' → Value Sales`, () => {
        const m = matchMetric(tok);
        assert.ok(m, `expected Value Sales for ${tok}`);
        assert.equal(m!.canonical, "Value Sales");
      });
    }
  });

  describe("Volume Sales", () => {
    for (const tok of [
      "Volume Sales",
      "Volume",
      "Unit Sales",
      "Units",
      "Kg Sales",
      "Litres Sales",
      "Sales Volume",
      "Vol Sales",
      "Volume Offtake",
    ]) {
      it(`'${tok}' → Volume Sales`, () => {
        const m = matchMetric(tok);
        assert.ok(m, `expected Volume Sales for ${tok}`);
        assert.equal(m!.canonical, "Volume Sales");
      });
    }
  });

  describe("Value Share", () => {
    for (const tok of ["Value Share", "Val Share", "Market Share Value", "MS Val", "Share of Value"]) {
      it(`'${tok}' → Value Share`, () => {
        const m = matchMetric(tok);
        assert.ok(m);
        assert.equal(m!.canonical, "Value Share");
      });
    }
  });

  describe("Volume Share", () => {
    for (const tok of ["Volume Share", "Vol Share", "Market Share Volume", "MS Vol", "Share of Volume"]) {
      it(`'${tok}' → Volume Share`, () => {
        const m = matchMetric(tok);
        assert.ok(m);
        assert.equal(m!.canonical, "Volume Share");
      });
    }
  });

  describe("Weighted Distribution", () => {
    for (const tok of ["Weighted Distribution", "Wtd Dist", "Wtd Distribution", "WD", "W.D."]) {
      it(`'${tok}' → Weighted Distribution`, () => {
        const m = matchMetric(tok);
        assert.ok(m);
        assert.equal(m!.canonical, "Weighted Distribution");
      });
    }
  });

  describe("Numeric Distribution", () => {
    for (const tok of ["Numeric Distribution", "Num Dist", "Num Distribution", "ND", "N.D."]) {
      it(`'${tok}' → Numeric Distribution`, () => {
        const m = matchMetric(tok);
        assert.ok(m);
        assert.equal(m!.canonical, "Numeric Distribution");
      });
    }
  });

  describe("ACV / TDP", () => {
    it("'ACV' matches", () => {
      assert.equal(matchMetric("ACV")?.canonical, "ACV");
    });
    it("'All Commodity Volume' matches ACV", () => {
      assert.equal(matchMetric("All Commodity Volume")?.canonical, "ACV");
    });
    it("'TDP' matches", () => {
      assert.equal(matchMetric("TDP")?.canonical, "TDP");
    });
    it("'Total Distribution Points' matches TDP", () => {
      assert.equal(matchMetric("Total Distribution Points")?.canonical, "TDP");
    });
  });

  describe("Penetration / Loyalty / Frequency", () => {
    for (const [tok, canonical] of [
      ["Penetration", "Penetration"],
      ["Pen", "Penetration"],
      ["HH Penetration", "Penetration"],
      ["Household Penetration", "Penetration"],
      ["Loyalty", "Loyalty"],
      ["Brand Loyalty", "Loyalty"],
      ["Frequency", "Frequency"],
      ["Freq", "Frequency"],
      ["Purchase Frequency", "Frequency"],
    ] as const) {
      it(`'${tok}' → ${canonical}`, () => {
        assert.equal(matchMetric(tok)?.canonical, canonical);
      });
    }
  });

  describe("Average Price", () => {
    for (const tok of ["Average Price", "Avg Price", "Price", "Price per Unit", "Price/Kg", "Unit Price"]) {
      it(`'${tok}' → Average Price`, () => {
        assert.equal(matchMetric(tok)?.canonical, "Average Price");
      });
    }
  });

  describe("Shopper Spend", () => {
    for (const tok of ["Shopper Spend", "Spend per Buyer", "Buyer Spend"]) {
      it(`'${tok}' → Shopper Spend`, () => {
        assert.equal(matchMetric(tok)?.canonical, "Shopper Spend");
      });
    }
  });

  describe("negative cases", () => {
    for (const tok of [
      "",
      "   ",
      "Brand A",
      "Region",
      "Market",
      "Category",
      "SKU",
      "Manufacturer",
      "2024-01",
      "Jan 2024",
      "Q1 2024",
      "Random Column",
    ]) {
      it(`'${tok}' returns null`, () => {
        assert.equal(matchMetric(tok), null);
      });
    }
  });

  describe("shape", () => {
    it("returns { canonical, confidence, raw }", () => {
      const m = matchMetric("Value Sales");
      assert.ok(m);
      assert.equal(m!.canonical, "Value Sales");
      assert.ok(m!.confidence > 0 && m!.confidence <= 1);
      assert.equal(m!.raw, "Value Sales");
    });

    it("preserves raw input casing even when canonical differs", () => {
      const m = matchMetric("VALUE SHARE");
      assert.ok(m);
      assert.equal(m!.raw, "VALUE SHARE");
      assert.equal(m!.canonical, "Value Share");
    });
  });
});
