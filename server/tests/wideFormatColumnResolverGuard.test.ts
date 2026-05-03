// WPF5 · Column resolver hardening. When the dataset was melted from wide
// format, agent-emitted references to original wide column names (e.g.
// "Q1 23 Value Sales") must NOT silently fuzzy-bind to a substring like
// "Value" on the long-form schema. Instead, refuse the match so downstream
// Zod / column-allowlist validation surfaces a clear error.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMatchingColumn } from "../lib/agents/utils/columnMatcher.js";
import { resolveToSchemaColumn } from "../lib/agents/runtime/plannerColumnResolve.js";
import type { WideFormatTransform } from "../shared/schema.js";

const transform: WideFormatTransform = {
  detected: true,
  shape: "compound",
  idColumns: ["Markets", "Products"],
  meltedColumns: [
    "Q1 23 Value Sales",
    "Q1 23 Volume",
    "Q2 23 Value Sales",
    "Q2 23 Volume",
  ],
  periodCount: 4,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  metricColumn: "Metric",
  detectedCurrencySymbol: "đ",
};

const liveSchema = ["Markets", "Products", "Period", "PeriodIso", "PeriodKind", "Value", "Metric"];
const liveColumns = liveSchema.map((name) => ({ name }));

describe("WPF5 · findMatchingColumn refuses stale wide-format names", () => {
  it("refuses an exact wide-format header that was melted away", () => {
    // Without the guard, "Q1 23 Value Sales" would substring-match "Value".
    const r = findMatchingColumn("Q1 23 Value Sales", liveSchema, {
      wideFormatTransform: transform,
    });
    assert.equal(r, null);
  });

  it("refuses case-insensitive variants of stale columns", () => {
    const r = findMatchingColumn("q1 23 volume", liveSchema, {
      wideFormatTransform: transform,
    });
    assert.equal(r, null);
  });

  it("still resolves a real column on the live schema", () => {
    const r = findMatchingColumn("Period", liveSchema, {
      wideFormatTransform: transform,
    });
    assert.equal(r, "Period");
  });

  it("still allows substring fuzzy match for non-stale searches", () => {
    // "metric" is not a melted column, so it should fuzzy-match the live
    // "Metric" column normally (case-insensitive exact).
    const r = findMatchingColumn("metric", liveSchema, {
      wideFormatTransform: transform,
    });
    assert.equal(r, "Metric");
  });

  it("legacy callers without options behave unchanged", () => {
    // Without the wideFormatTransform option, the legacy substring fuzzy
    // match still fires — exactly the silent-bind behavior WPF5 fixes when
    // callers opt in. This test pins backwards-compat: existing 11 callers
    // (chartSpecCompiler etc.) keep working unchanged until they migrate.
    const r = findMatchingColumn("Q1 23 Value Sales", liveSchema);
    // Reverse partial match: liveColumn "Value" is a substring of the search
    // (after normalization), so the matcher returns "Value". This is the
    // exact silent-bind bug — we tolerate it for legacy callers and only
    // close it when the caller passes options.
    assert.equal(r, "Value");
  });
});

describe("WPF5 · resolveToSchemaColumn refuses stale wide-format names", () => {
  it("returns the raw input (does not bind to a substring) for a stale column", () => {
    const r = resolveToSchemaColumn("Q1 23 Value Sales", liveColumns, transform);
    // Pre-fix: substring match would return "Value". Post-fix: returns raw
    // so downstream validation rejects loudly.
    assert.equal(r, "Q1 23 Value Sales");
  });

  it("still resolves a live column normally when no stale name match", () => {
    const r = resolveToSchemaColumn("metric", liveColumns, transform);
    assert.equal(r, "Metric");
  });

  it("works without wideFormatTransform (legacy two-arg call)", () => {
    const r = resolveToSchemaColumn("Period", liveColumns);
    assert.equal(r, "Period");
  });
});
