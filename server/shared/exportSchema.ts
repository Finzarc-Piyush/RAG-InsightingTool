/**
 * W-EXP-1 · Dashboard export — `SlideDeckPlan` schema.
 *
 * This is the structured-output contract the deck-planner LLM (W-EXP-2) emits
 * and both renderers consume:
 *   - PPT renderer (W-EXP-5/6/7) → pptxgenjs with native `addChart` / `addTable`
 *   - PDF renderer (W-EXP-8/9/10/11) → React print route via Puppeteer, with
 *     `@react-pdf/renderer` as a no-Chromium fallback
 *
 * Design decisions (locked in the approved plan, see
 * `/Users/tida/.claude/plans/the-dashboard-download-feature-cozy-flask.md`):
 *
 *   1. The LLM picks `layout` from a CLOSED enum (`LayoutKind`). It cannot
 *      invent layouts. Every layout has a typed `slots` discriminator so the
 *      renderer's TypeScript exhaustiveness check catches missing layouts at
 *      compile time, not at the user's download click.
 *   2. The LLM writes `actionTitle` and `speakerNotes`. It does NOT pick
 *      fonts, colours, or positions — that's the renderer's job. The
 *      verifier (W-EXP-3) enforces "verb + number" on `actionTitle` before
 *      render.
 *   3. Charts referenced by `chartId` resolve against the dashboard's own
 *      chart inventory (we don't pass full chart data through the LLM, only
 *      a slim catalogue + ids). Keeps the prompt cheap and deterministic.
 *   4. Caps are deliberately loose. The verifier enforces *presence* of
 *      action titles, methodology placement, speaker notes — not lengths.
 *      Mirrors the WTL3 precedent on `messageAnswerEnvelopeSchema`.
 *
 * The shape is intentionally narrow (~10 layout kinds) — adding an 11th is
 * cheap (one enum entry + one renderer per format), but the LLM should pick
 * from a small, well-understood vocabulary, the way Beautiful.ai's "Smart
 * Slides" do.
 */
import { z } from "zod";

/** Closed enum of layout kinds the LLM can pick from. */
export const LAYOUT_KIND = {
  /** Cover slide — deck title, sub-title, date, prepared-for, confidentiality. */
  TitleSlide: "TitleSlide",
  /** Single-slide TL;DR — 3–5 action-titled bullet rows. Slide #2 by convention. */
  ExecSummary: "ExecSummary",
  /** Row of 3–5 KPI tiles — each with a label, value, optional delta + sparkline ref. */
  KpiRow: "KpiRow",
  /** One chart + a one-sentence insight caption beneath. The default findings layout. */
  ChartWithInsight: "ChartWithInsight",
  /** Two charts side-by-side — for "before/after", "A vs B", or "trend + decomposition". */
  TwoChartCompare: "TwoChartCompare",
  /** Native data table — rows × columns, optional caption. Tables-as-image is forbidden. */
  TableSlide: "TableSlide",
  /** Three-column layout grouping `implications` by horizon (now / this_quarter / strategic). */
  ImplicationsByHorizon: "ImplicationsByHorizon",
  /** Numbered recommendations + horizon chip + optional confidence/owner. */
  Recommendations: "Recommendations",
  /** Methodology + caveats — small font, near the back of the deck. */
  Methodology: "Methodology",
  /** Appendix — denser charts/tables, smaller grid; explicitly labelled so the executive reader skips. */
  Appendix: "Appendix",
} as const;

export type LayoutKind = (typeof LAYOUT_KIND)[keyof typeof LAYOUT_KIND];

export const layoutKindSchema = z.enum([
  LAYOUT_KIND.TitleSlide,
  LAYOUT_KIND.ExecSummary,
  LAYOUT_KIND.KpiRow,
  LAYOUT_KIND.ChartWithInsight,
  LAYOUT_KIND.TwoChartCompare,
  LAYOUT_KIND.TableSlide,
  LAYOUT_KIND.ImplicationsByHorizon,
  LAYOUT_KIND.Recommendations,
  LAYOUT_KIND.Methodology,
  LAYOUT_KIND.Appendix,
]);

/** Per-layout slot shapes. Each variant is a discriminator so renderers stay exhaustive. */

const titleSlideSlotsSchema = z.object({
  /** Sub-title — typically the question being answered. */
  subtitle: z.string().max(400).optional(),
  /** Prepared-for line (e.g. "Marico Vietnam · category leadership team"). */
  preparedFor: z.string().max(200).optional(),
  /** Confidentiality classification (e.g. "Internal · do not distribute"). */
  confidentiality: z.string().max(120).optional(),
});

const execSummarySlotsSchema = z.object({
  /**
   * 3–5 takeaway bullets. Each MUST be a complete sentence — verb + number
   * where possible. The verifier (W-EXP-3) checks the slide's `actionTitle`
   * but not these inner bullets, so the planner prompt is responsible for
   * keeping them tight.
   */
  bullets: z.array(z.string().min(8).max(400)).min(3).max(6),
});

