import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractNumbersFromNarrative,
  verifyNarrativeAgainstCharts,
} from "../lib/agents/runtime/verifyNarrativeNumbers.js";
import type { ChartSpec } from "../shared/schema.js";

/**
 * W7.5 · The verifier must catch fabricated numbers without flagging real ones.
 * Tolerance is the knob — if it's too tight we false-positive on rounding;
 * too loose and we miss hallucinations. Tests pin the contract.
 */

const numericChart = (data: Array<Record<string, unknown>>): ChartSpec => ({
  type: "bar",
  title: "test",
  x: "k",
  y: "v",
  data,
});

describe("extractNumbersFromNarrative", () => {
  it("extracts plain percentages", () => {
    const got = extractNumbersFromNarrative("Sales rose 12% in Q1 and dropped 5.4% in Q2.");
    const values = got.map((g) => g.value).sort((a, b) => a - b);
    assert.deepStrictEqual(values, [5.4, 12]);
  });

  it("extracts negative percentages", () => {
    const got = extractNumbersFromNarrative("Region X declined by -8.2% YoY.");
    assert.ok(got.some((g) => g.value === -8.2));
  });

  it("expands K/M/B suffixes on currency", () => {
    const got = extractNumbersFromNarrative("Total revenue was $4.2M last quarter.");
    assert.ok(got.some((g) => Math.abs(g.value - 4_200_000) < 1));
  });

  it("expands lakh / crore on Indian currency", () => {
    const got = extractNumbersFromNarrative("The team spent ₹4.2 lakh on tooling, plus ₹1 crore on infra.");
    const values = got.map((g) => g.value);
    assert.ok(values.some((v) => Math.abs(v - 420_000) < 1));
    assert.ok(values.some((v) => Math.abs(v - 10_000_000) < 1));
  });

  it("extracts large bare numbers with thousands separators", () => {
    const got = extractNumbersFromNarrative("9,800 rows were ingested.");
    assert.ok(got.some((g) => g.value === 9800));
  });

  it("ignores 4-digit years", () => {
    const got = extractNumbersFromNarrative("In 2024 sales rose by 15%.");
    const values = got.map((g) => g.value);
    assert.ok(!values.includes(2024));
    assert.ok(values.includes(15));
  });

  it("ignores tiny noise integers (≤ 5)", () => {
    const got = extractNumbersFromNarrative("Across 3 segments, the top 2 categories lifted by 14%.");
    const values = got.map((g) => g.value);
    assert.ok(!values.includes(3));
    assert.ok(!values.includes(2));
    assert.ok(values.includes(14));
  });

  it("does not double-count a value once it's been claimed by currency or percent", () => {
    const got = extractNumbersFromNarrative("Net sales of $500,000 grew 12%.");
    const values = got.map((g) => g.value).sort((a, b) => a - b);
    assert.deepStrictEqual(values, [12, 500_000]);
  });

  it("handles empty / non-string input", () => {
    assert.deepStrictEqual(extractNumbersFromNarrative(""), []);
  });
});

describe("verifyNarrativeAgainstCharts", () => {
  const tolerance = 0.02;

  it("marks every claim supported when no charts have numeric data (cannot verify)", () => {
    const r = verifyNarrativeAgainstCharts(
      "Sales rose 12%.",
      [numericChart([])],
      tolerance
    );
    assert.strictEqual(r.unsupported.length, 0);
  });

  it("supports a claim when it appears verbatim in chart data", () => {
    const r = verifyNarrativeAgainstCharts(
      "Q1 sales rose by 12%.",
      [numericChart([{ q: "Q1", growth: 12 }])],
      tolerance
    );
    assert.strictEqual(r.unsupported.length, 0);
    assert.strictEqual(r.supported.length, 1);
  });

  it("supports a claim within ±2% tolerance (rounding-friendly)", () => {
    // Narrative says 12% but chart row is 12.15 — within 2% tolerance.
    const r = verifyNarrativeAgainstCharts(
      "Q1 sales rose by 12%.",
      [numericChart([{ q: "Q1", growth: 12.15 }])],
      tolerance
    );
    assert.strictEqual(r.unsupported.length, 0);
  });

  it("flags a fabricated claim that no chart row supports", () => {
    const r = verifyNarrativeAgainstCharts(
      "Sales fell by 17% in March.",
      [numericChart([{ q: "Mar", growth: 4 }])],
      tolerance
    );
    assert.strictEqual(r.unsupported.length, 1);
    assert.strictEqual(r.supported.length, 0);
  });

  it("treats keyInsight values as supporting evidence", () => {
    const chart: ChartSpec = {
      ...numericChart([{ q: "Q1" }]),
      keyInsight: "Q1 contribution was 23.4% of FY revenue.",
    };
    const r = verifyNarrativeAgainstCharts(
      "Q1 was the largest quarter at 23.4% of FY revenue.",
      [chart],
      tolerance
    );
    assert.strictEqual(r.unsupported.length, 0);
  });

  it("handles a mix of supported + fabricated in one narrative", () => {
    const chart = numericChart([
      { region: "West", sales: 1_200_000 },
      { region: "East", sales: 850_000 },
    ]);
    const r = verifyNarrativeAgainstCharts(
      "West reached $1.2M (real) while East collapsed to $50,000 (fabricated).",
      [chart],
      tolerance
    );
    assert.strictEqual(r.totalClaims, 2);
    assert.strictEqual(r.supported.length, 1);
    assert.strictEqual(r.unsupported.length, 1);
    assert.strictEqual(r.unsupported[0].value, 50_000);
  });

  it("returns an empty result when narrative has no claims", () => {
    const r = verifyNarrativeAgainstCharts(
      "The data was inconclusive — no clear pattern emerged.",
      [numericChart([{ k: "x", v: 100 }])],
      tolerance
    );
    assert.strictEqual(r.totalClaims, 0);
    assert.strictEqual(r.unsupported.length, 0);
  });
});
