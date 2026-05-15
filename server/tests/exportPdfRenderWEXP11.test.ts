/**
 * W-EXP-11 · End-to-end PDF render — agentic deck pipeline integration test.
 *
 * Symmetric to `exportPptxRenderWEXP7.test.ts`. Runs the full pipeline
 * with the LLM stubbed; asserts:
 *   1. PDF magic bytes (`%PDF-`).
 *   2. Output is non-trivial (more than the empty-doc baseline).
 *   3. Fallback deck path renders cleanly when the planner returns null.
 *
 * @react-pdf/renderer is async and uses Node streams under the hood;
 * `renderDeckPlanToPdfBuffer` waits on stream completion before resolving
 * the Buffer.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  buildAndVerifyDeckPlan,
  buildDashboardDeckPdf,
  buildFallbackDeckPlan,
} from "../lib/exports/buildDashboardDeck.js";
import { renderDeckPlanToPdfBuffer } from "../lib/exports/pdf/render.js";
import {
  installLlmStub,
  clearLlmStub,
} from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { Dashboard, ChartSpec } from "../shared/schema.js";

function chart(title: string, type: ChartSpec["type"] = "bar"): ChartSpec {
  return {
    type,
    title,
    x: "Quarter",
    y: "Sales",
    data: [
      { Quarter: "Q1", Sales: 100 },
      { Quarter: "Q2", Sales: 120 },
      { Quarter: "Q3", Sales: 90 },
    ],
  } as ChartSpec;
}

function dashboard(): Dashboard {
  return {
    id: "dash-1",
    username: "tester@marico",
    name: "Marico-VN · Q3 review",
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    charts: [],
    sheets: [
      {
        id: "s",
        name: "Overview",
        order: 0,
        charts: [chart("Quarterly sales trend"), chart("Brand share within category", "pie")],
        tables: [
          {
            id: "tbl-1",
            caption: "Brand-level performance",
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
          evidence: "Decomposition over Q3 weekly Nielsen scan.",
          magnitude: "−12% vs Q2",
        },
      ],
      methodology: "Nielsen MAT scan weeks ending 2025-W36 through 2025-W41.",
    },
  } as Dashboard;
}

const RICH_PLAN = {
  title: "Marico-VN · Q3 review",
  subtitle: "What drove the Q3 sales decline and how do we respond?",
  generatedAt: "2026-05-05",
  confidentiality: "Internal",
  slides: [
    {
      layout: "TitleSlide",
      actionTitle: "Marico-VN · Q3 review with 3 findings",
      speakerNotes: "Cover slide for the review deck.",
      slots: { subtitle: "Q3 2025 category leadership review" },
    },
    {
      layout: "ExecSummary",
      actionTitle: "3 takeaways shape the response to the Q3 9% sales decline",
      speakerNotes: "TL;DR slide with the three headline takeaways.",
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
      actionTitle: "3 KPIs frame the Q3 9.1% share-hold story",
      speakerNotes: "Tile row with the three load-bearing KPIs.",
      slots: {
        kpis: [
          { label: "Q3 sales", value: "₫68.7B", delta: "−12%" },
          { label: "Share within FSG", value: "9.1%", delta: "+0.3pp" },
        ],
      },
    },
    {
      layout: "ChartWithInsight",
      actionTitle: "Sales fell 12% in Q3 driven by category mix shift",
      speakerNotes: "Quarterly sales trend chart with one-sentence so-what.",
      slots: {
        chartId: "s0c0",
        insight: "Category mix drove 8 of the 12pp decline; price held flat.",
      },
    },
    {
      layout: "Methodology",
      actionTitle: "Methodology · 6 weeks of Nielsen scan, 2,341 stores",
      speakerNotes: "Closing methodology slide.",
      slots: {
        body:
          "Source data: Nielsen MAT scan, weeks ending 2025-W36 through 2025-W41. Coverage: 2,341 modern-trade stores in HCMC + Hanoi.",
        caveats: ["Modern trade only; traditional trade not included."],
      },
    },
  ],
};

describe("W-EXP-11 · end-to-end PDF pipeline", () => {
  beforeEach(() => {
    installLlmStub({
      [LLM_PURPOSE.DECK_PLANNER]: () => RICH_PLAN,
    });
  });
  afterEach(() => {
    clearLlmStub();
  });

  it("produces a PDF-shaped buffer with %PDF- magic bytes", async () => {
    const buf = await buildDashboardDeckPdf(dashboard());
    // %PDF-
    assert.equal(buf[0], 0x25);
    assert.equal(buf[1], 0x50);
    assert.equal(buf[2], 0x44);
    assert.equal(buf[3], 0x46);
    assert.equal(buf[4], 0x2d);
    assert.ok(buf.length > 5_000, `expected non-trivial PDF, got ${buf.length} bytes`);
  });

  it("fallback deck renders cleanly when the planner returns null", async () => {
    installLlmStub({
      [LLM_PURPOSE.DECK_PLANNER]: () => ({ slides: [] }), // schema-invalid → null
    });
    const plan = await buildAndVerifyDeckPlan(dashboard());
    assert.equal(plan, null);
    const fallback = buildFallbackDeckPlan(dashboard(), { generatedAt: "2026-05-05" });
    const buf = await renderDeckPlanToPdfBuffer(fallback, dashboard());
    assert.equal(buf[0], 0x25);
    assert.equal(buf[1], 0x50);
    assert.equal(buf[2], 0x44);
    assert.equal(buf[3], 0x46);
  });
});
