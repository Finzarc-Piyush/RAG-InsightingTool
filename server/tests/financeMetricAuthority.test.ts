import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyMetric,
  isNonAdditiveMetric,
  metricAdditivity,
  normalizeMetricTokens,
  resolveFinanceTerm,
  aggregationPolicyFor,
  buildIdentityGraph,
  areStructurallyRelated,
  gradeFromEvidenceKind,
  FINANCE_TERMS,
} from "../lib/financeMetricAuthority.js";

/**
 * W1 · the finance/metric-semantics authority. These pin the bug the three
 * legacy rate-regexes all shared: a column literally named "GC%" (the `\b`
 * boundary never matches "%") was treated as additive and SUMMED across
 * channels. The authority's `%`→`pct` normaliser fixes that, and every
 * surface form of a ratio resolves to the SAME canonical term.
 */
describe("normalizeMetricTokens — the %→pct / &→and rewrite", () => {
  it("maps the literal % to a 'pct' token (the legacy-regex miss)", () => {
    assert.deepEqual(normalizeMetricTokens("GC%"), ["gc", "pct"]);
    assert.deepEqual(normalizeMetricTokens("GC %"), ["gc", "pct"]);
    assert.deepEqual(normalizeMetricTokens("gc_pct"), ["gc", "pct"]);
    assert.deepEqual(normalizeMetricTokens("Gross Contribution %"), ["gross", "contribution", "pct"]);
  });
  it("maps & to 'and'", () => {
    assert.deepEqual(normalizeMetricTokens("A&P %"), ["a", "and", "p", "pct"]);
  });
});

describe("resolveFinanceTerm — longest-alias-wins disambiguation", () => {
  it("all GC% surface forms resolve to gross_contribution_pct", () => {
    for (const name of ["GC%", "GC %", "gc_pct", "Gross Contribution %", "Gross Contribution Margin"]) {
      assert.equal(resolveFinanceTerm(name)?.id, "gross_contribution_pct", `failed for ${name}`);
    }
  });
  it("bare 'GC' resolves to the additive gross_contribution, not the %", () => {
    assert.equal(resolveFinanceTerm("GC")?.id, "gross_contribution");
    assert.equal(resolveFinanceTerm("Gross Contribution")?.id, "gross_contribution");
  });
  it("'Volume Share' beats 'Volume' (specific ratio over additive)", () => {
    assert.equal(resolveFinanceTerm("Volume Share")?.id, "volume_share_pct");
    assert.equal(resolveFinanceTerm("Volume")?.id, "volume");
  });
  it("records numerator/denominator for ratios", () => {
    const gcp = FINANCE_TERMS.find((t) => t.id === "gross_contribution_pct")!;
    assert.equal(gcp.numerator, "gross_contribution");
    assert.equal(gcp.denominator, "net_revenue");
  });
});

describe("isNonAdditiveMetric / metricAdditivity", () => {
  const nonAdditive = ["GC%", "Gross Contribution %", "EBITDA Margin", "Value Share", "Channel Mix", "YoY Growth", "ASP", "Realization", "Adherence Rate"];
  const additive = ["Net Revenue", "NR", "GSV", "COGS", "Volume", "Gross Contribution", "EBITDA", "A&P Spend"];

  it("flags ratio / per-unit / mix / growth as non-additive", () => {
    for (const n of nonAdditive) assert.equal(isNonAdditiveMetric(n), true, `${n} should be non-additive`);
  });
  it("keeps absolute amounts additive", () => {
    for (const n of additive) assert.equal(isNonAdditiveMetric(n), false, `${n} should be additive`);
  });
  it("catch-all: an unknown '<x> rate' / '<x> %' is still non-additive (no regression)", () => {
    assert.equal(isNonAdditiveMetric("Fulfilment Rate"), true);
    assert.equal(isNonAdditiveMetric("Some Weird %"), true);
  });

  it("structured-first: format 'percent' wins even on an additive-looking name", () => {
    assert.equal(metricAdditivity({ format: "percent", expression: "SUM(x)" }), "non_additive");
    assert.equal(metricAdditivity({ format: "currency", expression: "SUM(x)" }), "additive");
  });
  it("structured-first: a division expression marks non-additive", () => {
    assert.equal(
      classifyMetric("blended", { format: "number", expression: "SUM(gc) / NULLIF(SUM(nr), 0)" }).additivity,
      "non_additive",
    );
    assert.equal(
      classifyMetric("total", { format: "number", expression: "SUM(gc) - SUM(cogs)" }).additivity,
      "additive",
    );
  });
});

describe("aggregationPolicyFor — the non-additive ladder", () => {
  it("additive metric ⇒ sum", () => {
    assert.deepEqual(aggregationPolicyFor("Net Revenue"), { op: "sum" });
    assert.deepEqual(aggregationPolicyFor("Volume"), { op: "sum" });
  });
  it("GC% with the denominator (NR) on the frame ⇒ weighted_mean (scale-preserving)", () => {
    const p = aggregationPolicyFor("GC%", { frameColumns: ["Channel", "GC", "Net Revenue", "GC%"] });
    assert.deepEqual(p, { op: "weighted_mean", weightColumn: "Net Revenue" });
  });
  it("GC% with neither part on the frame ⇒ mean (last resort, never sum)", () => {
    const p = aggregationPolicyFor("GC%", { frameColumns: ["Channel", "GC%"] });
    assert.deepEqual(p, { op: "mean" });
  });
  it("a growth/mix ratio with no parts ⇒ mean, never sum", () => {
    assert.deepEqual(aggregationPolicyFor("YoY Growth", { frameColumns: ["Month", "YoY Growth"] }), { op: "mean" });
  });
});

describe("buildIdentityGraph + areStructurallyRelated — tautology detection", () => {
  const graph = buildIdentityGraph({ columns: ["Channel", "GC", "Net Revenue", "COGS", "GC%", "A&P Spend"] });

  it("GC% ↔ Net Revenue are structurally related (denominator) — the tautology", () => {
    const r = areStructurallyRelated("GC%", "Net Revenue", graph);
    assert.equal(r.related, true);
    assert.equal(r.kind, "denominator");
  });
  it("relation is symmetric", () => {
    assert.equal(areStructurallyRelated("Net Revenue", "GC%", graph).related, true);
  });
  it("GC ↔ COGS related (component); GC ↔ Net Revenue related (component)", () => {
    assert.equal(areStructurallyRelated("GC", "COGS", graph).related, true);
    assert.equal(areStructurallyRelated("GC", "Net Revenue", graph).related, true);
  });
  it("A&P spend ↔ Net Revenue are NOT structurally related (a genuine relationship)", () => {
    assert.equal(areStructurallyRelated("A&P Spend", "Net Revenue", graph).related, false);
  });
  it("unknown columns are not related", () => {
    assert.equal(areStructurallyRelated("Foo", "Bar", graph).related, false);
  });
});

describe("gradeFromEvidenceKind", () => {
  it("maps evidence kinds to causation grade", () => {
    assert.equal(gradeFromEvidenceKind("variance_decomposition"), "decomposition");
    assert.equal(gradeFromEvidenceKind("compute_growth"), "temporal_leadlag");
    assert.equal(gradeFromEvidenceKind("segment_driver"), "controlled_comparison");
    assert.equal(gradeFromEvidenceKind("domain_pack"), "domain_mechanism");
    assert.equal(gradeFromEvidenceKind("run_correlation"), "association_only");
    assert.equal(gradeFromEvidenceKind(undefined), "association_only");
  });
});
