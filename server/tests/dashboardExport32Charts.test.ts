/**
 * Wave W-EXP-DECK6 · End-to-end guarantee — a 32-chart dashboard exports a FULL
 * deck, never the 3-slide stub.
 *
 * This is the regression test for the reported bug ("exporting a dashboard just
 * gives 3 slides"). It drives the WHOLE `buildDashboardDeckPptx` pipeline, then
 * unzips the produced .pptx and counts `ppt/slides/slideN.xml` entries. Both of
 * the historical failure paths are covered:
 *   1. The planner produces a plan but the verifier never passes (even after
 *      repair) → the deck is SHIPPED anyway with > 3 slides.
 *   2. The planner returns null (e.g. > 30-slide overshoot / truncation) → the
 *      rich deterministic fallback ships one chart slide per chart (capped 30).
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { buildDashboardDeckPptx } from "../lib/exports/buildDashboardDeck.js";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { Dashboard } from "../shared/schema.js";

const NOTES = "Walk through this slide at a steady pace; pause on the magnitudes.";

function chart(i: number) {
  return { type: "bar", title: `Chart ${i}`, x: "x", y: "y", data: [{ x: "Q1", y: 1 }, { x: "Q2", y: 2 }] };
}
function dash32(): Dashboard {
  return {
    id: "dash32",
    name: "Finance Dashboard",
    username: "u@e.com",
    sheets: [{ id: "s0", name: "Sheet", order: 0, charts: Array.from({ length: 32 }, (_, i) => chart(i)) }],
  } as unknown as Dashboard;
}

/** A schema-valid 12-slide plan with a placeholder title (rule-1 nit that
 * survives deterministic auto-repair) so the verifier fails on every pass. */
function bigVerifierFailingPlan() {
  const charts = Array.from({ length: 9 }, (_, i) => ({
    layout: "ChartWithInsight",
    // slide index 5 (3rd chart) carries the denylisted placeholder title.
    actionTitle: i === 2 ? "Findings" : `Chart ${i} drove 4pp of the Q3 movement overall`,
    speakerNotes: NOTES,
    slots: { chartId: `s0c${i}`, insight: `Insight for chart ${i} — see the underlying data.` },
  }));
  return {
    title: "Finance Dashboard",
    generatedAt: "2026-06-29",
    slides: [
      { layout: "TitleSlide", actionTitle: "Finance Dashboard · Q3 review with 9 charts", speakerNotes: NOTES, slots: {} },
      {
        layout: "ExecSummary",
        actionTitle: "3 takeaways summarise the Q3 9% sales movement",
        speakerNotes: NOTES,
        slots: { bullets: ["Sales fell 12% in Q3 overall", "MARICO held share at 9.1% steady", "Distribution gained in modern trade"] },
      },
      ...charts,
      { layout: "Methodology", actionTitle: "Methodology · 6 weeks of Nielsen scan data", speakerNotes: NOTES, slots: { body: "Nielsen MAT scan, weeks 2025-W36 to 2025-W41, 2,341 stores." } },
    ],
  };
}

async function countSlides(buf: Buffer): Promise<number> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
}

describe("W-EXP-DECK6 · 32-chart dashboard exports a full deck", () => {
  afterEach(() => clearLlmStub());

  it("ships the full deck (>3 slides) when the verifier never passes", async () => {
    installLlmStub({ [LLM_PURPOSE.DECK_PLANNER]: () => bigVerifierFailingPlan() });
    const buf = await buildDashboardDeckPptx(dash32(), { turnId: "e2e-verifier" });
    assert.equal(buf[0], 0x50); // ZIP magic 'P'
    assert.equal(buf[1], 0x4b); // 'K'
    const n = await countSlides(buf);
    assert.equal(n, 12, `expected the 12-slide plan to ship verbatim, got ${n}`);
  });

  it("ships the rich fallback (one chart slide per chart, capped 30) when the planner returns null", async () => {
    installLlmStub({ [LLM_PURPOSE.DECK_PLANNER]: () => ({ slides: [] }) }); // schema-invalid → null
    const buf = await buildDashboardDeckPptx(dash32(), { turnId: "e2e-fallback" });
    const n = await countSlides(buf);
    assert.ok(n > 3, `expected > 3 slides, got ${n}`);
    assert.ok(n <= 30, `expected ≤ 30 slides (schema cap), got ${n}`);
    assert.ok(n >= 20, `expected a real chart-per-slide deck, got ${n}`);
  });
});
