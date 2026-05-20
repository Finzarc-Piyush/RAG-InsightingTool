/**
 * Wave W61-source-bump · per-entry content-hash diff that marks
 * admin-edited semantic-model entries as `source: "user"` while
 * preserving the prior source on unchanged entries.
 *
 * The controller test in `adminSemanticModelPatchW61Save.test.ts`
 * covers the end-to-end PATCH path; these tests pin the pure
 * helper's behaviour on every change / preserve combination so
 * future refactors don't regress the source-weighting signal the
 * planner reads via `buildSemanticCatalogPromptBlock`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bumpDimensionsSource,
  bumpHierarchiesSource,
  bumpMetricsSource,
} from "../lib/semantic/semanticModelSourceBump.js";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
} from "../shared/schema.js";

function metric(
  overrides: Partial<SemanticMetric> & { name: string },
): SemanticMetric {
  return {
    name: overrides.name,
    label: overrides.label ?? "Default label",
    expression: overrides.expression ?? "SUM(x)",
    references: overrides.references ?? [],
    format: overrides.format ?? "number",
    currencyCode: overrides.currencyCode,
    decimals: overrides.decimals,
    description: overrides.description,
    exposed: overrides.exposed ?? true,
    source: overrides.source ?? "auto",
  };
}

function dimension(
  overrides: Partial<SemanticDimension> & { name: string },
): SemanticDimension {
  return {
    name: overrides.name,
    label: overrides.label ?? "Default label",
    column: overrides.column ?? "col_x",
    kind: overrides.kind ?? "categorical",
    temporalGrain: overrides.temporalGrain,
    description: overrides.description,
    exposed: overrides.exposed ?? true,
    source: overrides.source ?? "auto",
  };
}

function hierarchy(
  overrides: Partial<SemanticHierarchy> & { name: string },
): SemanticHierarchy {
  return {
    name: overrides.name,
    label: overrides.label ?? "Default label",
    levels: overrides.levels ?? ["a", "b"],
    description: overrides.description,
    source: overrides.source ?? "auto",
  };
}

test("W61-source-bump · metric unchanged: prior auto source preserved", () => {
  const prior = [metric({ name: "revenue", label: "Revenue" })];
  const next = [metric({ name: "revenue", label: "Revenue" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "auto");
});

test("W61-source-bump · metric unchanged: prior domain source preserved (NOT silently bumped)", () => {
  const prior = [
    metric({ name: "ad_spend", label: "Ad spend", source: "domain" }),
  ];
  const next = [metric({ name: "ad_spend", label: "Ad spend" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "domain");
});

test("W61-source-bump · metric label change: bumps to user", () => {
  const prior = [metric({ name: "revenue", label: "Revenue" })];
  const next = [metric({ name: "revenue", label: "Gross Revenue" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · metric expression change: bumps to user", () => {
  const prior = [metric({ name: "rev", expression: "AVG(amount)" })];
  const next = [metric({ name: "rev", expression: "SUM(amount)" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · metric exposed toggle: bumps to user", () => {
  const prior = [metric({ name: "rev", exposed: true })];
  const next = [metric({ name: "rev", exposed: false })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · metric format change clears stale currencyCode + bumps source", () => {
  const prior = [metric({ name: "rev", format: "currency", currencyCode: "USD" })];
  const next = [metric({ name: "rev", format: "percent" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "user");
  assert.equal(result[0].format, "percent");
});

test("W61-source-bump · new metric (no prior match): preserves client-sent source", () => {
  const prior: SemanticMetric[] = [];
  const next = [metric({ name: "new_metric", source: "user" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · new metric defaults to client-sent 'auto' if that's what's passed", () => {
  const prior: SemanticMetric[] = [];
  const next = [metric({ name: "imported", source: "auto" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "auto");
});

test("W61-source-bump · mixed: unchanged + changed + new in same array each behave correctly", () => {
  const prior = [
    metric({ name: "a", label: "A", source: "auto" }),
    metric({ name: "b", label: "B", source: "domain" }),
    metric({ name: "c", label: "C", source: "user" }),
  ];
  const next = [
    metric({ name: "a", label: "A" }), // unchanged
    metric({ name: "b", label: "B (edited)" }), // changed
    metric({ name: "c", label: "C" }), // unchanged
    metric({ name: "d", label: "D", source: "auto" }), // new
  ];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "auto", "a: unchanged auto preserved");
  assert.equal(result[1].source, "user", "b: changed bumps from domain to user");
  assert.equal(result[2].source, "user", "c: unchanged user preserved");
  assert.equal(result[3].source, "auto", "d: new preserves client-sent source");
});

test("W61-source-bump · prior user-edited metric stays user on unchanged round-trip", () => {
  const prior = [metric({ name: "rev", label: "Rev (edited)", source: "user" })];
  const next = [metric({ name: "rev", label: "Rev (edited)" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · dimension unchanged: auto preserved", () => {
  const prior = [dimension({ name: "region", kind: "categorical" })];
  const next = [dimension({ name: "region", kind: "categorical" })];
  const result = bumpDimensionsSource(next, prior);
  assert.equal(result[0].source, "auto");
});

test("W61-source-bump · dimension kind change: bumps to user", () => {
  const prior = [dimension({ name: "month", kind: "categorical" })];
  const next = [dimension({ name: "month", kind: "temporal" })];
  const result = bumpDimensionsSource(next, prior);
  assert.equal(result[0].source, "user");
  assert.equal(result[0].kind, "temporal");
});

test("W61-source-bump · dimension temporal grain change: bumps to user", () => {
  const prior = [
    dimension({ name: "month", kind: "temporal", temporalGrain: "day" }),
  ];
  const next = [
    dimension({ name: "month", kind: "temporal", temporalGrain: "month" }),
  ];
  const result = bumpDimensionsSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · dimension description change: bumps to user", () => {
  const prior = [dimension({ name: "region", description: undefined })];
  const next = [dimension({ name: "region", description: "Sales region" })];
  const result = bumpDimensionsSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · hierarchy unchanged: auto preserved", () => {
  const prior = [hierarchy({ name: "geo", levels: ["country", "region"] })];
  const next = [hierarchy({ name: "geo", levels: ["country", "region"] })];
  const result = bumpHierarchiesSource(next, prior);
  assert.equal(result[0].source, "auto");
});

test("W61-source-bump · hierarchy levels reorder: bumps to user", () => {
  const prior = [
    hierarchy({ name: "geo", levels: ["country", "region", "city"] }),
  ];
  const next = [
    hierarchy({ name: "geo", levels: ["region", "country", "city"] }),
  ];
  const result = bumpHierarchiesSource(next, prior);
  assert.equal(result[0].source, "user");
});

test("W61-source-bump · empty arrays handled cleanly", () => {
  assert.deepEqual(bumpMetricsSource([], []), []);
  assert.deepEqual(bumpDimensionsSource([], []), []);
  assert.deepEqual(bumpHierarchiesSource([], []), []);
});

test("W61-source-bump · prior entries deleted (not in next) are silently dropped — no surprise insertion", () => {
  const prior = [
    metric({ name: "a", source: "user" }),
    metric({ name: "b", source: "user" }),
  ];
  const next = [metric({ name: "a", source: "user" })];
  const result = bumpMetricsSource(next, prior);
  assert.equal(result.length, 1, "no orphan re-insertion of deleted entries");
  assert.equal(result[0].name, "a");
});

test("W61-source-bump · function does not mutate input arrays", () => {
  const prior = [metric({ name: "a", label: "A", source: "auto" })];
  const next = [metric({ name: "a", label: "A (changed)" })];
  bumpMetricsSource(next, prior);
  assert.equal(prior[0].source, "auto", "prior array untouched");
  assert.equal(next[0].source, "auto", "next array untouched (returns new array)");
});
