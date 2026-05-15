/**
 * W-EXP-2 · `runDeckPlanner` agent — pins the LLM-driven export pipeline
 * contract.
 *
 * Test surface:
 *   1. The slim representation handed to the LLM strips raw chart data and
 *      preserves chart-id stability (so renderers can resolve back).
 *   2. `resolveChartIdToSpec` is the inverse of the slim-id allocator.
 *   3. Default stub returns a valid 3-slide plan that passes Zod validation.
 *   4. The right LLM purpose (`DECK_PLANNER`) fires for cost telemetry.
 *   5. A schema-fail handler causes the function to return `null` (caller's
 *      fallback responsibility).
 *   6. Repair branch: when invoked with `repair`, the user prompt grows with
 *      the prior plan + issues block.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildSlimDashboard,
  buildDeckPlannerUserPrompt,
  resolveChartIdToSpec,
  runDeckPlanner,
  type DeckPlannerInputs,
} from "../lib/agents/runtime/deckPlanner.js";
import {
  installLlmStub,
  clearLlmStub,
} from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { Dashboard, ChartSpec } from "../shared/schema.js";
import { LAYOUT_KIND } from "../shared/exportSchema.js";

function makeChart(title: string, type: ChartSpec["type"] = "bar"): ChartSpec {
  return {
    type,
    title,
    x: "Quarter",
    y: "Sales",
    data: [
      { Quarter: "Q1", Sales: 100 },
      { Quarter: "Q2", Sales: 120 },
    ],
    keyInsight: `Insight for ${title}`,
    businessCommentary: `Business commentary for ${title}`,
  } as ChartSpec;
}

function makeDashboard(): Dashboard {
  return {
    id: "dash-1",
    username: "tester@marico",
    name: "Marico-VN · Q3 review",
    createdAt: 1_730_000_000_000,
    updatedAt: 1_730_000_000_000,
    charts: [],
    sheets: [
      {
        id: "sheet-overview",
        name: "Overview",
        order: 0,
        charts: [makeChart("Quarterly sales trend"), makeChart("Brand share within category", "pie")],
        narrativeBlocks: [
          {
            id: "n1",
            role: "summary",
            title: "Headline",
            body: "Sales fell 12% in Q3 driven by category mix shift.",
            order: 0,
          },
        ],
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
      methodology:
        "Nielsen MAT scan weeks ending 2025-W36 through 2025-W41 across 2,341 modern-trade stores in HCMC + Hanoi.",
      caveats: ["Modern trade only; traditional trade not included."],
    },
    businessActions: [
      {
        title: "Reallocate trade spend toward MARICO in Q4",
        rationale: "MARICO is the only sub-brand holding share within the declining category.",
        horizon: "now",
        confidence: "medium",
      },
    ],
    capturedActiveFilter: {
      conditions: [{ kind: "in", column: "Region", values: ["HCMC", "Hanoi"] }],
      version: 1,
      updatedAt: 1_730_000_000_000,
    },
  } as Dashboard;
}

describe("W-EXP-2 · buildSlimDashboard / chart-id allocation", () => {
  test("strips raw chart data, keeps title + encodings + commentary", () => {
    const dash = makeDashboard();
    const slim = buildSlimDashboard({ dashboard: dash, generatedAt: "2026-05-05" });
    const c0 = slim.sheets[0]!.charts[0]!;
    assert.equal(c0.id, "s0c0");
    assert.equal(c0.title, "Quarterly sales trend");
    assert.equal(c0.type, "bar");
    assert.equal(c0.x, "Quarter");
    assert.equal(c0.y, "Sales");
    assert.match(c0.insight ?? "", /Insight for Quarterly sales trend/);
    assert.match(c0.businessCommentary ?? "", /Business commentary for Quarterly sales trend/);
    // Raw data must NOT have leaked through.
    assert.equal((c0 as unknown as { data?: unknown }).data, undefined);
  });

  test("falls back to legacy `charts[]` when no sheets[] present", () => {
    const legacy: Dashboard = {
      ...makeDashboard(),
      sheets: undefined,
      charts: [makeChart("Legacy chart")],
    };
    const slim = buildSlimDashboard({ dashboard: legacy });
    assert.equal(slim.sheets.length, 1);
    assert.equal(slim.sheets[0]!.name, "Overview");
    assert.equal(slim.sheets[0]!.charts[0]!.id, "s0c0");
  });

  test("resolveChartIdToSpec is the inverse of the id allocator", () => {
    const dash = makeDashboard();
    const resolved = resolveChartIdToSpec(dash, "s0c1");
    assert.ok(resolved);
    assert.equal(resolved!.chart.title, "Brand share within category");
    assert.equal(resolveChartIdToSpec(dash, "s0c99"), null);
    assert.equal(resolveChartIdToSpec(dash, "garbage"), null);
  });

  test("user prompt surfaces envelope + filter + chart inventory + business actions", () => {
    const prompt = buildDeckPlannerUserPrompt({
      dashboard: makeDashboard(),
      generatedAt: "2026-05-05",
    });
    assert.match(prompt, /Marico-VN · Q3 review/);
    assert.match(prompt, /Captured filter: Region ∈ \{HCMC, Hanoi\}/);
    assert.match(prompt, /TL;DR: Q3 sales fell 12%/);
    assert.match(prompt, /Magnitudes \(2\):/);
    assert.match(prompt, /BUSINESS ACTIONS/);
    assert.match(prompt, /s0c0: bar · "Quarterly sales trend"/);
    assert.match(prompt, /s0c1: pie · "Brand share within category"/);
    assert.match(prompt, /s0t0: table · "Brand-level Q3 performance"/);
    assert.match(prompt, /Compose the SlideDeckPlan now/);
  });
});

describe("W-EXP-2 · runDeckPlanner with stubbed LLM", () => {
  beforeEach(() => {
    installLlmStub({});
  });
  afterEach(() => {
    clearLlmStub();
  });

  test("default stub returns a valid 3-slide plan that schema-validates", async () => {
    const inputs: DeckPlannerInputs = { dashboard: makeDashboard(), generatedAt: "2026-05-05" };
    const plan = await runDeckPlanner(inputs);
    assert.ok(plan);
    assert.equal(plan!.slides.length, 3);
    assert.equal(plan!.slides[0]!.layout, LAYOUT_KIND.TitleSlide);
    assert.equal(plan!.slides[1]!.layout, LAYOUT_KIND.ExecSummary);
    assert.equal(plan!.slides[2]!.layout, LAYOUT_KIND.Methodology);
  });

  test("forwards LLM_PURPOSE.DECK_PLANNER for cost telemetry", async () => {
    const captured: string[] = [];
    installLlmStub({
      [LLM_PURPOSE.DECK_PLANNER]: () => {
        captured.push(LLM_PURPOSE.DECK_PLANNER);
        return {
          title: "Test",
          generatedAt: "2026-05-05",
          slides: [
            {
              layout: "TitleSlide",
              actionTitle: "Test deck · 3 findings reviewed",
              speakerNotes: "Stub speaker notes for the cover slide.",
              slots: {},
            },
            {
              layout: "ExecSummary",
              actionTitle: "3 findings shape the response to Q3 decline",
              speakerNotes: "Walk through the bullets at a steady pace.",
              slots: {
                bullets: [
                  "Sales fell 12% in Q3",
                  "MARICO held share at 9.1%",
                  "Modern trade gains offset 4pp",
                ],
              },
            },
          ],
        };
      },
    });
    const plan = await runDeckPlanner({
      dashboard: makeDashboard(),
      generatedAt: "2026-05-05",
    });
    assert.ok(plan);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], LLM_PURPOSE.DECK_PLANNER);
  });

  test("returns null when the LLM emits a Zod-invalid plan", async () => {
    installLlmStub({
      // Floor is 2 slides — emit 1 to force schema failure.
      [LLM_PURPOSE.DECK_PLANNER]: () => ({
        title: "Bad",
        generatedAt: "2026-05-05",
        slides: [
          {
            layout: "TitleSlide",
            actionTitle: "x", // < 4 chars; will fail
            speakerNotes: "short",
            slots: {},
          },
        ],
      }),
    });
    const plan = await runDeckPlanner({
      dashboard: makeDashboard(),
      generatedAt: "2026-05-05",
    });
    assert.equal(plan, null);
  });

  test("repair branch threads issues + prior plan into the user message", async () => {
    let lastUserMsg = "";
    installLlmStub({
      [LLM_PURPOSE.DECK_PLANNER]: (params) => {
        const userMsg = params.messages.find((m) => m.role === "user");
        lastUserMsg =
          typeof userMsg?.content === "string" ? userMsg.content : "";
        return {
          title: "Repaired",
          generatedAt: "2026-05-05",
          slides: [
            {
              layout: "TitleSlide",
              actionTitle: "Repaired deck · 3 findings reviewed",
              speakerNotes: "Cover slide for the repair-branch test.",
              slots: {},
            },
            {
              layout: "Methodology",
              actionTitle: "Methodology · 6 weeks of Nielsen scan, 2,341 stores",
              speakerNotes: "Closing methodology slide for the repair-branch test.",
              slots: { body: "Repaired methodology body, ≥ 20 chars." },
            },
          ],
        };
      },
    });
    const priorPlan = {
      title: "Stub deck",
      generatedAt: "2026-05-05",
      slides: [
        {
          layout: "TitleSlide" as const,
          actionTitle: "Title with no number",
          speakerNotes: "Speaker notes that meet the 20-char floor easily.",
          slots: {},
        },
        {
          layout: "Methodology" as const,
          actionTitle: "Methodology · 6 weeks of Nielsen scan, 2,341 stores",
          speakerNotes: "Closing slide.",
          slots: { body: "Methodology body that meets the 20-char floor." },
        },
      ],
    };
    const plan = await runDeckPlanner(
      { dashboard: makeDashboard(), generatedAt: "2026-05-05" },
      {},
      { issues: "actionTitle on slide 1 is missing a number", priorPlan }
    );
    assert.ok(plan);
    assert.match(lastUserMsg, /failed verification/);
    assert.match(lastUserMsg, /actionTitle on slide 1 is missing a number/);
    assert.match(lastUserMsg, /Title with no number/);
  });
});
