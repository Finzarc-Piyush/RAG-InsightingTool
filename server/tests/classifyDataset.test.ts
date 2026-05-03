import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyDataset } from "../lib/wideFormat/classifyDataset.js";

describe("classifyDataset", () => {
  describe("Marico-VN screenshot shape (pure_period)", () => {
    const headers = [
      "Facts",
      "Markets",
      "Products",
      "Latest 12 Mths 2YA - w/e 23/12/23",
      "Latest 12 Mths YA - w/e 23/12/24",
      "Latest 12 Mths - w/e 23/12/25",
      "YTD 2YA",
      "YTD YA",
      "YTD TY",
      "Q1 23 - w/e 23/03/23",
      "Q2 23 - w/e 22/06/23",
      "Q3 23 - w/e 22/09/23",
      "Q4 23 - w/e 23/12/23",
      "Q1 24 - w/e 23/03/24",
      "Q2 24 - w/e 22/06/24",
      "Q3 24 - w/e 22/09/24",
      "Q4 24 - w/e 23/12/24",
      "Q1 25 - w/e 23/03/25",
      "Q2 25 - w/e 22/06/25",
      "Q3 25 - w/e 22/09/25",
      "Q4 25 - w/e 23/12/25",
    ];
    const c = classifyDataset(headers);

    it("is wide", () => {
      assert.equal(c.isWide, true);
    });
    it("shape = pure_period", () => {
      assert.equal(c.shape, "pure_period");
    });
    it("identifies id columns Facts/Markets/Products", () => {
      assert.deepEqual(c.idColumns, ["Facts", "Markets", "Products"]);
    });
    it("identifies all 18 period columns", () => {
      assert.equal(c.periodColumns.length, 18);
    });
    it("has no compound columns (no metric tokens in headers)", () => {
      assert.equal(c.compoundColumns.length, 0);
    });
    it("distinct period isos cover quarters + YTD + L12M", () => {
      assert.ok(c.distinctPeriodIsos.length >= 12);
      assert.ok(c.distinctPeriodIsos.includes("2023-Q1"));
      assert.ok(c.distinctPeriodIsos.includes("L12M-2YA"));
      assert.ok(c.distinctPeriodIsos.includes("YTD-TY"));
    });
  });

  describe("compound shape — period+metric in header", () => {
    const headers = [
      "Brand",
      "Region",
      "Q1 2023 Value Sales",
      "Q1 2023 Volume Sales",
      "Q2 2023 Value Sales",
      "Q2 2023 Volume Sales",
      "Q3 2023 Value Sales",
      "Q3 2023 Volume Sales",
    ];
    const c = classifyDataset(headers);

    it("is wide", () => {
      assert.equal(c.isWide, true);
    });
    it("shape = compound", () => {
      assert.equal(c.shape, "compound");
    });
    it("compound columns count = 6", () => {
      assert.equal(c.compoundColumns.length, 6);
    });
    it("id columns include Brand and Region", () => {
      assert.ok(c.idColumns.includes("Brand"));
      assert.ok(c.idColumns.includes("Region"));
    });
  });

  describe("long-format dataset → not wide", () => {
    const headers = ["Date", "Brand", "Region", "Sales", "Units", "Customer"];
    const c = classifyDataset(headers);
    it("is NOT wide", () => {
      assert.equal(c.isWide, false);
      assert.equal(c.shape, null);
    });
  });

  describe("single-period column → not wide (insufficient distinct periods)", () => {
    const headers = ["Brand", "Region", "Q1 2023"];
    const c = classifyDataset(headers);
    it("is NOT wide", () => {
      assert.equal(c.isWide, false);
      assert.match(c.reason, /period-like|distinct/);
    });
  });

  describe("only period columns, no id anchor → not wide", () => {
    const headers = ["Q1 2023", "Q2 2023", "Q3 2023", "Q4 2023"];
    const c = classifyDataset(headers);
    it("is NOT wide", () => {
      assert.equal(c.isWide, false);
      assert.match(c.reason, /id/);
    });
  });

  describe("under-threshold mix (50% period but only 2 cols) → not wide", () => {
    const headers = ["Brand", "Region", "Q1 2023", "Q2 2023"];
    const c = classifyDataset(headers);
    it("is NOT wide (need ≥3 period cols)", () => {
      assert.equal(c.isWide, false);
    });
  });
});
