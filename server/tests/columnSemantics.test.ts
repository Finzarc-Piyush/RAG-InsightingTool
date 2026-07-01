import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyColumnSemantics,
  overlayLlmSemantics,
  SEMANTIC_TYPE_POLICY,
  type ClassifyColumnInput,
} from "../lib/columnSemantics.js";

function classify(over: Partial<ClassifyColumnInput> & { name: string }) {
  return classifyColumnSemantics({
    isNumericMember: false,
    isDateMember: false,
    ...over,
  });
}

// ── The user's exact failing columns (the Channel P&L) ──────────────────────

test('"Year"=26 → temporal_year, no aggregation (never averaged)', () => {
  const s = classify({
    name: "Year",
    isNumericMember: true,
    sampleValues: [26, 26, 26],
  });
  assert.equal(s.semanticType, "temporal_year");
  assert.equal(s.aggregation, "none");
  assert.equal(s.displayKind, "date");
  assert.equal(s.temporalGrain, "year");
});

test('"fy_month_number"=1 → ordinal, no aggregation (SS3: not averaged)', () => {
  const s = classify({
    name: "fy_month_number",
    isNumericMember: true,
    sampleValues: [1, 1, 1],
  });
  assert.equal(s.semanticType, "ordinal");
  assert.equal(s.aggregation, "none");
  assert.equal(s.displayKind, "ordinal");
});

test('"Month" (single date) → temporal_month, grain monthOrQuarter (SS1, not dayOrWeek)', () => {
  const s = classify({
    name: "Month",
    isDateMember: true,
    sampleValues: ["2026-04-01"],
    dates: [new Date(2026, 3, 1)],
  });
  assert.equal(s.semanticType, "temporal_month");
  assert.equal(s.displayKind, "date");
  assert.equal(s.temporalGrain, "monthOrQuarter");
});

test('"Quarter"="Q1" string → temporal_quarter (SS11: header says Quarter)', () => {
  const s = classify({
    name: "Quarter",
    isNumericMember: false,
    isDateMember: false,
    sampleValues: ["Q1", "Q1", "Q1"],
  });
  assert.equal(s.semanticType, "temporal_quarter");
  assert.equal(s.temporalGrain, "monthOrQuarter");
});

test("all-blank column → empty (SS4)", () => {
  const s = classify({ name: "month", sampleValues: [null, "", null] });
  assert.equal(s.semanticType, "empty");
  assert.equal(s.displayKind, "empty");
  assert.equal(s.aggregation, "none");
});

test('margin ratio (additivityKind ratio_percent) → measure_ratio_percent, avg not sum (SS5-7)', () => {
  const s = classify({
    name: "Retailer Margin",
    isNumericMember: true,
    additivityKind: "ratio_percent",
    additivity: "non_additive",
    sampleValues: [12, 15, 18],
  });
  assert.equal(s.semanticType, "measure_ratio_percent");
  assert.equal(s.aggregation, "avg");
});

test('ratio detected by NAME alone (before financeMetricAuthority fires)', () => {
  const s = classify({
    name: "Primary Scheme",
    isNumericMember: true,
    sampleValues: [3, 5, 7],
  });
  assert.equal(s.semanticType, "measure_ratio_percent");
  assert.equal(s.aggregation, "avg");
});

test('"Volume (KL)" → measure_additive, keeps sum (SS8: real skewed measure)', () => {
  const s = classify({
    name: "Volume (KL)",
    isNumericMember: true,
    sampleValues: [1.81, 194.5, 29100, -1.5],
  });
  assert.equal(s.semanticType, "measure_additive");
  assert.equal(s.aggregation, "sum");
  assert.equal(s.displayKind, "numeric");
});

test("currency-tagged column → currency_amount (sum)", () => {
  const s = classify({
    name: "MRP Value",
    isNumericMember: true,
    hasCurrency: true,
    sampleValues: [1663500, 3079404000],
  });
  assert.equal(s.semanticType, "currency_amount");
  assert.equal(s.aggregation, "sum");
});

// ── Identifiers / dimensions ────────────────────────────────────────────────

test("high-cardinality unique string → identifier", () => {
  const s = classify({
    name: "Brand_Code",
    sampleValues: ["H&C", "LIVON S-R", "MALT-NATU", "PA-ALO-HO"],
  });
  assert.equal(s.semanticType, "identifier");
});

test("low-cardinality string → categorical_dimension", () => {
  const s = classify({
    name: "Channel",
    sampleValues: ["GT", "MT", "GT", "E-Commerce", "MT"],
  });
  assert.equal(s.semanticType, "categorical_dimension");
});

test("boolean indicator → boolean_flag", () => {
  const s = classify({
    name: "active",
    isBooleanIndicator: true,
    sampleValues: ["Yes", "No"],
  });
  assert.equal(s.semanticType, "boolean_flag");
});

test('4-digit "Year" values do NOT get mis-typed as identifier (name wins)', () => {
  const s = classify({
    name: "Year",
    isNumericMember: true,
    sampleValues: [2021, 2022, 2023, 2024],
  });
  assert.equal(s.semanticType, "temporal_year");
});

// ── Policy table + LLM overlay ──────────────────────────────────────────────

test("SEMANTIC_TYPE_POLICY: ratio never sums, additive/currency sum, keys aggregate none", () => {
  assert.equal(SEMANTIC_TYPE_POLICY.measure_ratio_percent.aggregation, "avg");
  assert.equal(SEMANTIC_TYPE_POLICY.measure_additive.aggregation, "sum");
  assert.equal(SEMANTIC_TYPE_POLICY.currency_amount.aggregation, "sum");
  assert.equal(SEMANTIC_TYPE_POLICY.ordinal.aggregation, "none");
  assert.equal(SEMANTIC_TYPE_POLICY.temporal_year.aggregation, "none");
});

test("overlay: LLM refines a soft base but never demotes a hard signal", () => {
  const softBase = classify({
    name: "some_metric",
    isNumericMember: true,
    sampleValues: [10.5, 20.5, 10.5, 30.2, 20.5], // decimals + repeats → a real measure
  });
  assert.equal(softBase.semanticType, "measure_additive");
  const refined = overlayLlmSemantics(
    softBase,
    { semanticType: "temporal_year" },
    "some_metric",
  );
  assert.equal(refined.semanticType, "temporal_year");
  assert.equal(refined.source, "llm");

  const hardBase = classify({
    name: "Retailer Margin",
    isNumericMember: true,
    additivityKind: "ratio_percent",
    sampleValues: [12, 15],
  });
  const notDemoted = overlayLlmSemantics(
    hardBase,
    { semanticType: "measure_additive" },
    "Retailer Margin",
  );
  assert.equal(notDemoted.semanticType, "measure_ratio_percent");
  assert.equal(notDemoted.source, "deterministic");
});
