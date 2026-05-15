/**
 * W-EXP-7 · End-to-end PPTX render — agentic deck pipeline integration test.
 *
 * Runs the full pipeline against a representative Marico-VN dashboard
 * fixture with the LLM stubbed to a richer plan that exercises every
 * layout. Asserts:
 *   1. ZIP magic bytes (PPTX is a ZIP container).
 *   2. The output is non-trivial (more than the empty-pptx baseline).
 *   3. `buildAndVerifyDeckPlan` returns null when the planner emits a
 *      Zod-invalid plan, and `buildFallbackDeckPlan` produces a 3-slide
 *      deck that the renderer accepts.
 *   4. Verifier-failure → repair branch → renderer is the only path the
 *      controller has to a "shitty" deck even when the first planner call
 *      misbehaves.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  buildAndVerifyDeckPlan,
  buildDashboardDeckPptx,
  buildFallbackDeckPlan,
} from "../lib/exports/buildDashboardDeck.js";
import {
  installLlmStub,
  clearLlmStub,
} from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import { renderDeckPlanToPptxBuffer } from "../lib/exports/pptx/render.js";
import type { Dashboard, ChartSpec } from "../shared/schema.js";

function chart(title: string, type: ChartSpec["type"] = "bar", x = "Quarter", y = "Sales"): ChartSpec {
  return {
    type,
    title,
    x,
    y,
    data: [
      { [x]: "Q1", [y]: 100 },
      { [x]: "Q2", [y]: 120 },
      { [x]: "Q3", [y]: 90 },
    ],
  } as ChartSpec;
}

function dashboard(): Dashboard {
  return {
    id: "dash-mar-vn",
    username: "tester@marico",
    name: "Marico-VN · Q3 review",
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    charts: [],
    sheets: [
      {
        id: "s-overview",
        name: "Overview",
        order: 0,
        charts: [chart("Quarterly sales trend", "bar"), chart("Brand share within category", "pie", "Brand", "Share")],
        tables: [
          {
            id: "tbl-1",
            caption: "Brand-level Q3 performance",
            columns: ["Brand", "Q3 sales", "vs Q2"],
            rows: [
              ["MARICO", 12.4, "+3.1pp"],
              ["PURITE", 8.2, "−1.4pp"],
            ],
          },
        ],
      },
    ],
    answerEnvelope: {
      tldr: "Q3 sales fell 12% — category mix did most of the damage.",
      findings: [
        {
          headline: "Category mix drove 8 of 12pp decline",
          evidence: "Decomposition over Q3 weekly Nielsen scan; categorical shift trumped price.",
          magnitude: "−12% vs Q2",
        },
      ],
      magnitudes: [
        { label: "Q3 sales", value: "₫68.7B", confidence: "high" },
        { label: "Category share", value: "9.1%", confidence: "high" },
      ],
      methodology: "Nielsen MAT scan weeks ending 2025-W36 through 2025-W41.",
      caveats: ["Modern trade only."],
    },
  } as Dashboard;
}

const RICH_PLAN = {
  title: "Marico-VN · Q3 review",
  subtitle: "What drove the Q3 sales decline and how do we respond?",
  generatedAt: "2026-05-05",
  confidentiality: "Internal",
  preparedFor: "Marico Vietnam · category leadership team",
  slides: [
    {
      layout: "TitleSlide",
      actionTitle: "Marico-VN · Q3 review with 3 findings",
      speakerNotes: "Cover slide. Pause here for 2 seconds to set the scene.",
      slots: { subtitle: "Q3 2025 category leadership review", confidentiality: "Internal" },
    },
    {
      layout: "ExecSummary",
      actionTitle: "3 takeaways shape the response to the Q3 9% sales decline",
      speakerNotes: "Walk through the bullets at a steady pace. The whole answer is on this slide.",
      slots: {
        bullets: [
          "Sales fell 12% in Q3 driven by category mix shift",
          "MARICO held share at 9.1% within FEMALE SHOWER GEL",
          "Distribution gains in modern trade offset 4pp of the decline",
        ],
      },
    },
    {
      layout: "KpiRow",
      actionTitle: "3 KPIs frame the Q3 9.1% share-hold story for MARICO",
      speakerNotes: "Three KPIs: sales total, share, distribution. Each tile is one number.",
      slots: {
        kpis: [
          { label: "Q3 sales", value: "₫68.7B", delta: "−12%", confidence: "high" },
          { label: "Share within FSG", value: "9.1%", delta: "+0.3pp", confidence: "high" },
          { label: "Modern trade ACV", value: "82%", delta: "+4pp", confidence: "medium" },
        ],
      },
    },
    {
      layout: "ChartWithInsight",
      actionTitle: "Sales fell 12% in Q3 driven by category mix shift",
      speakerNotes: "Bar chart of quarterly sales. The Q3 break is the headline.",
      slots: {
        chartId: "s0c0",
        insight: "Category mix drove 8 of the 12pp decline; price held flat.",
        source: "Source: Nielsen MAT scan, Q3 2025; n=2,341.",
      },
    },
    {
      layout: "TableSlide",
      actionTitle: "Brand-level Q3 performance reveals MARICO's 3.1pp share gain",
      speakerNotes: "Native table — recipients can copy values into Excel.",
      slots: {
        caption: "Brand-level Q3 performance",
        tableRef: { kind: "ref", tableId: "s0t0" },
        insight: "MARICO is the only sub-brand holding share within the declining category.",
      },
    },
    {
      layout: "ImplicationsByHorizon",
      actionTitle: "Three horizons of response shape the Q3 recovery plan",
      speakerNotes: "Implications grouped by horizon: Now / This quarter / Strategic.",
      slots: {
        now: ["Reallocate ₫4B of trade spend to MARICO"],
        thisQuarter: ["Re-baseline category forecast at −9% for Q4"],
        strategic: ["Re-evaluate FEMALE SHOWER GEL portfolio architecture"],
      },
    },
    {
      layout: "Recommendations",
      actionTitle: "2 actions drive the Q3 recovery within 90 days",
      speakerNotes: "Two numbered recommendations with horizon chips.",
      slots: {
        items: [
          {
            action: "Reallocate ₫4B from PURITE to MARICO in trade promotions",
            rationale: "MARICO is the only sub-brand holding share within the declining category.",
            horizon: "now",
            confidence: "medium",
            owner: "Trade marketing",
          },
          {
            action: "Commission category-mix decomposition for Q4 forecast revision",
            rationale: "Q3 evidence shows category mix is the dominant driver — forecast must reflect this.",
            horizon: "this_quarter",
            confidence: "high",
            owner: "Insights team",
          },
        ],
      },
    },
    {
      layout: "Methodology",
      actionTitle: "Methodology · 6 weeks of Nielsen scan, 2,341 stores",
      speakerNotes: "Closing methodology. Small font, end of deck.",
      slots: {
        body:
          "Source data: Nielsen MAT scan, weeks ending 2025-W36 through 2025-W41. Coverage: 2,341 modern-trade stores in HCMC + Hanoi. Aggregation: weekly rollup, then quarterly. Caveats listed below apply.",
        caveats: [
          "Modern trade only; traditional trade not included.",
          "Single-quarter snapshot — trend extrapolation should use the YTD decomposition.",
        ],
      },
    },
  ],
};

describe("W-EXP-7 · end-to-end PPTX pipeline", () => {
  beforeEach(() => {
    installLlmStub({
      [LLM_PURPOSE.DECK_PLANNER]: () => RICH_PLAN,
    });
  });
  afterEach(() => {
    clearLlmStub();
  });

  it("produces a ZIP-shaped non-trivial PPTX from the rich 8-slide plan", async () => {
    const buf = await buildDashboardDeckPptx(dashboard());
    assert.equal(buf[0], 0x50); // P
    assert.equal(buf[1], 0x4b); // K
    assert.equal(buf[2], 0x03);
    assert.equal(buf[3], 0x04);
    // 8 slides + chart objects + tables + master pushes the buffer over a
    // baseline empty deck size; pin a generous floor so this test catches
    // the regression where layouts silently drop content.
    assert.ok(buf.length > 25_000, `expected non-trivial PPTX size, got ${buf.length} bytes`);
  });

  it("fallback deck renders cleanly when the planner returns null", async () => {
    installLlmStub({
      [LLM_PURPOSE.DECK_PLANNER]: () => ({ slides: [] }), // schema-invalid → planner returns null
    });
    const plan = await buildAndVerifyDeckPlan(dashboard());
    assert.equal(plan, null, "planner should return null on Zod-invalid output");
    const fallback = buildFallbackDeckPlan(dashboard(), { generatedAt: "2026-05-05" });
    assert.equal(fallback.slides.length, 3);
    const buf = await renderDeckPlanToPptxBuffer(fallback, dashboard());
    assert.ok(buf.length > 5_000);
  });

  it("verifier-fail → repair branch → ok plan flow rescues a bad first call", async () => {
    let plannerCalls = 0;
    installLlmStub({
      [LLM_PURPOSE.DECK_PLANNER]: () => {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          // First call — Methodology in the FRONT third (verifier rejects).
          return {
            ...RICH_PLAN,
            slides: [RICH_PLAN.slides[7], ...RICH_PLAN.slides.slice(0, 7)],
          };
        }
        // Repair call — return the rich plan as-is.
        return RICH_PLAN;
      },
    });
    const plan = await buildAndVerifyDeckPlan(dashboard(), { turnId: "test-repair" });
    assert.ok(plan);
    assert.equal(plannerCalls, 2, "planner must be called twice (initial + repair)");
    // Methodology is back in the back third.
    const lastIdx = plan!.slides.length - 1;
    assert.equal(plan!.slides[lastIdx]!.layout, "Methodology");
  });
});
