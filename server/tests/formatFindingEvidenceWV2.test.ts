/**
 * Wave WV2 · canonical FindingEvidence formatter tests.
 *
 * The load-bearing test is the roundtrip property: extracting the evidence
 * back out of formatted prose recovers the original struct (modulo numeric
 * rounding on display). This pins the contract between WW2's extractor and
 * WV2's formatter.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  composeFindingDetail,
  formatEvidenceForFindingDetail,
} from "../lib/agents/runtime/formatFindingEvidence.js";
import { extractFindingEvidence } from "../lib/agents/runtime/narratorHintsBlock.js";
import type { FindingEvidence } from "../lib/agents/runtime/scaleNarrativeByConfidence.js";

describe("Wave WV2 · formatEvidenceForFindingDetail · output shape", () => {
  it("emits n / p / R² / CI in a parenthesised block when all fields are set", () => {
    const out = formatEvidenceForFindingDetail({
      n: 850,
      pValue: 0.01,
      rSquared: 0.71,
      ciRelativeWidth: 0.15,
    });
    assert.match(out, /^ \(n = 850; p = 0\.01; R² = 0\.71; ±15% of the estimate\)$/);
  });

  it("returns empty string when no fields are present", () => {
    assert.equal(formatEvidenceForFindingDetail({}), "");
  });

  it("emits 'p < 0.001' for very small p-values", () => {
    const out = formatEvidenceForFindingDetail({ pValue: 0.0001 });
    assert.match(out, /p < 0\.001/);
  });

  it("rounds n to an integer", () => {
    const out = formatEvidenceForFindingDetail({ n: 850.6 });
    assert.match(out, /n = 851/);
  });

  it("converts ciRelativeWidth fraction to a percent integer", () => {
    const out = formatEvidenceForFindingDetail({ ciRelativeWidth: 0.235 });
    assert.match(out, /±24% of the estimate/);
  });

  it("formats R² to 2 decimal places", () => {
    const out = formatEvidenceForFindingDetail({ rSquared: 0.7142857 });
    assert.match(out, /R² = 0\.71/);
  });

  it("drops out-of-range values defensively", () => {
    const out = formatEvidenceForFindingDetail({
      n: -5,
      pValue: 1.2,
      rSquared: 1.4,
      ciRelativeWidth: 2.0,
    });
    assert.equal(out, "");
  });

  it("emits only the present fields, in canonical order", () => {
    const out = formatEvidenceForFindingDetail({ rSquared: 0.62, n: 200 });
    assert.equal(out, " (n = 200; R² = 0.62)");
  });
});

describe("Wave WV2 · composeFindingDetail", () => {
  it("concatenates a prefix with the evidence suffix", () => {
    const detail = composeFindingDetail(
      "Driver model fit on revenue.",
      { n: 200, rSquared: 0.62 },
    );
    assert.equal(detail, "Driver model fit on revenue. (n = 200; R² = 0.62)");
  });

  it("trims prefix whitespace before concatenating", () => {
    const detail = composeFindingDetail("Driver fit.   ", { n: 100 });
    assert.equal(detail, "Driver fit. (n = 100)");
  });

  it("returns just the prefix when evidence is empty", () => {
    const detail = composeFindingDetail("No stats available.", {});
    assert.equal(detail, "No stats available.");
  });
});

describe("Wave WV2 · roundtrip with WW2 extractFindingEvidence", () => {
  const cases: { name: string; ev: FindingEvidence }[] = [
    { name: "all four fields", ev: { n: 850, pValue: 0.01, rSquared: 0.71, ciRelativeWidth: 0.15 } },
    { name: "only n", ev: { n: 50 } },
    { name: "only p", ev: { pValue: 0.04 } },
    { name: "only R²", ev: { rSquared: 0.65 } },
    { name: "small p < 0.001", ev: { n: 500, pValue: 0.0001 } },
    { name: "CI 30%", ev: { n: 100, ciRelativeWidth: 0.3 } },
  ];
  for (const { name, ev } of cases) {
    it(`recovers ${name}`, () => {
      const detail = composeFindingDetail("Some finding context.", ev);
      const recovered = extractFindingEvidence(detail);
      if (ev.n !== undefined) assert.equal(recovered.n, Math.round(ev.n));
      if (ev.pValue !== undefined) {
        if (ev.pValue < 0.001) {
          assert.equal(recovered.pValue, 0.001);
        } else {
          assert.equal(recovered.pValue, Number(ev.pValue.toFixed(2)));
        }
      }
      if (ev.rSquared !== undefined) {
        assert.equal(recovered.rSquared, Number(ev.rSquared.toFixed(2)));
      }
      if (ev.ciRelativeWidth !== undefined) {
        assert.equal(recovered.ciRelativeWidth, Math.round(ev.ciRelativeWidth * 100) / 100);
      }
    });
  }
});