const kpiRowSlotsSchema = z.object({
  kpis: z
    .array(
      z.object({
        label: z.string().max(120),
        /** Pre-formatted display value, e.g. "₫68.7B" or "−12.4%". The renderer does not reformat. */
        value: z.string().max(80),
        /** Optional delta line, e.g. "+3.1pp vs Q2". */
        delta: z.string().max(120).optional(),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .min(2)
    .max(5),
});

const chartWithInsightSlotsSchema = z.object({
  /** Resolves against `Dashboard.charts[]` / `sheets[].charts[]` by `ChartSpec.title` (or a synthetic id). */
  chartId: z.string().min(1).max(200),
  /**
   * One-sentence caption underneath. Should explain the SO-WHAT, not restate
   * the chart title (e.g. "Category mix drove 8 of the 12pp decline"
   * — not "Sales by quarter trend").
   */
  insight: z.string().min(10).max(400),
  /** Optional source line (e.g. "Source: Nielsen scan, Q3 2025; n=2,341"). */
  source: z.string().max(200).optional(),
});

const twoChartCompareSlotsSchema = z.object({
  leftChartId: z.string().min(1).max(200),
  rightChartId: z.string().min(1).max(200),
  /** What the comparison reveals — single sentence beneath both charts. */
  insight: z.string().min(10).max(400),
  source: z.string().max(200).optional(),
});

const tableSlideSlotsSchema = z.object({
  caption: z.string().max(200).optional(),
  /** Resolves against `DashboardSheet.tables[]` by id, OR an inline table. */
  tableRef: z
    .union([
      z.object({ kind: z.literal("ref"), tableId: z.string().min(1).max(200) }),
      z.object({
        kind: z.literal("inline"),
        columns: z.array(z.string().max(200)).min(1).max(20),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(50),
      }),
    ]),
  /** Optional one-sentence takeaway above the table. */
  insight: z.string().max(400).optional(),
});

const implicationsByHorizonSlotsSchema = z.object({
  /** Up to 4 entries per column — keeps the slide ≤10s readable. */
  now: z.array(z.string().min(8).max(400)).max(4),
  thisQuarter: z.array(z.string().min(8).max(400)).max(4),
  strategic: z.array(z.string().min(8).max(400)).max(4),
});

const recommendationsSlotsSchema = z.object({
  items: z
    .array(
      z.object({
        action: z.string().min(8).max(400),
        rationale: z.string().min(8).max(800),
        horizon: z.enum(["now", "this_quarter", "strategic"]),
        confidence: z.enum(["low", "medium", "high"]).optional(),
        /** Optional owner — kept generic ("Marketing", "Insights team") since we don't know the org chart. */
        owner: z.string().max(120).optional(),
      })
    )
    .min(1)
    .max(8),
});

const methodologySlotsSchema = z.object({
  /** Free-form prose; the renderer applies the small-font / back-of-deck styling. */
  body: z.string().min(20).max(3500),
  /** Limitations / caveats list. */
  caveats: z.array(z.string().max(400)).max(10).optional(),
});

const appendixSlotsSchema = z.object({
  /** May reference a chart, a table, or just be a body of supporting text. */
  chartId: z.string().min(1).max(200).optional(),
  tableId: z.string().min(1).max(200).optional(),
  body: z.string().max(2000).optional(),
});

/** Discriminated union — `layout` selects which `slots` shape applies. */
export const slideSpecSchema = z.discriminatedUnion("layout", [
  z.object({
    layout: z.literal(LAYOUT_KIND.TitleSlide),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: titleSlideSlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.ExecSummary),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: execSummarySlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.KpiRow),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: kpiRowSlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.ChartWithInsight),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: chartWithInsightSlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.TwoChartCompare),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: twoChartCompareSlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.TableSlide),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: tableSlideSlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.ImplicationsByHorizon),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: implicationsByHorizonSlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.Recommendations),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: recommendationsSlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.Methodology),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: methodologySlotsSchema,
  }),
  z.object({
    layout: z.literal(LAYOUT_KIND.Appendix),
    actionTitle: z.string().min(4).max(280),
    speakerNotes: z.string().min(20).max(1500),
    slots: appendixSlotsSchema,
  }),
]);

export type SlideSpec = z.infer<typeof slideSpecSchema>;

/**
 * Top-level deck plan. Caps are loose; deterministic checks live in the
 * verifier (W-EXP-3) — e.g. methodology in the back third, every slide has
 * an action title that contains a verb + a number.
 */
export const slideDeckPlanSchema = z.object({
  /** Deck title — typically the dashboard name. */
  title: z.string().min(1).max(200),
  /** Sub-title — usually the question that motivated the analysis. */
  subtitle: z.string().max(400).optional(),
  /** ISO date of generation; renderer formats per locale. */
  generatedAt: z.string().min(4).max(40),
  /** Marico / FMCG context tag — drives the cover-slide branding line. Optional. */
  preparedFor: z.string().max(200).optional(),
  confidentiality: z.string().max(120).optional(),
  /**
   * The slides themselves. 6–25 is the realistic range for a board-pack
   * section; the planner prompt nudges 8–14. Hard cap at 30 to prevent
   * runaway decks.
   */
  slides: z.array(slideSpecSchema).min(2).max(30),
});

export type SlideDeckPlan = z.infer<typeof slideDeckPlanSchema>;
