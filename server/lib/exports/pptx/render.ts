/**
 * W-EXP-7 · pptxgenjs renderer entry point.
 *
 * Consumes a `SlideDeckPlan` (W-EXP-1) and a `Dashboard` (for chart/table
 * id resolution), produces a PowerPoint .pptx Buffer.
 *
 * Architecture:
 *   plan: SlideDeckPlan
 *   dashboard: Dashboard
 *           │
 *           ▼
 *   buildSlimDashboard (W-EXP-2 helper) → resolver callbacks
 *           │
 *           ▼
 *   for slide in plan.slides:
 *     switch slide.layout {
 *       TitleSlide → renderTitleSlide(...)
 *       ExecSummary → renderExecSummary(...)
 *       …
 *     }
 *           │
 *           ▼
 *   pres.write({ outputType: "nodebuffer" }) → Buffer
 *
 * The switch is exhaustive — adding an 11th LayoutKind to W-EXP-1 fails
 * to compile here, forcing a renderer addition. Same compile-time
 * guarantee applies in `chartSpecToAddChart` and `findOverloadedBullets`.
 */
import {
  resolveChartIdToSpec,
} from "../../agents/runtime/deckPlanner.js";
import { renderChartSpecToSvg } from "../chartSsr.js";
import { defineMaster } from "./master.js";
import { renderTitleSlide } from "./layouts/titleSlide.js";
import { renderExecSummary } from "./layouts/execSummary.js";
import { renderKpiRow } from "./layouts/kpiRow.js";
import { renderChartWithInsight } from "./layouts/chartWithInsight.js";
import { renderTableSlide, type TableData } from "./layouts/tableSlide.js";
import { renderTwoChartCompare } from "./layouts/twoChartCompare.js";
import { renderImplicationsByHorizon } from "./layouts/implicationsByHorizon.js";
import { renderRecommendations } from "./layouts/recommendations.js";
import { renderMethodology } from "./layouts/methodology.js";
import { renderAppendix } from "./layouts/appendix.js";
import { chartSpecToAddChart } from "./chartSpecToAddChart.js";
import { LAYOUT_KIND, type SlideDeckPlan } from "../../../shared/exportSchema.js";
import type { Dashboard, DashboardSheet } from "../../../shared/schema.js";
import type { PptxPres } from "./types.js";
import { agentLog } from "../../agents/runtime/agentLogger.js";
import { errorMessage } from "../../../utils/errorMessage.js";

interface RenderDeckOptions {
  /** Default "Marico Insighting Tool — internal use". */
  brandLine?: string;
  /** Default `process.env.NODE_ENV === 'production' ? 'Internal' : 'Internal · pre-production'`. */
  confidentiality?: string;
  /** Author metadata for the .pptx. Default "Marico Insighting Tool". */
  author?: string;
}

/**
 * Resolve `tableId` (format `s{sheetIdx}t{tableIdx}`) to a TableData record.
 * Mirrors `resolveChartIdToSpec` from W-EXP-2.
 */
