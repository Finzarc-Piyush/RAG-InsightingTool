/**
 * pickPreferredMetricValue — the single "which metric value do we default to"
 * picker. Pins that the former inline copies (pivotDefaultsFromExecution +
 * planArgRepairs) now agree, including on a "Turnover" metric (the value one
 * copy omitted, causing the disagreement finding #24 flagged).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickPreferredMetricValue,
  VALUE_SALES_METRIC_RE,
} from "../lib/factsMetricResolver.js";

describe("pickPreferredMetricValue", () => {
  it("prefers the value-sales family over volume", () => {
    assert.equal(
      pickPreferredMetricValue(["Volume Sales", "Value Sales", "Distribution"]),
      "Value Sales"
    );
  });

  it("treats Turnover / GMV / Revenue as value-sales family (the consistency fix)", () => {
    assert.equal(pickPreferredMetricValue(["Volume Sales", "Turnover"]), "Turnover");
    assert.equal(pickPreferredMetricValue(["Units", "GMV"]), "GMV");
    assert.equal(pickPreferredMetricValue(["Distribution", "Revenue"]), "Revenue");
  });

  it("falls back to the first value when no value-sales family member is present", () => {
    assert.equal(
      pickPreferredMetricValue(["Distribution", "Volume Sales"]),
      "Distribution"
    );
  });

  it("returns undefined for an empty list", () => {
    assert.equal(pickPreferredMetricValue([]), undefined);
  });

  it("VALUE_SALES_METRIC_RE matches the family and not volume/distribution", () => {
    for (const v of ["Value Sales", "Sales Value", "Revenue", "Turnover", "GMV", "Sales"]) {
      assert.ok(VALUE_SALES_METRIC_RE.test(v), `matches: ${v}`);
    }
    for (const v of ["Volume Sales", "Distribution", "Units"]) {
      assert.ok(!VALUE_SALES_METRIC_RE.test(v), `no match: ${v}`);
    }
  });
});
