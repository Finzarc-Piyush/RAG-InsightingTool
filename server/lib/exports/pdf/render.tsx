/**
 * W-EXP-10 · @react-pdf renderer entry point.
 *
 * Symmetric to `pptx/render.ts` (W-EXP-7). Consumes a `SlideDeckPlan`
 * (W-EXP-1) and a `Dashboard`, produces a PDF Buffer. The switch over
 * `slide.layout` is exhaustive — adding the 11th LayoutKind to W-EXP-1
 * fails to compile here, same compile-time guarantee as the PPT side.
 *
 * Architectural choice (locked during W-EXP-7→8): @react-pdf/renderer
 * alone, no Puppeteer. Pure server-side, no Chromium binary, no Vercel
 * cold-start anxiety, no temp tokens / print-route auth dance. Matches
 * the elegance bar from CLAUDE.md ("if a fix feels hacky, implement the
 * elegant solution") — two engines for one job is hacky.
 */
import React from "react";
import { Document, pdf } from "@react-pdf/renderer";
import { resolveChartIdToSpec } from "../../agents/runtime/deckPlanner.js";
import { renderChartSpecToSvg } from "../chartSsr.js";
import { TitleSlidePage } from "./layouts/titleSlide.js";
import { ExecSummaryPage } from "./layouts/execSummary.js";
import { KpiRowPage } from "./layouts/kpiRow.js";
import { ChartWithInsightPage, type PdfChartDeps } from "./layouts/chartWithInsight.js";
import { TableSlidePage, type PdfTableData, type PdfTableDeps } from "./layouts/tableSlide.js";
import { TwoChartComparePage } from "./layouts/twoChartCompare.js";
import { ImplicationsByHorizonPage } from "./layouts/implicationsByHorizon.js";
import { RecommendationsPage } from "./layouts/recommendations.js";
import { MethodologyPage } from "./layouts/methodology.js";
import { AppendixPage } from "./layouts/appendix.js";
import { LAYOUT_KIND, type SlideDeckPlan } from "../../../shared/exportSchema.js";
import type { Dashboard, DashboardSheet } from "../../../shared/schema.js";
import type { PdfSlideContext } from "./master.js";

interface RenderPdfOptions {
  brandLine?: string;
  confidentiality?: string;
  preparedFor?: string;
}

function resolveTableIdToData(dashboard: Dashboard, tableId: string): PdfTableData | null {
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
  return { caption: tbl.caption, columns: tbl.columns, rows: tbl.rows };
}

export async function renderDeckPlanToPdfBuffer(
  plan: SlideDeckPlan,
  dashboard: Dashboard,
  opts: RenderPdfOptions = {}
): Promise<Buffer> {
  const ctx: PdfSlideContext & { deckTitle: string; deckSubtitle?: string; preparedFor?: string } = {
    brandLine: opts.brandLine ?? `${plan.title} · ${plan.preparedFor ?? "Marico Insighting Tool"}`,
    generatedAt: plan.generatedAt,
    confidentiality: opts.confidentiality ?? plan.confidentiality ?? "Internal",
    deckTitle: plan.title,
    deckSubtitle: plan.subtitle,
    preparedFor: plan.preparedFor ?? opts.preparedFor,
  };

  const chartDeps: PdfChartDeps = {
    resolveChart: (id: string) => resolveChartIdToSpec(dashboard, id)?.chart ?? null,
    renderSvg: (spec, options) => renderChartSpecToSvg(spec, options),
  };
  const tableDeps: PdfTableDeps = {
    resolveTable: (id: string) => resolveTableIdToData(dashboard, id),
  };

  const pages = plan.slides.map((slide, idx) => {
    switch (slide.layout) {
      case LAYOUT_KIND.TitleSlide:
        return <TitleSlidePage key={idx} spec={slide} ctx={ctx} />;
      case LAYOUT_KIND.ExecSummary:
        return <ExecSummaryPage key={idx} spec={slide} ctx={ctx} />;
      case LAYOUT_KIND.KpiRow:
        return <KpiRowPage key={idx} spec={slide} ctx={ctx} />;
      case LAYOUT_KIND.ChartWithInsight:
        return <ChartWithInsightPage key={idx} spec={slide} ctx={ctx} deps={chartDeps} />;
      case LAYOUT_KIND.TwoChartCompare:
        return <TwoChartComparePage key={idx} spec={slide} ctx={ctx} deps={chartDeps} />;
      case LAYOUT_KIND.TableSlide:
        return <TableSlidePage key={idx} spec={slide} ctx={ctx} deps={tableDeps} />;
      case LAYOUT_KIND.ImplicationsByHorizon:
        return <ImplicationsByHorizonPage key={idx} spec={slide} ctx={ctx} />;
      case LAYOUT_KIND.Recommendations:
        return <RecommendationsPage key={idx} spec={slide} ctx={ctx} />;
      case LAYOUT_KIND.Methodology:
        return <MethodologyPage key={idx} spec={slide} ctx={ctx} />;
      case LAYOUT_KIND.Appendix:
        return <AppendixPage key={idx} spec={slide} ctx={ctx} deps={{ ...chartDeps, ...tableDeps }} />;
      default: {
        // Compile-time exhaustiveness check — adding an 11th LayoutKind
        // forces a case here.
        const _exhaustive: never = slide;
        void _exhaustive;
        return null;
      }
    }
  });

  const doc = (
    <Document
      title={plan.title}
      author={ctx.preparedFor ?? "Marico Insighting Tool"}
      subject={plan.subtitle ?? "Dashboard export"}
    >
      {pages}
    </Document>
  );

  // `pdf(doc).toBuffer()` returns a Node Readable; wait for the whole
  // stream to settle into a Buffer.
  const stream = (await pdf(doc).toBuffer()) as NodeJS.ReadableStream;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