function resolveTableIdToData(dashboard: Dashboard, tableId: string): TableData | null {
  const m = /^s(\d+)t(\d+)$/.exec(tableId);
  if (!m) return null;
  const sheetIdx = Number(m[1]);
  const tableIdx = Number(m[2]);
  const sheets =
    dashboard.sheets && dashboard.sheets.length > 0
      ? [...dashboard.sheets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      : ([
          {
            id: "default",
            name: "Overview",
            charts: dashboard.charts ?? [],
          },
        ] as DashboardSheet[]);
  const tbl = sheets[sheetIdx]?.tables?.[tableIdx];
  if (!tbl) return null;
  return {
    caption: tbl.caption,
    columns: tbl.columns,
    rows: tbl.rows,
  };
}

/**
 * Dynamic-import shim — pptxgenjs's CommonJS default export sometimes
 * resolves as `module.default`, sometimes as `module` itself. Same
 * pattern documented at `pptxExport.service.ts:loadPptxGenJSCtor`.
 */
async function loadPptxGenJSCtor(): Promise<new () => unknown> {
  const mod: unknown = await import("pptxgenjs");
  const direct = mod as { default?: unknown };
  const ctor = (typeof direct === "function" ? direct : direct?.default) as
    | (new () => unknown)
    | undefined;
  if (typeof ctor !== "function") {
    throw new Error("pptxgenjs default export is not a constructor");
  }
  return ctor;
}

export async function renderDeckPlanToPptxBuffer(
  plan: SlideDeckPlan,
  dashboard: Dashboard,
  opts: RenderDeckOptions = {}
): Promise<Buffer> {
  const Ctor = await loadPptxGenJSCtor();
  const pres = new Ctor() as unknown as PptxPres;
  pres.author = opts.author ?? "Marico Insighting Tool";
  pres.title = plan.title;
  pres.layout = "LAYOUT_WIDE";

  defineMaster(pres, {
    brandLine: opts.brandLine ?? `${plan.title} · ${plan.preparedFor ?? "Marico Insighting Tool"}`,
    confidentiality: opts.confidentiality ?? plan.confidentiality ?? "Internal",
    generatedAt: plan.generatedAt,
  });

  // Centralised chart placement. Native pptxgenjs charts are the DEFAULT —
  // they render in every viewer (PowerPoint / Keynote / Google Slides) and
  // ship an editable embedded XLSX. The rich SVG renderer is the fallback for
  // types native can't do (heatmap, dual-axis) and the `PPTX_SVG_CHARTS=true`
  // opt-in. SVG must be embedded as base64 (pptxgenjs silently drops `;utf8,`).
  const preferSvg = process.env.PPTX_SVG_CHARTS === "true";
  const renderChartInto = (
    spec: Parameters<typeof renderChartSpecToSvg>[0],
    slide: { addChart: (...args: unknown[]) => unknown; addImage: (opts: Record<string, unknown>) => unknown },
    box: { x: number; y: number; w: number; h: number }
  ): boolean => {
    try {
      if (!preferSvg && chartSpecToAddChart(spec, slide, box)) return true;
      const svg = renderChartSpecToSvg(spec, { width: Math.round(box.w * 200), height: Math.round(box.h * 200) });
      if (!svg) return false;
      const base64 = Buffer.from(svg, "utf8").toString("base64");
      slide.addImage({ x: box.x, y: box.y, w: box.w, h: box.h, data: `data:image/svg+xml;base64,${base64}` });
      return true;
    } catch (err) {
      // A single bad chart must never corrupt the file or 500 the export — return
      // false so the caller draws a visible placeholder, and log so this stops
      // being invisible to ops.
      agentLog("pptxRender.chartFailed", {
        chartType: String((spec as { type?: unknown }).type ?? ""),
        title: String((spec as { title?: unknown }).title ?? "").slice(0, 80),
        error: errorMessage(err).slice(0, 200),
      });
      return false;
    }
  };

  const chartLayoutDeps = {
    resolveChart: (id: string) => {
      const r = resolveChartIdToSpec(dashboard, id);
      return r?.chart ?? null;
    },
    renderChartInto,
    renderNative: chartSpecToAddChart,
    renderSvg: (spec: Parameters<typeof renderChartSpecToSvg>[0], options: { width: number; height: number }) =>
      renderChartSpecToSvg(spec, options),
  };
  const tableLayoutDeps = {
    resolveTable: (id: string) => resolveTableIdToData(dashboard, id),
  };

  for (const slide of plan.slides) {
    // Per-slide isolation: one malformed layout can never abort the whole deck
    // (which would 500 the export) or leave a half-written slide. Skip + log.
    try {
      switch (slide.layout) {
        case LAYOUT_KIND.TitleSlide:
          renderTitleSlide(pres, slide, {
            deckTitle: plan.title,
            deckSubtitle: plan.subtitle,
            generatedAt: plan.generatedAt,
            confidentiality: plan.confidentiality ?? "Internal",
            preparedFor: plan.preparedFor,
          });
          break;
        case LAYOUT_KIND.ExecSummary:
          renderExecSummary(pres, slide);
          break;
        case LAYOUT_KIND.KpiRow:
          renderKpiRow(pres, slide);
          break;
        case LAYOUT_KIND.ChartWithInsight:
          renderChartWithInsight(pres, slide, chartLayoutDeps);
          break;
        case LAYOUT_KIND.TwoChartCompare:
          renderTwoChartCompare(pres, slide, chartLayoutDeps);
          break;
        case LAYOUT_KIND.TableSlide:
          renderTableSlide(pres, slide, tableLayoutDeps);
          break;
        case LAYOUT_KIND.ImplicationsByHorizon:
          renderImplicationsByHorizon(pres, slide);
          break;
        case LAYOUT_KIND.Recommendations:
          renderRecommendations(pres, slide);
          break;
        case LAYOUT_KIND.Methodology:
          renderMethodology(pres, slide);
          break;
        case LAYOUT_KIND.Appendix:
          renderAppendix(pres, slide, { ...chartLayoutDeps, ...tableLayoutDeps });
          break;
        default: {
          // Compile-time exhaustiveness check — adding an 11th LayoutKind
          // to W-EXP-1 forces a case here.
          const _exhaustive: never = slide;
          void _exhaustive;
          break;
        }
      }
    } catch (err) {
      agentLog("pptxRender.slideFailed", {
        layout: String((slide as { layout?: unknown }).layout ?? ""),
        error: errorMessage(err).slice(0, 200),
      });
    }
  }

  const buf = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return buf;
}
