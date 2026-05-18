/**
 * Wave WV7 · `run_segment_driver_analysis` migrated to WV2's `composeFindingDetail`.
 *
 * Fourth per-tool migration in the WV4 series. Closes the immediate per-tool
 * migration backlog for statistical findings (WV4 correlation · WV5
 * significance · WV6 elasticity · WV7 segment driver). The composite calls
 * `analyzeCorrelations` internally on a filtered slice; WV7 promotes the
 * strongest correlation's R² + n into the canonical FindingEvidence suffix on
 * the correlation branch's text — same template as WV4's run_correlation.
 *
 * Coverage:
 *  - segmentDriverAnalysisTool.ts imports composeFindingDetail + FindingEvidence.
 *  - The correlation branch destructures `topCorrelations` from
 *    analyzeCorrelations (the field WV4 plumbed) and constructs the canonical
 *    suffix via composeFindingDetail.
 *  - Correlation branch text concatenates `wv7EvidenceSuffix` at the end of
 *    the existing `Correlation scan on filtered slice (n=…) for …` line.
 *  - Math anchor: calculateCorrelations on a perfect-linear slice produces
 *    r = 1 / nPairs = N — the upstream guarantee WV7 piggybacks on.
 *  - Roundtrip: extractFindingEvidence on a simulated summary recovers n + R²
 *    modulo display rounding (matches WV4's extractor contract).
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

describe("Wave WV7 · segmentDriverAnalysisTool wires composeFindingDetail (source-inspection)", () => {
  it("imports composeFindingDetail + FindingEvidence", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/segmentDriverAnalysisTool.ts"),
      "utf8",
    );
    assert.ok(
      src.includes('from "./agents/runtime/formatFindingEvidence.js"'),
      "segmentDriverAnalysisTool.ts must import composeFindingDetail",
    );
    assert.ok(
      src.includes("import type { FindingEvidence }"),
      "segmentDriverAnalysisTool.ts must import the FindingEvidence type",
    );
  });

  it("destructures topCorrelations from analyzeCorrelations (WV4 plumbed field)", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/segmentDriverAnalysisTool.ts"),
      "utf8",
    );
    assert.ok(
      src.includes("{ charts, insights, topCorrelations }"),
      "correlation branch must destructure topCorrelations from analyzeCorrelations",
    );
  });

  it("correlation branch text concatenates wv7EvidenceSuffix", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/segmentDriverAnalysisTool.ts"),
      "utf8",
    );
    assert.ok(
      src.includes("wv7EvidenceSuffix"),
      "must construct wv7EvidenceSuffix from the strongest correlation",
    );
    // Should appear ≥2 times: 1 assignment + 1 concatenation into the text.
    const refCount = (src.match(/wv7EvidenceSuffix/g) ?? []).length;
    assert.ok(
      refCount >= 2,
      `expected ≥2 references to wv7EvidenceSuffix (1 assignment + 1 concat), saw ${refCount}`,
    );
    // The correlation branch text literal must reference the suffix —
    // guards against future refactors that drop it.
    assert.match(
      src,
      /Correlation scan on filtered slice \(n=\$\{slice\.length\}\) for \*\*\$\{outcome\}\*\*\.\$\{wv7EvidenceSuffix\}/,
      "correlation branch text must end with ${wv7EvidenceSuffix}",
    );
  });
});

describe("Wave WV7 · math anchor (the upstream contract WV7 piggybacks on)", () => {
  it("calculateCorrelations on a perfect-linear slice produces r ≈ 1 and nPairs = N", () => {
    const N = 60;
    // Simulated filtered slice after dimensionFilters narrow the frame.
    const slice = Array.from({ length: N }, (_, i) => ({
      Sales: i + 1,
      Spend: 4 * (i + 1) + 3,
      Visitors: 7 * (i + 1) - 2,
    }));
    const results = calculateCorrelations(slice, "Sales", [
      "Sales",
      "Spend",
      "Visitors",
    ]);
    assert.equal(results.length, 2, "target column is skipped by calculateCorrelations");
    for (const r of results) {
      assert.ok(
        Math.abs(r.correlation - 1) < 1e-9,
        `expected r ≈ 1 for ${r.variable}, got ${r.correlation}`,
      );
      assert.equal(r.nPairs, N, "nPairs equals slice length when no nulls");
    }
  });
});

describe("Wave WV7 · roundtrip: composed suffix is recoverable by extractFindingEvidence", () => {
  it("extractFindingEvidence recovers n + R² from a simulated WV7 summary", () => {
    const N = 60;
    const slice = Array.from({ length: N }, (_, i) => ({
      Sales: i + 1,
      Spend: 4 * (i + 1) + 3,
    }));
    const [strongest] = calculateCorrelations(slice, "Sales", ["Sales", "Spend"]);
    const rSquared = strongest.correlation * strongest.correlation;
    const evidence: FindingEvidence = { n: strongest.nPairs, rSquared };
    const suffix = composeFindingDetail("", evidence);
    // Mirror the production text shape — the correlation branch's text + the
    // appended suffix, embedded inside the joined `\n\n` summary the agent
    // wraps as the finding's detail.
    const branchText = `Correlation scan on filtered slice (n=${slice.length}) for **Sales**.${suffix}`;
    const summary = `run_segment_driver_analysis\nBenchmark (Sales): segment sum=…, global sum=…\n\nSegment breakdown by Sub-Category (Sales sum)\n  A: 100.00\n  B: 50.00\n\n${branchText}`;
    const recovered = extractFindingEvidence(summary);
    assert.equal(recovered.n, N, "n recovered from the correlation-branch suffix");
    assert.ok(recovered.rSquared !== undefined, "R² recovered from the correlation-branch suffix");
    assert.equal(
      recovered.rSquared!.toFixed(2),
      rSquared.toFixed(2),
      "recovered R² matches the formatted (2dp) value",
    );
  });

  it("empty topCorrelations → empty suffix → branch text unchanged from pre-WV7 shape", () => {
    // When analyzeCorrelations produces nothing useful (no topCorrelations or
    // empty array), composeFindingDetail("", {}) returns "" so the branch
    // text is byte-stable with the pre-WV7 form. Guards against accidental
    // " ()" stubs leaking onto the summary when the slice has no numeric
    // pairs to correlate.
    const evidence: FindingEvidence = {};
    const suffix = composeFindingDetail("", evidence);
    assert.equal(suffix, "", "empty evidence → empty suffix");
    const branchText = `Correlation scan on filtered slice (n=42) for **Revenue**.${suffix}`;
    assert.equal(
      branchText,
      "Correlation scan on filtered slice (n=42) for **Revenue**.",
      "branch text unchanged from pre-WV7 when no evidence is available",
    );
  });
});
