import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripCurrencyAndParse,
  detectCurrencyInValues,
  isoForSymbol,
  AMBIGUOUS_SYMBOLS,
} from "../lib/wideFormat/currencyVocabulary.js";

describe("currencyVocabulary.stripCurrencyAndParse", () => {
  describe("Vietnamese đồng (the Marico-VN case)", () => {
    it("đ131,110,877,074 → 131110877074 (prefix VND)", () => {
      const r = stripCurrencyAndParse("đ131,110,877,074");
      assert.ok(r);
      assert.equal(r!.num, 131110877074);
      assert.equal(r!.symbol, "đ");
      assert.equal(r!.position, "prefix");
    });
    it("alternative ₫ symbol", () => {
      const r = stripCurrencyAndParse("₫500,000");
      assert.ok(r);
      assert.equal(r!.num, 500000);
      assert.equal(r!.symbol, "₫");
    });
  });

  describe("common single-character prefixes", () => {
    const cases: Array<[string, number, string]> = [
      ["$1,234.56", 1234.56, "$"],
      ["€1,000", 1000, "€"],
      ["£99.99", 99.99, "£"],
      ["¥10000", 10000, "¥"],
      ["₹500", 500, "₹"],
      ["₩1,500,000", 1500000, "₩"],
      ["฿250.50", 250.5, "฿"],
    ];
    for (const [input, expected, sym] of cases) {
      it(`${input} → ${expected} (${sym})`, () => {
        const r = stripCurrencyAndParse(input);
        assert.ok(r);
        assert.equal(r!.num, expected);
        assert.equal(r!.symbol, sym);
        assert.equal(r!.position, "prefix");
      });
    }
  });

  describe("multi-character compound prefixes", () => {
    const cases: Array<[string, number, string]> = [
      ["R$ 99", 99, "R$"],
      ["S$200", 200, "S$"],
      ["HK$1,000", 1000, "HK$"],
      ["RM 50.5", 50.5, "RM"],
      ["Rp 1,000,000", 1000000, "Rp"],
    ];
    for (const [input, expected, sym] of cases) {
      it(`${input} → ${expected} (${sym})`, () => {
        const r = stripCurrencyAndParse(input);
        assert.ok(r, `expected match for ${input}`);
        assert.equal(r!.num, expected);
        assert.equal(r!.symbol, sym);
      });
    }
  });

  describe("suffix symbols", () => {
    const cases: Array<[string, number, string]> = [
      ["1234 kr", 1234, "kr"],
      ["50zł", 50, "zł"],
      ["100 Ft", 100, "Ft"],
    ];
    for (const [input, expected, sym] of cases) {
      it(`${input} → ${expected} (${sym} suffix)`, () => {
        const r = stripCurrencyAndParse(input);
        assert.ok(r);
        assert.equal(r!.num, expected);
        assert.equal(r!.symbol, sym);
        assert.equal(r!.position, "suffix");
      });
    }
  });

  describe("plain numerics (no symbol)", () => {
    const cases: Array<[string, number]> = [
      ["1,234,567", 1234567],
      ["99.5", 99.5],
      ["-50", -50],
      ["1 000 000", 1000000],
      ["50%", 50],
      ["0", 0],
    ];
    for (const [input, expected] of cases) {
      it(`${input} → ${expected}`, () => {
        const r = stripCurrencyAndParse(input);
        assert.ok(r);
        assert.equal(r!.num, expected);
        assert.equal(r!.symbol, null);
        assert.equal(r!.position, null);
      });
    }
  });

  describe("non-numeric values", () => {
    for (const v of ["abc", "", "   ", "Q1 23", "Marico"]) {
      it(`${JSON.stringify(v)} → null`, () => {
        assert.equal(stripCurrencyAndParse(v), null);
      });
    }
  });
});

describe("currencyVocabulary.detectCurrencyInValues", () => {
  it("detects VND from a homogeneous đồng sample", () => {
    const samples = [
      "đ131,110,877,074",
      "đ40,874,904,511",
      "đ2,138,178,211,907",
      "đ95,064,500,503",
    ];
    const r = detectCurrencyInValues(samples);
    assert.ok(r);
    assert.equal(r!.isoCode, "VND");
    assert.equal(r!.symbol, "đ");
    assert.equal(r!.position, "prefix");
    assert.equal(r!.confidence, 1);
  });

  it("returns null for plain numerics", () => {
    const samples = ["1,000", "2,500", "3,000"];
    assert.equal(detectCurrencyInValues(samples), null);
  });

  it("returns null for mixed currencies (multi-currency column)", () => {
    const samples = ["$100", "$200", "€300", "€400", "£500", "£600"];
    // No symbol exceeds 80% threshold of symbol-bearing values.
    assert.equal(detectCurrencyInValues(samples), null);
  });

  it("ignores non-parseable rows when voting", () => {
    const samples = ["đ100", "đ200", "n/a", null, "đ300", ""];
    const r = detectCurrencyInValues(samples);
    assert.ok(r);
    assert.equal(r!.isoCode, "VND");
  });

  it("respects 80% threshold (75% → null)", () => {
    const samples = ["$1", "$2", "$3", "€4"]; // 3/4 = 75% USD, below 80%
    assert.equal(detectCurrencyInValues(samples), null);
  });
});

describe("currencyVocabulary.isoForSymbol + ambiguous set", () => {
  it("isoForSymbol covers expected mappings", () => {
    assert.equal(isoForSymbol("đ"), "VND");
    assert.equal(isoForSymbol("R$"), "BRL");
    assert.equal(isoForSymbol("Rp"), "IDR");
    assert.equal(isoForSymbol("kr"), "SEK");
    assert.equal(isoForSymbol("zzz"), null);
  });
  it("AMBIGUOUS_SYMBOLS marks $/kr/¥", () => {
    assert.ok(AMBIGUOUS_SYMBOLS.has("$"));
    assert.ok(AMBIGUOUS_SYMBOLS.has("kr"));
    assert.ok(AMBIGUOUS_SYMBOLS.has("¥"));
    assert.ok(!AMBIGUOUS_SYMBOLS.has("đ"));
  });
});
