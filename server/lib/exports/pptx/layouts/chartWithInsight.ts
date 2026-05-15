/**
 * W-EXP-5 · ChartWithInsight layout.
 *
 * The default findings layout — one chart taking ~70% of the content area,
 * with a one-sentence so-what insight beneath. This is where pptxgenjs's
 * native `addChart` shines: the recipient can right-click → Edit Data and
 * actually edit the bars/lines, recolour to their brand, swap an axis
 * label. Rastered chart screenshots are the #1 amateur tell of analytical
 * decks.
 *
 * Chart-id resolution: `spec.slots.chartId` matches the inventory id
 * allocated by [`buildSlimDashboard`](../../../agents/runtime/deckPlanner.ts).
 * The caller passes a `chartIdResolver` callback so this file stays
 * decoupled from the dashboard model — keeps unit tests cheap.
 *
 * Native vs. SVG fallback decision lives in W-EXP-6's `chartSpecToAddChart`
 * wrapper. If the chart type isn't natively renderable, that wrapper
 * returns null and this layout drops back to an inline SVG image rendered
 * via [`renderChartSpecToSvg`](../../chartSsr.ts) (W-EXP-4).
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  attachSpeakerNotes,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { ChartSpec } from "../../../../shared/schema.js";

export interface ChartIdResolver {
  /** Returns null when the id doesn't correspond to a chart in the dashboard. */
  (chartId: string): ChartSpec | null;
}

export interface ChartRenderer {
  /**
   * Given a ChartSpec, render it onto the slide within the supplied
   * bounding box. Returns true on success, false when the chart type
   * isn't supported (caller falls back to SVG). The actual implementation
   * lands in W-EXP-6 (`chartSpecToAddChart`); this layout is engine-agnostic.
   */
  (spec: ChartSpec, slide: { addChart: (...args: unknown[]) => unknown }, bounds: PptxRectShape): boolean;
}

export interface SvgFallbackRenderer {
  (spec: ChartSpec, opts: { width: number; height: number }): string | null;
}

export interface ChartLayoutDeps {
  resolveChart: ChartIdResolver;
  renderNative: ChartRenderer;
  renderSvg: SvgFallbackRenderer;
}

const CHART_BOX_RATIO = 0.7; // chart takes 70% of content area height

export function renderChartWithInsight(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "ChartWithInsight" }>,
  deps: ChartLayoutDeps
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const titleH = 0.7;
  const insightH = 1.0;
  const chartBox: PptxRectShape = {
    x: CONTENT_BOX.x,
    y: CONTENT_BOX.y + titleH + 0.2,
    w: CONTENT_BOX.w,
    h: (CONTENT_BOX.h - titleH - insightH) * CHART_BOX_RATIO,
  };

  const chart = deps.resolveChart(spec.slots.chartId);
  if (chart) {
    const ok = deps.renderNative(chart, slide as unknown as { addChart: (...args: unknown[]) => unknown }, chartBox);
    if (!ok) {
      // SVG fallback for chart types pptxgenjs can't render natively
      // (heatmap, sankey, treemap). Pixel-density tuned to look sharp at
      // print zoom — 200 DPI on a 9.4×3-inch frame ≈ 1880×600.
      const svg = deps.renderSvg(chart, { width: Math.round(chartBox.w * 200), height: Math.round(chartBox.h * 200) });
      if (svg) {
        const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
        slide.addImage({ ...chartBox, data: dataUrl });
      }
    }
  } else {
    // Defensive: chart-id missed; render a muted placeholder so the slide
    // still ships rather than failing the whole export.
    slide.addShape("rect", {
      ...chartBox,
      fill: { color: "F8FAFC" },
      line: { color: PPTX_BRAND.border, width: 0.5 },
    });
    slide.addText("Chart unavailable for this slide.", {
      ...chartBox,
      fontFace: PPTX_FONT,
      fontSize: 14,
      color: PPTX_BRAND.muted,
      align: "center",
      valign: "middle",
    });
  }

  // Insight caption — one-sentence so-what
  slide.addText(spec.slots.insight, {
    x: CONTENT_BOX.x,
    y: chartBox.y + chartBox.h + 0.15,
    w: CONTENT_BOX.w,
    h: insightH - 0.3,
    fontFace: PPTX_FONT,
    fontSize: 16,
    color: PPTX_BRAND.foreground,
    align: "left",
    valign: "top",
  });

  // Optional source line (small grey)
  if (spec.slots.source) {
    slide.addText(spec.slots.source, {
      x: CONTENT_BOX.x,
      y: chartBox.y + chartBox.h + 0.85,
      w: CONTENT_BOX.w,
      h: 0.3,
      fontFace: PPTX_FONT,
      fontSize: 10,
      italic: true,
      color: PPTX_BRAND.muted,
      align: "left",
      valign: "top",
    });
  }

  attachSpeakerNotes(slide, spec.speakerNotes);
}
