/**
 * Wave W-EXP-DECK1 · `autoRepairDeckPlan` — deterministic, no-LLM repair of the
 * MECHANICAL verifier rules (slide ordering + short speaker notes).
 *
 * Pins:
 *   - Stable bucket reorder: [TitleSlide, ...ExecSummary/KpiRow, ...body, ...Methodology]
 *     with findings order preserved inside `body`.
 *   - Short speaker notes padded to ≥ 20 chars; already-valid notes untouched.
 *   - After repair, the positional + notes rules (2/3/4/5) no longer fire.
 *   - The input plan is never mutated.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  autoRepairDeckPlan,
  verifyDeckPlan,
} from "../lib/agents/runtime/deckPlanVerifier.js";
import type { SlideDeckPlan, SlideSpec } from "../shared/exportSchema.js";
import { LAYOUT_KIND } from "../shared/exportSchema.js";

const NOTES = "Walk through this slide at a steady pace; pause on the magnitudes.";

function titleSlide(): SlideSpec {
  return {
    layout: LAYOUT_KIND.TitleSlide,
    actionTitle: "Marico-VN · Q3 review with 3 findings",
    speakerNotes: NOTES,
    slots: {},
  };
}
function execSummary(): SlideSpec {
  return {
    layout: LAYOUT_KIND.ExecSummary,
    actionTitle: "3 takeaways shape the response to the Q3 9% sales decline",
    speakerNotes: NOTES,
    slots: {
      bullets: [
        "Sales fell 12% in Q3 driven by category mix shift",
        "MARICO held share at 9.1% within FEMALE SHOWER GEL",
        "Distribution gains in modern trade offset some decline",
      ],
    },
  };
}
function kpiRow(): SlideSpec {
  return {
    layout: LAYOUT_KIND.KpiRow,
    actionTitle: "3 KPIs frame the Q3 9% category decline holistically",
    speakerNotes: NOTES,
    slots: { kpis: [{ label: "Q3 sales", value: "₫68.7B" }, { label: "Share", value: "9.1%" }] },
  };
}
function chartSlide(chartId: string, actionTitle: string): SlideSpec {
  return {
    layout: LAYOUT_KIND.ChartWithInsight,
    actionTitle,
    speakerNotes: NOTES,
    slots: { chartId, insight: "Category mix drove 8 of the 12pp decline; price held flat." },
  };
}
function methodology(): SlideSpec {
  return {
    layout: LAYOUT_KIND.Methodology,
    actionTitle: "Methodology · 6 weeks of Nielsen scan, 2,341 stores",
    speakerNotes: NOTES,
    slots: { body: "Nielsen MAT scan weeks ending 2025-W36 through 2025-W41; 2,341 stores." },
  };
}
function deck(slides: SlideSpec[]): SlideDeckPlan {
  return { title: "Test deck", generatedAt: "2026-05-05", slides };
}

describe("W-EXP-DECK1 · autoRepairDeckPlan reorder", () => {
  it("reorders to [Title, front-band, body, Methodology] preserving findings order", () => {
    const chartA = chartSlide("s0c0", "Sales fell 12% in Q3 driven by category mix shift");
    const chartB = chartSlide("s0c1", "MARICO grew 9.1% within FEMALE SHOWER GEL category");
    const input = deck([titleSlide(), methodology(), chartA, execSummary(), chartB, kpiRow()]);

    const out = autoRepairDeckPlan(input);
    const layouts = out.slides.map((s) => s.layout);
    assert.deepEqual(layouts, [
      LAYOUT_KIND.TitleSlide,
      LAYOUT_KIND.ExecSummary,
      LAYOUT_KIND.KpiRow,
      LAYOUT_KIND.ChartWithInsight,
      LAYOUT_KIND.ChartWithInsight,
      LAYOUT_KIND.Methodology,
    ]);
    // findings order preserved: chartA (s0c0) precedes chartB (s0c1)
    const chartIds = out.slides
      .filter((s) => s.layout === LAYOUT_KIND.ChartWithInsight)
      .map((s) => (s.slots as { chartId: string }).chartId);
    assert.deepEqual(chartIds, ["s0c0", "s0c1"]);
  });

  it("clears positional + notes rule violations (2/3/4/5) after repair", () => {
    const input = deck([
      titleSlide(),
      methodology(), // mis-placed (front)
      chartSlide("s0c0", "Sales fell 12% in Q3 driven by category mix shift"),
      execSummary(), // mis-placed (back half)
      chartSlide("s0c1", "Distribution drove 4pp of the Q3 recovery overall"),
    ]);
    const repaired = autoRepairDeckPlan(input);
    const verdict = verifyDeckPlan(repaired);
    assert.equal(verdict.ok, true, "expected no residual issues after auto-repair");
  });

  it("pads too-short speaker notes to ≥ 20 chars and leaves valid notes untouched", () => {
    const shortSlide: SlideSpec = { ...titleSlide(), speakerNotes: "shortie" };
    const goodSlide = methodology();
    const out = autoRepairDeckPlan(deck([shortSlide, goodSlide]));
    const repairedTitle = out.slides.find((s) => s.layout === LAYOUT_KIND.TitleSlide)!;
    assert.ok(repairedTitle.speakerNotes.trim().length >= 20);
    const repairedMethod = out.slides.find((s) => s.layout === LAYOUT_KIND.Methodology)!;
    assert.equal(repairedMethod.speakerNotes, NOTES); // unchanged
  });

  it("does not mutate the input plan", () => {
    const input = deck([titleSlide(), methodology(), execSummary()]);
    const snapshot = JSON.parse(JSON.stringify(input));
    autoRepairDeckPlan(input);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
  });
});
