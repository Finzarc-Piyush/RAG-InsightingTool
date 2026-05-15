/**
 * W-EXP-13 · Golden Marico-VN Q3 fixture.
 *
 * Stable test fixture exercised by the golden-deck e2e test (W-EXP-13)
 * and the action-title CI gate (W-EXP-14). Pinned here so:
 *   - Future planner-prompt changes that subtly degrade output are
 *     caught (the deterministic `verifyDeckPlan` check has to keep
 *     accepting these slide titles).
 *   - Future renderer changes are validated against a known-good plan
 *     without needing a fresh LLM call per CI run.
 *
 * Mirrors the Marico-VN Q3 review case study used in the planner system
 * prompt — same dashboard the planner would naturally produce a deck
 * for in production.
 */
import type { Dashboard, ChartSpec } from "../../shared/schema.js";
import type { SlideDeckPlan } from "../../shared/exportSchema.js";

function chart(title: string, type: ChartSpec["type"], x: string, y: string, data: Record<string, string | number>[]): ChartSpec {
  return { type, title, x, y, data } as ChartSpec;
}

export const MARICO_VN_Q3_DASHBOARD: Dashboard = {
  id: "dash-marico-vn-q3",
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
      charts: [
        chart("Quarterly sales trend", "bar", "Quarter", "Sales", [
          { Quarter: "Q1", Sales: 78.4 },
          { Quarter: "Q2", Sales: 78.0 },
          { Quarter: "Q3", Sales: 68.7 },
        ]),
        chart("Brand share within FEMALE SHOWER GEL", "pie", "Brand", "Share", [
          { Brand: "MARICO", Share: 31 },
          { Brand: "PURITE", Share: 22 },
          { Brand: "OLIV", Share: 18 },
          { Brand: "LASHE", Share: 29 },
        ]),
      ],
      tables: [
        {
          id: "tbl-1",
          caption: "Brand-level Q3 performance",
          columns: ["Brand", "Q3 sales", "vs Q2"],
          rows: [
            ["MARICO", 12.4, "+3.1pp"],
            ["PURITE", 8.2, "−1.4pp"],
            ["OLIV", 5.6, "−0.6pp"],
            ["LASHE", 11.0, "+0.2pp"],
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
      {
        headline: "MARICO held share at 9.1% within FEMALE SHOWER GEL",
        evidence: "Brand-level share table shows MARICO is the only sub-brand gaining share in the declining category.",
        magnitude: "+0.3pp vs Q2",
      },
    ],
    magnitudes: [
      { label: "Q3 sales", value: "₫68.7B", confidence: "high" },
      { label: "Category share (MARICO)", value: "9.1%", confidence: "high" },
    ],
    methodology:
      "Nielsen MAT scan weeks ending 2025-W36 through 2025-W41; coverage 2,341 modern-trade stores in HCMC + Hanoi.",
    caveats: ["Modern trade only; traditional trade not included."],
  },
} as Dashboard;

export const MARICO_VN_Q3_PLAN: SlideDeckPlan = {
  title: "Marico-VN · Q3 review",
  subtitle: "What drove the FEMALE SHOWER GEL decline and how do we respond?",
  generatedAt: "2026-05-05",
  confidentiality: "Internal",
  preparedFor: "Marico Vietnam · category leadership team",
  slides: [
    {
      layout: "TitleSlide",
      actionTitle: "Marico-VN · Q3 review with 4 findings to action",
      speakerNotes: "Cover slide. Pause for 2 seconds to set the scene before the exec summary.",
      slots: { subtitle: "Q3 2025 category leadership review", confidentiality: "Internal" },
    },
    {
      layout: "ExecSummary",
      actionTitle: "3 takeaways shape the response to the Q3 9% sales decline",
      speakerNotes: "TL;DR slide carrying the whole story. Reading just this slide gives the executive the answer.",
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
      speakerNotes: "Three KPIs — sales total, category share, distribution. Each tile is one number.",
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
      speakerNotes: "Quarterly bar trend. Highlight the Q3 break.",
      slots: {
        chartId: "s0c0",
        insight: "Category mix drove 8 of the 12pp decline; price held flat.",
        source: "Source: Nielsen MAT scan, Q3 2025; n=2,341 stores.",
      },
    },
    {
      layout: "TableSlide",
      actionTitle: "Brand-level Q3 performance reveals MARICO's 3.1pp share gain",
      speakerNotes: "Native table — recipients can copy values into Excel.",
      slots: {
        tableRef: { kind: "ref", tableId: "s0t0" },
        insight: "MARICO is the only sub-brand holding share within the declining category.",
      },
    },
    {
      layout: "ImplicationsByHorizon",
      actionTitle: "3 horizons of response shape the Q3 recovery plan",
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
        caveats: ["Modern trade only; traditional trade not included."],
      },
    },
  ],
};
