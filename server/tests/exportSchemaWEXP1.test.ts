/**
 * W-EXP-1 · `SlideDeckPlan` schema contract.
 *
 * Pins the closed `LayoutKind` enum, the per-layout slot discrimination, the
 * top-level deck cap of 30 slides / floor of 2, and that adding a new layout
 * to the renderer-side switch is a compile-time forcing function. The verifier
 * (W-EXP-3) lives elsewhere — this file only validates the schema shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUT_KIND,
  layoutKindSchema,
  slideDeckPlanSchema,
  slideSpecSchema,
  type LayoutKind,
  type SlideDeckPlan,
  type SlideSpec,
} from "../shared/exportSchema.js";

const baseFields = {
  actionTitle: "Sales fell 12% in Q3 driven by category mix shift",
  speakerNotes:
    "Walk through the quarterly trend; pause on the Q3 break and call out the category-mix split that follows.",
};

describe("W-EXP-1 · LayoutKind enum", () => {
  it("contains exactly the 10 planned layouts and nothing else", () => {
    const expected = [
      "TitleSlide",
      "ExecSummary",
      "KpiRow",
      "ChartWithInsight",
      "TwoChartCompare",
      "TableSlide",
      "ImplicationsByHorizon",
      "Recommendations",
      "Methodology",
      "Appendix",
    ].sort();
    assert.deepEqual(Object.values(LAYOUT_KIND).slice().sort(), expected);
  });

  it("rejects unknown layout values at parse time", () => {
    assert.throws(() => layoutKindSchema.parse("BulletList"));
    assert.throws(() => layoutKindSchema.parse(""));
  });
});

describe("W-EXP-1 · SlideSpec discriminated union", () => {
  it("ChartWithInsight slot requires chartId + insight", () => {
    const slide: SlideSpec = slideSpecSchema.parse({
      ...baseFields,
      layout: LAYOUT_KIND.ChartWithInsight,
      slots: {
        chartId: "chart-quarterly-sales",
        insight: "Category mix drove 8 of the 12pp decline; price held flat.",
      },
    });
    assert.equal(slide.layout, "ChartWithInsight");
    if (slide.layout === "ChartWithInsight") {
      assert.equal(slide.slots.chartId, "chart-quarterly-sales");
    }
  });

  it("ChartWithInsight rejects missing insight", () => {
    assert.throws(() =>
      slideSpecSchema.parse({
        ...baseFields,
        layout: LAYOUT_KIND.ChartWithInsight,
        slots: { chartId: "chart-1" },
      }),
    );
  });

  it("ExecSummary requires 3–6 bullets", () => {
    assert.throws(() =>
      slideSpecSchema.parse({
        ...baseFields,
        layout: LAYOUT_KIND.ExecSummary,
        slots: { bullets: ["Only one bullet — too few"] },
      }),
    );
    const ok = slideSpecSchema.parse({
      ...baseFields,
      layout: LAYOUT_KIND.ExecSummary,
      slots: {
        bullets: [
          "Sales fell 12% in Q3 driven by category mix shift",
          "MARICO held share at 9.1% within FEMALE SHOWER GEL",
          "Distribution gains in modern trade offset 4pp of the decline",
        ],
      },
    });
    assert.equal(ok.layout, "ExecSummary");
  });

  it("KpiRow requires 2–5 KPIs each with label + pre-formatted value", () => {
    const ok = slideSpecSchema.parse({
      ...baseFields,
      layout: LAYOUT_KIND.KpiRow,
      slots: {
        kpis: [
          { label: "Q3 sales", value: "₫68.7B", delta: "−12% vs Q2" },
          { label: "Category share", value: "9.1%", delta: "+0.3pp", confidence: "high" },
        ],
      },
    });
    assert.equal(ok.layout, "KpiRow");
    if (ok.layout === "KpiRow") {
      assert.equal(ok.slots.kpis.length, 2);
    }
  });

  it("TableSlide accepts both ref and inline tableRef shapes", () => {
    const ref = slideSpecSchema.parse({
      ...baseFields,
      layout: LAYOUT_KIND.TableSlide,
      slots: {
        caption: "Brand-level Q3 performance",
        tableRef: { kind: "ref", tableId: "tbl-brand-q3" },
      },
    });
    assert.equal(ref.layout, "TableSlide");

    const inline = slideSpecSchema.parse({
      ...baseFields,
      layout: LAYOUT_KIND.TableSlide,
      slots: {
        tableRef: {
          kind: "inline",
          columns: ["Brand", "Q3 sales", "vs Q2"],
          rows: [
            ["MARICO", 12.4, "+3.1pp"],
            ["PURITE", 8.2, "−1.4pp"],
          ],
        },
      },
    });
    assert.equal(inline.layout, "TableSlide");
  });

  it("ImplicationsByHorizon caps each column at 4 entries", () => {
    assert.throws(() =>
      slideSpecSchema.parse({
        ...baseFields,
        layout: LAYOUT_KIND.ImplicationsByHorizon,
        slots: {
          now: ["a", "b", "c", "d", "e"].map((s) => `${s} — too short`),
          thisQuarter: [],
          strategic: [],
        },
      }),
    );
  });

  it("Recommendations require a horizon enum value per item", () => {
    assert.throws(() =>
      slideSpecSchema.parse({
        ...baseFields,
        layout: LAYOUT_KIND.Recommendations,
        slots: {
          items: [
            {
              action: "Reallocate budget toward MARICO",
              rationale: "Category leader within Female Shower Gel.",
              horizon: "soon" as unknown as "now",
            },
          ],
        },
      }),
    );
  });

  it("Methodology body min length 20 prevents empty placeholder slides", () => {
    assert.throws(() =>
      slideSpecSchema.parse({
        ...baseFields,
        layout: LAYOUT_KIND.Methodology,
        slots: { body: "TBD" },
      }),
    );
  });

  it("rejects a non-enum layout up front (discriminator fails)", () => {
    assert.throws(() =>
      slideSpecSchema.parse({
        ...baseFields,
        layout: "Custom",
        slots: {},
      }),
    );
  });

  it("requires speakerNotes ≥ 20 chars on every slide (verifier-level rule, schema enforces floor)", () => {
    assert.throws(() =>
      slideSpecSchema.parse({
        ...baseFields,
        speakerNotes: "too short",
        layout: LAYOUT_KIND.TitleSlide,
        slots: {},
      }),
    );
  });
});

describe("W-EXP-1 · SlideDeckPlan top-level", () => {
  function makeFiveSlideDeck(): SlideDeckPlan {
    return {
      title: "Marico-VN · category leadership · Q3 review",
      subtitle: "What drove the FEMALE SHOWER GEL decline and how do we respond?",
      generatedAt: "2026-05-05",
      slides: [
        {
          ...baseFields,
          layout: LAYOUT_KIND.TitleSlide,
          slots: {},
        },
        {
          ...baseFields,
          layout: LAYOUT_KIND.ExecSummary,
          slots: {
            bullets: [
              "Sales fell 12% in Q3 driven by category mix shift",
              "MARICO held share at 9.1% within FEMALE SHOWER GEL",
              "Distribution gains in modern trade offset 4pp of the decline",
            ],
          },
        },
        {
          ...baseFields,
          layout: LAYOUT_KIND.ChartWithInsight,
          slots: {
            chartId: "chart-1",
            insight: "Category mix drove 8 of the 12pp decline; price held flat.",
          },
        },
        {
          ...baseFields,
          actionTitle: "Reallocate 18% of trade spend to MARICO in Q4 to hold share",
          layout: LAYOUT_KIND.Recommendations,
          slots: {
            items: [
              {
                action: "Reallocate ₫4B from PURITE to MARICO in trade promotions",
                rationale: "MARICO is the only sub-brand holding share in the declining category.",
                horizon: "now",
                confidence: "medium",
              },
            ],
          },
        },
        {
          ...baseFields,
          actionTitle: "Methodology · 6 weeks of Nielsen scan, 2,341 stores",
          layout: LAYOUT_KIND.Methodology,
          slots: {
            body:
              "Source data: Nielsen MAT scan, weeks ending 2025-W36 through 2025-W41. Coverage: 2,341 modern-trade stores in HCMC + Hanoi. Aggregation: weekly rollup, then quarterly. Caveats listed below apply.",
          },
        },
      ],
    };
  }

  it("accepts a well-formed 5-slide deck", () => {
    const parsed = slideDeckPlanSchema.parse(makeFiveSlideDeck());
    assert.equal(parsed.slides.length, 5);
    assert.equal(parsed.slides[0]?.layout, "TitleSlide");
    assert.equal(parsed.slides[4]?.layout, "Methodology");
  });

  it("rejects fewer than 2 slides", () => {
    assert.throws(() =>
      slideDeckPlanSchema.parse({
        title: "Solo deck",
        generatedAt: "2026-05-05",
        slides: [makeFiveSlideDeck().slides[0]],
      }),
    );
  });

  it("rejects more than 30 slides", () => {
    const huge = makeFiveSlideDeck();
    const filler: SlideSpec = {
      ...baseFields,
      layout: LAYOUT_KIND.ChartWithInsight,
      slots: { chartId: "c", insight: "filler chart with at least ten chars" },
    };
    huge.slides = [huge.slides[0]!, ...Array.from({ length: 30 }, () => filler)];
    assert.equal(huge.slides.length, 31);
    assert.throws(() => slideDeckPlanSchema.parse(huge));
  });

  it("type-narrows `layout` correctly via the discriminator", () => {
    const deck = slideDeckPlanSchema.parse(makeFiveSlideDeck());
    let chartSlideCount = 0;
    for (const slide of deck.slides) {
      if (slide.layout === LAYOUT_KIND.ChartWithInsight) {
        // TS proves slide.slots has chartId here; compile guarantees this branch fires.
        assert.equal(typeof slide.slots.chartId, "string");
        chartSlideCount += 1;
      }
    }
    assert.equal(chartSlideCount, 1);
  });
});

describe("W-EXP-1 · LayoutKind exhaustiveness check (compile-time guarantee)", () => {
  /**
   * Renderers (W-EXP-5/6/8/10) all switch on `slide.layout` and use this
   * helper to guarantee TypeScript's exhaustiveness check fires. If a new
   * layout is added to `LAYOUT_KIND` and a renderer forgets it, this
   * function call inside the `default` branch fails to compile. The runtime
   * test below exercises the helper too so coverage tools count it.
   */
  function assertNever(_x: never): never {
    throw new Error("unreachable");
  }

  it("exhausts every LayoutKind in a switch — adds a layout, this test forces a code-update", () => {
    const all: readonly LayoutKind[] = Object.values(LAYOUT_KIND);
    let touched = 0;
    for (const k of all) {
      switch (k) {
        case LAYOUT_KIND.TitleSlide:
        case LAYOUT_KIND.ExecSummary:
        case LAYOUT_KIND.KpiRow:
        case LAYOUT_KIND.ChartWithInsight:
        case LAYOUT_KIND.TwoChartCompare:
        case LAYOUT_KIND.TableSlide:
        case LAYOUT_KIND.ImplicationsByHorizon:
        case LAYOUT_KIND.Recommendations:
        case LAYOUT_KIND.Methodology:
        case LAYOUT_KIND.Appendix:
          touched += 1;
          break;
        default:
          assertNever(k);
      }
    }
    assert.equal(touched, all.length);
  });
});
