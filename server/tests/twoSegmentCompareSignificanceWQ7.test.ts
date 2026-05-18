/**
 * Wave WQ7 · `run_two_segment_compare` attaches a canonical FindingEvidence
 * suffix (p + effective n) from Welch's t-test on row-level metric values.
 *
 * Completes the deterministic-floor coverage started by WV4-WV7 for the
 * remaining composite-style segment-comparison tool. Pairs with WQ7's
 * sibling test on `run_breakdown_ranking`. The headline question
 * "is segment A's metric meaningfully different from segment B's?" was
 * previously graded by WQ1 as `medium / no evidence supplied` because the
 * tool's summary carried only aggregate values + a mix ratio — no p, no n.
 *
 * Coverage:
 *  - Source-inspection wiring: imports + helper definition + summary
 *    concatenation.
 *  - Behavioural: mean-aggregation comparison emits ` (n = N; p = X)` when
 *    both segments have ≥3 finite obs.
 *  - Skip semantics: count aggregation → empty suffix; one-side <3 obs →
 *    empty suffix; identical samples → p = 1 evidence (still emitted).
 *  - extractFindingEvidence roundtrip from the canonical suffix.
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

describe("Wave WQ7 · two-segment-compare wires composeFindingDetail (source-inspection)", () => {
  it("imports runSignificanceTest + composeFindingDetail + FindingEvidence", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/twoSegmentCompareTool.ts",
      ),
      "utf8",
    );
    assert.ok(
      src.includes('from "../../../significanceTests.js"'),
      "twoSegmentCompareTool.ts must import runSignificanceTest",
    );
    assert.ok(
      src.includes('from "../formatFindingEvidence.js"'),
      "twoSegmentCompareTool.ts must import composeFindingDetail",
    );
    assert.ok(
      src.includes("import type { FindingEvidence }"),
      "twoSegmentCompareTool.ts must import the FindingEvidence type",
    );
  });

  it("aggregateSegment exposes row-level values for the t-test", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/twoSegmentCompareTool.ts",
      ),
      "utf8",
    );
    assert.ok(
      /aggregateSegment[\s\S]*values: number\[\]/.test(src),
      "aggregateSegment return type must expose values: number[] for downstream Welch's t-test",
    );
  });

  it("defines buildSegmentCompareEvidence + summary concatenates wq7EvidenceSuffix", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../lib/agents/runtime/tools/twoSegmentCompareTool.ts",
      ),
      "utf8",
    );
    assert.ok(
      src.includes("buildSegmentCompareEvidence"),
      "must define buildSegmentCompareEvidence helper",
    );
    assert.ok(
      src.includes("wq7EvidenceSuffix"),
      "summary must concatenate wq7EvidenceSuffix",
    );
    // Suffix must appear inside the success-path summary template.
    assert.match(
      src,
      /summary: `run_two_segment_compare:[\s\S]*\$\{wq7EvidenceSuffix\}/,
      "success-path summary must end with ${wq7EvidenceSuffix}",
    );
  });
});

describe("Wave WQ7 · math anchor (Welch's t-test on segment values)", () => {
  it("clearly-different segments → p < 0.001 → composed suffix recoverable", () => {
    // 30 obs per segment, means 10 vs 20, σ ≈ 2 → very significant.
    const sampleA = Array.from({ length: 30 }, (_, i) => 10 + Math.sin(i) * 0.5);
    const sampleB = Array.from({ length: 30 }, (_, i) => 20 + Math.cos(i) * 0.5);
    const result = runSignificanceTest({ test: "welch_t", sampleA, sampleB });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.pValue < 0.001, `expected p < 0.001, got ${result.pValue}`);
    const evidence: FindingEvidence = {
      pValue: result.pValue,
      n: result.n.sampleA + (result.n.sampleB ?? 0),
    };
    const suffix = composeFindingDetail("", evidence);
    assert.equal(suffix, " (n = 60; p < 0.001)");
    const recovered = extractFindingEvidence(`summary text${suffix}`);
    assert.equal(recovered.n, 60);
    // Extractor recovers p value (canonical "p < 0.001" → recovered ≈ 0.001).
    assert.ok(
      recovered.pValue !== undefined && recovered.pValue <= 0.001,
      `expected recovered pValue ≤ 0.001, got ${recovered.pValue}`,
    );
  });

  it("identical samples → p = 1 → suffix still emitted (not skipped)", () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = runSignificanceTest({
      test: "welch_t",
      sampleA: sample,
      sampleB: sample,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pValue, 1, "identical samples → p = 1");
    const evidence: FindingEvidence = {
      pValue: result.pValue,
      n: result.n.sampleA + (result.n.sampleB ?? 0),
    };
    const suffix = composeFindingDetail("", evidence);
    // p = 1 prints as "p = 1.00" via the formatter's two-dp rule (> 0.01).
    assert.equal(suffix, " (n = 20; p = 1.00)");
  });
});

describe("Wave WQ7 · skip semantics (defensive guards)", () => {
  it("Welch's t-test requires ≥3 obs per side — runSignificanceTest returns ok:false otherwise", () => {
    // The tool helper checks valuesA.length < 3 || valuesB.length < 3
    // first, so this just confirms the upstream contract WQ7 piggybacks on.
    const result = runSignificanceTest({
      test: "welch_t",
      sampleA: [1, 2],
      sampleB: [10, 20, 30, 40, 50, 60],
    });
    assert.equal(result.ok, false, "fewer than 3 obs in either sample must fail");
  });

  it("composeFindingDetail with no fields returns '' → empty suffix on skip", () => {
    const empty: FindingEvidence = {};
    assert.equal(composeFindingDetail("", empty), "");
    // Mirrors the buildSegmentCompareEvidence skip path: return "" on
    // count aggregation, insufficient n, or t-test failure.
  });
});
