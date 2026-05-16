/**
 * Wave WV4 · `run_correlation` migrated to WV2's `composeFindingDetail`.
 *
 * Confirms the canonical FindingEvidence suffix now appears on the tool's
 * `summary` string when correlations are produced, so the downstream
 * blackboard `addFinding` carries deterministic evidence the WW2 extractor
 * catches and WQ1 grades on real numbers (R², n) — not the default
 * "medium / no evidence supplied" fallback.
 *
 * Coverage:
 *  - `analyzeCorrelations` now exposes `topCorrelations` (CorrelationResult[]).
 *    Sorted by |r| descending; first entry is the strongest correlation.
 *  - The FindingEvidence built from the strongest correlation roundtrips
 *    through `composeFindingDetail` → `extractFindingEvidence` modulo
 *    display rounding.
 *  - registerTools.ts wires composeFindingDetail at the run_correlation
 *    success path (source-inspection).
 *  - calculateCorrelations on a perfect-linear frame produces r = 1 and
 *    nPairs = N — the math anchor the wave depends on.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { calculateCorrelations } from "../lib/correlationMath.js";
import { composeFindingDetail } from "../lib/agents/runtime/formatFindingEvidence.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";
import type { FindingEvidence } from "../lib/agents/runtime/scaleNarrativeByConfidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Wave WV4 · calculateCorrelations anchor (math the tool relies on)", () => {
  it("produces r ≈ 1 and nPairs = N for a perfect linear frame", () => {
    const N = 100;
    const data = Array.from({ length: N }, (_, i) => ({
      Sales: i + 1,
      Price: 2 * (i + 1),
      Spend: 3 * (i + 1) + 7, // also perfectly correlated
    }));
    const results = calculateCorrelations(data, "Sales", [
      "Sales",
      "Price",
      "Spend",
    ]);
    assert.equal(results.length, 2, "target column is skipped");
    for (const r of results) {
      assert.ok(Math.abs(r.correlation - 1) < 1e-9, `expected r ≈ 1 for ${r.variable}`);
      assert.equal(r.nPairs, N);
    }
  });

  it("anti-correlation yields r ≈ -1 and rSquared ≈ 1", () => {
    const N = 40;
    const data = Array.from({ length: N }, (_, i) => ({
      A: i,
      B: 100 - i,
    }));
    const results = calculateCorrelations(data, "A", ["A", "B"]);
    assert.equal(results.length, 1);
    assert.ok(Math.abs(results[0].correlation + 1) < 1e-9);
    const rSquared = results[0].correlation * results[0].correlation;
    assert.ok(Math.abs(rSquared - 1) < 1e-9);
  });
});

describe("Wave WV4 · canonical evidence suffix on run_correlation summary", () => {
  it("composeFindingDetail with empty prefix returns just the parenthesised evidence block", () => {
    const evidence: FindingEvidence = { n: 200, rSquared: 0.81 };
    const suffix = composeFindingDetail("", evidence);
    // Leading space + parenthesised block — safe to concatenate onto an
    // existing summary string with no further whitespace management.
    assert.equal(suffix, " (n = 200; R² = 0.81)");
  });

  it("roundtrip: extractFindingEvidence(composeFindingDetail('', ev)) recovers R² + n", () => {
    const N = 100;
    const data = Array.from({ length: N }, (_, i) => ({
      Sales: i + 1,
      Spend: 3 * (i + 1) + 7,
    }));
    const [strongest] = calculateCorrelations(data, "Sales", ["Sales", "Spend"]);
    const rSquared = strongest.correlation * strongest.correlation;
    const evidence: FindingEvidence = {
      n: strongest.nPairs,
      rSquared,
    };
    const suffix = composeFindingDetail("", evidence);
    // Tool concatenates onto a full summary; simulate that here.
    const summary = `Correlation analysis: 1 chart(s), 1 insight(s).${suffix}`;
    const recovered = extractFindingEvidence(summary);
    assert.equal(recovered.n, N, "n recovered from suffix");
    assert.ok(recovered.rSquared !== undefined, "R² recovered from suffix");
    // R² is formatted to 2 decimals → recovered value matches the rounded one.
    assert.equal(recovered.rSquared!.toFixed(2), rSquared.toFixed(2));
  });

  it("zero-correlation frame still produces evidence (R² = 0, n = N)", () => {
    // The WV2 formatter accepts R² = 0 (in-range) and emits "R² = 0.00".
    const evidence: FindingEvidence = { n: 50, rSquared: 0 };
    const suffix = composeFindingDetail("", evidence);
    assert.equal(suffix, " (n = 50; R² = 0.00)");
    const recovered = extractFindingEvidence(suffix);
    assert.equal(recovered.n, 50);
    assert.equal(recovered.rSquared, 0);
  });
});

describe("Wave WV4 · registerTools wiring (source-inspection)", () => {
  it("registerTools.ts imports composeFindingDetail + FindingEvidence", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/tools/registerTools.ts"),
      "utf8",
    );
    assert.ok(
      src.includes('from "../formatFindingEvidence.js"'),
      "registerTools.ts must import composeFindingDetail from formatFindingEvidence",
    );
    assert.ok(
      src.includes("composeFindingDetail("),
      "registerTools.ts must call composeFindingDetail",
    );
    assert.ok(
      src.includes("import type { FindingEvidence }"),
      "registerTools.ts must import the FindingEvidence type",
    );
  });

  it("run_correlation success-path summary concatenates wv4EvidenceSuffix", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/tools/registerTools.ts"),
      "utf8",
    );
    assert.ok(
      src.includes("wv4EvidenceSuffix"),
      "run_correlation must construct wv4EvidenceSuffix",
    );
    // The success-path summary literal must reference the new suffix —
    // guards against future refactors that drop it.
    assert.match(
      src,
      /Correlation analysis: \$\{charts\.length\} chart\(s\), \$\{insights\.length\} insight\(s\)\.\$\{noteSuffix\}\$\{wv4EvidenceSuffix\}/,
      "success-path summary must include both noteSuffix and wv4EvidenceSuffix",
    );
  });

  it("analyzeCorrelations return type exposes topCorrelations (source-inspection)", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/correlationAnalyzer.ts"),
      "utf8",
    );
    assert.ok(
      src.includes("topCorrelations?: CorrelationResult[]"),
      "analyzeCorrelations return type must include optional topCorrelations",
    );
    // Success-path returns must populate it (one with diagnostic, one without).
    assert.ok(
      src.includes("{ charts, insights, diagnostic, topCorrelations }"),
      "diagnostic-path return must include topCorrelations",
    );
    assert.ok(
      src.includes("{ charts, insights, topCorrelations }"),
      "non-diagnostic success-path return must include topCorrelations",
    );
  });
});
