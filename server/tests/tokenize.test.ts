import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenize, ngrams } from "../lib/wideFormat/tokenize.js";

describe("tokenize", () => {
  const cases: Array<[string, string[]]> = [
    ["Jan 2024 Value Sales", ["Jan", "2024", "Value", "Sales"]],
    ["Value_Sales|Q1-2024", ["Value", "Sales", "Q1", "2024"]],
    ["Brand Name (Market)", ["Brand", "Name", "Market"]],
    ["Wtd Dist - MAT Dec'24", ["Wtd", "Dist", "MAT", "Dec'24"]],
    ["2024/03 Volume", ["2024", "03", "Volume"]],
    ["Value Sales, MAT", ["Value", "Sales", "MAT"]],
    ["MS Val (%)", ["MS", "Val", "%"]],
    ["  spaced  out  ", ["spaced", "out"]],
    ["single", ["single"]],
    ["", []],
  ];

  for (const [input, expected] of cases) {
    it(`tokenize(${JSON.stringify(input)})`, () => {
      assert.deepEqual(tokenize(input), expected);
    });
  }

  it("preserves original case", () => {
    assert.deepEqual(tokenize("BRAND a Market"), ["BRAND", "a", "Market"]);
  });

  it("keeps apostrophe-year tokens intact", () => {
    const toks = tokenize("Sales Dec'24");
    assert.deepEqual(toks, ["Sales", "Dec'24"]);
  });

  it("handles non-string input defensively", () => {
    assert.deepEqual(tokenize(null as unknown as string), []);
    assert.deepEqual(tokenize(undefined as unknown as string), []);
  });
});

describe("ngrams", () => {
  it("emits tri/bi/uni-grams by default, most-specific first", () => {
    const out = ngrams(["A", "B", "C", "D"]);
    assert.deepEqual(out, [
      "A B C", "B C D",
      "A B", "B C", "C D",
      "A", "B", "C", "D",
    ]);
  });

  it("respects custom size order", () => {
    const out = ngrams(["A", "B", "C"], [1, 2]);
    assert.deepEqual(out, ["A", "B", "C", "A B", "B C"]);
  });

  it("ignores sizes larger than the token list", () => {
    assert.deepEqual(ngrams(["A"], [3, 2, 1]), ["A"]);
  });

  it("returns empty on empty input", () => {
    assert.deepEqual(ngrams([]), []);
  });

  it("drops sizes < 1", () => {
    assert.deepEqual(ngrams(["A", "B"], [0, -1, 1]), ["A", "B"]);
  });
});
