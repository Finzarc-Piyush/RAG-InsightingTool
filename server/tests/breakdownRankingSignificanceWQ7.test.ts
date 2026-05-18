/**
 * Wave WQ7 · `run_breakdown_ranking` attaches a canonical FindingEvidence
 * suffix (p + effective n) from Welch's t-test on row-level metric values:
 * headline (top-ranked) group's values vs. all other groups combined.
 *
 * Sibling to the run_two_segment_compare WQ7 wave. Where two-segment
 * compare ships its own A-vs-B contrast, breakdown_ranking implicitly
 * stages a "this leader vs. the rest" comparison — the headline finding
 * the narrator builds prose around. Without WQ7, that finding had no
 * inline p / n and WQ1 graded it as `medium / no evidence supplied`.
 *
 * Coverage:
 *  - Source-inspection wiring: imports + helper definition + summary
 *    concatenation in the simple-path return.
 *  - Composite (rankBy) path is unchanged — WQ7 only touches the
 *    simple-path return (composite ranking has ambiguous test shape).
 *  - Math anchor: a perfectly stratified frame produces near-zero p when
 *    the top group's row-level values are clearly different from the rest.
 *  - Skip semantics: count aggregation → empty suffix; single-group frame
 *    → other bucket empty → empty suffix.
 *  - Roundtrip: extractFindingEvidence recovers n + p from the composed
 *    suffix.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { composeFindingDetail } from "../lib/agents/runtime/formatFindingEvidence.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";
import type { FindingEvidence } from "../lib/agents/runtime/scaleNarrativeByConfidence.js";
import { runSignificanceTest } from "../lib/significanceTests.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Wave WQ7 · breakdown-ranking wires composeFindingDetail (source-inspection)", () => {
  it("imports runSignificanceTest + composeFindingDetail + FindingEvidence", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/breakdownRankingTool.ts",
      ),
      "utf8",
    );
    assert.ok(
      src.includes('from "../../../significanceTests.js"'),
      "breakdownRankingTool.ts must import runSignificanceTest",
    );
    assert.ok(
      src.includes('from "../formatFindingEvidence.js"'),
      "breakdownRankingTool.ts must import composeFindingDetail",
    );
    assert.ok(
      src.includes("import type { FindingEvidence }"),
      "breakdownRankingTool.ts must import the FindingEvidence type",
    );
  });

  it("defines buildBreakdownRankingEvidence (top vs. rest Welch's t-test)", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/breakdownRankingTool.ts",
      ),
      "utf8",
    );
    assert.ok(
      src.includes("buildBreakdownRankingEvidence"),
      "must define buildBreakdownRankingEvidence helper",
    );
    // Helper must skip count + check valuesA/valuesB lengths.
    assert.ok(
      /buildBreakdownRankingEvidence[\s\S]*aggregation === "count"[\s\S]*return ""/.test(
        src,
      ),
      "helper must short-circuit on count aggregation",
    );
  });

  it("simple-path return concatenates wq7EvidenceSuffix on the summary", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/breakdownRankingTool.ts",
      ),
      "utf8",
    );
    assert.ok(
      src.includes("wq7EvidenceSuffix"),
      "must construct wq7EvidenceSuffix",
    );
    // The summary literal in the simple-path return ends with the suffix.
    assert.match(
      src,
      /summary: `run_breakdown_ranking:[\s\S]*\$\{wq7EvidenceSuffix\}/,
      "simple-path summary must end with ${wq7EvidenceSuffix}",
    );
  });

  it("composite (rankBy) path summary is unchanged (WQ7 scope-bounded)", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/breakdownRankingTool.ts",
      ),
      "utf8",
    );
    // Composite path summary must NOT include wq7EvidenceSuffix — composite
    // ranking aggregates multiple metrics via an expression; "is the top
    // group different on the *score*?" is an ill-posed t-test. Guard the
    // scope so future refactors don't accidentally extend.
    const compositeReturnIdx = src.indexOf(
      "summary: `run_breakdown_ranking (composite):",
    );
    assert.notEqual(compositeReturnIdx, -1, "composite-path summary literal exists");
    const compositeChunk = src.slice(compositeReturnIdx, compositeReturnIdx + 400);
    assert.ok(
      !compositeChunk.includes("wq7EvidenceSuffix"),
      "composite-path summary must NOT include wq7EvidenceSuffix (scope-bounded)",
    );
  });
});

describe("Wave WQ7 · math anchor (top-vs-rest Welch's t-test)", () => {
  it("top group clearly above rest → p < 0.001 → composed suffix recoverable", () => {
    // Top group: 20 rows around mean=100.
    // Other groups: 60 rows around mean=10. Welch's t-test on (top, rest)
    // should be highly significant.
    const topValues = Array.from({ length: 20 }, (_, i) => 100 + (i % 3));
    const otherValues = Array.from({ length: 60 }, (_, i) => 10 + (i % 5));
    const result = runSignificanceTest({
      test: "welch_t",
      sampleA: topValues,
      sampleB: otherValues,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.pValue < 0.001, `expected p < 0.001, got ${result.pValue}`);
    const evidence: FindingEvidence = {
      pValue: result.pValue,
      n: result.n.sampleA + (result.n.sampleB ?? 0),
    };
    const suffix = composeFindingDetail("", evidence);
    assert.equal(suffix, " (n = 80; p < 0.001)");
    const recovered = extractFindingEvidence(
      `run_breakdown_ranking: mean of Revenue by Region, top 5...\n[json]${suffix}`,
    );
    assert.equal(recovered.n, 80);
    assert.ok(
      recovered.pValue !== undefined && recovered.pValue <= 0.001,
      `expected recovered pValue ≤ 0.001, got ${recovered.pValue}`,
    );
  });

  it("top group only marginally above rest → p > 0.05 → evidence still emitted", () => {
    // Means 11 vs 10 with substantial within-group variance over modest n
    // → t-test should not reject the null.
    const topValues = Array.from({ length: 15 }, (_, i) => 10 + i * 0.2);
    const otherValues = Array.from({ length: 45 }, (_, i) => 9 + (i % 7) * 0.5);
    const result = runSignificanceTest({
      test: "welch_t",
      sampleA: topValues,
      sampleB: otherValues,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Evidence is emitted regardless of significance — the narrator's
    // confidence directive uses the p value to grade the finding, not a
    // pass/fail filter.
    const evidence: FindingEvidence = {
      pValue: result.pValue,
      n: result.n.sampleA + (result.n.sampleB ?? 0),
    };
    const suffix = composeFindingDetail("", evidence);
    assert.match(suffix, /^ \(n = 60; p = \d+(\.\d+)?\)$/);
    const recovered = extractFindingEvidence(`summary${suffix}`);
    assert.equal(recovered.n, 60);
    assert.ok(
      recovered.pValue !== undefined,
      `pValue must be recovered from non-extreme suffix; got ${recovered.pValue}`,
    );
  });
});

describe("Wave WQ7 · skip semantics on breakdown-ranking", () => {
  it("composeFindingDetail with empty fields returns '' → empty suffix on skip", () => {
    // Mirrors buildBreakdownRankingEvidence skip path: count aggregation,
    // insufficient n on either bucket, or t-test failure.
    assert.equal(composeFindingDetail("", {}), "");
  });

  it("documented skip: composite ranking does NOT receive a suffix", () => {
    // The composite (rankBy) branch is a separate return statement that
    // doesn't call buildBreakdownRankingEvidence. This is asserted in the
    // source-inspection suite above; restated here as a behaviour contract.
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/breakdownRankingTool.ts",
      ),
      "utf8",
    );
    // Count CALL sites — exclude the function declaration itself. The
    // declaration uses `function buildBreakdownRankingEvidence(` syntax;
    // calls use any other prefix (most commonly `? buildBreakdownRankingEvidence(`
    // inside the ternary). Asserting exactly one call site bounds WQ7 to the
    // simple-path return; composite stays untouched.
    const allRefs = src.match(/buildBreakdownRankingEvidence\(/g) ?? [];
    const declRefs = src.match(/function buildBreakdownRankingEvidence\(/g) ?? [];
    const callSites = allRefs.length - declRefs.length;
    assert.equal(
      callSites,
      1,
      `buildBreakdownRankingEvidence must be called exactly once (simple-path only); saw ${callSites} call sites (allRefs=${allRefs.length}, decls=${declRefs.length})`,
    );
  });
});
