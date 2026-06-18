/**
 * ChartWithInsight layout — the default findings slide.
 *
 * A framed chart card fills most of the content area; a gold-railed "so-what"
 * callout sits beneath it carrying the one-sentence insight, with an optional
 * source line. The chart is drawn by `deps.renderChartInto` (rich on-brand SVG
 * by default — multi-series, data labels, legend — vector and crisp).
 */
import {
  CONTENT_BOX, MASTER_NAME, PPTX_BRAND, PPTX_FONT, PPTX_TYPE,
  addCard, renderActionTitle, attachSpeakerNotes,
} from "../master.js";
import type { PptxPres, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { ChartSpec } from "../../../../shared/schema.js";

export interface ChartIdResolver {
  (chartId: string): ChartSpec | null;
}

/** Places a chart (native-or-SVG, with `sizing:contain`) into `box`. */
export interface ChartIntoRenderer {
  (
    spec: ChartSpec,
    slide: { addChart: (...args: unknown[]) => unknown; addImage: (opts: Record<string, unknown>) => unknown },
    box: PptxRectShape
  ): boolean;
}

// Legacy single-engine callbacks — still provided by render.ts during the
// transition; new layouts use `renderChartInto`.
export interface ChartRenderer {
  (spec: ChartSpec, slide: { addChart: (...args: unknown[]) => unknown }, bounds: PptxRectShape): boolean;
}
export interface SvgFallbackRenderer {
  (spec: ChartSpec, opts: { width: number; height: number }): string | null;
}

export interface ChartLayoutDeps {
  resolveChart: ChartIdResolver;
  renderChartInto: ChartIntoRenderer;
  renderNative: ChartRenderer;
  renderSvg: SvgFallbackRenderer;
}

/** Draw a chart into `box`, or a muted "unavailable" placeholder card. */
export function placeChartOrPlaceholder(
  slide: PptxPres extends never ? never : ReturnType<PptxPres["addSlide"]>,
  chart: ChartSpec | null,
  box: PptxRectShape,
  deps: Pick<ChartLayoutDeps, "renderChartInto">
): void {
  if (chart) {
    addCard(slide, box, { fill: PPTX_BRAND.background, shadow: true });
    const pad = 0.16;
    deps.renderChartInto(chart, slide as unknown as { addChart: (...a: unknown[]) => unknown; addImage: (o: Record<string, unknown>) => unknown }, {
      x: box.x + pad, y: box.y + pad, w: box.w - pad * 2, h: box.h - pad * 2,
    });
  } else {
    addCard(slide, box, { fill: PPTX_BRAND.surfaceMuted, shadow: false });
    slide.addText("Chart unavailable for this slide.", {
      x: box.x, y: box.y, w: box.w, h: box.h,
      fontFace: PPTX_FONT, fontSize: 14, color: PPTX_BRAND.muted, align: "center", valign: "middle",
    });
  }
}

export function renderChartWithInsight(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "ChartWithInsight" }>,
  deps: ChartLayoutDeps
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h;

  const sourceH = spec.slots.source ? 0.3 : 0;
  const insightH = 0.92;
  const gap = 0.16;

  const chartBox: PptxRectShape = {
    x: CONTENT_BOX.x, y: top + 0.02, w: CONTENT_BOX.w,
    h: contentBottom - (top + 0.02) - insightH - sourceH - gap * 2,
  };
  placeChartOrPlaceholder(slide, deps.resolveChart(spec.slots.chartId), chartBox, deps);

  // "So-what" callout — gold-railed soft card.
  const insightY = chartBox.y + chartBox.h + gap;
  addCard(slide, { x: CONTENT_BOX.x, y: insightY, w: CONTENT_BOX.w, h: insightH }, {
    fill: PPTX_BRAND.surfaceMuted, accent: PPTX_BRAND.accent, shadow: false,
  });
  slide.addText(spec.slots.insight, {
    x: CONTENT_BOX.x + 0.32, y: insightY, w: CONTENT_BOX.w - 0.56, h: insightH,
    fontFace: PPTX_FONT, fontSize: PPTX_TYPE.lead, color: PPTX_BRAND.foreground,
    align: "left", valign: "middle", lineSpacingMultiple: 1.05, fit: "shrink",
  });

  if (spec.slots.source) {
    slide.addText(spec.slots.source, {
      x: CONTENT_BOX.x, y: insightY + insightH + 0.04, w: CONTENT_BOX.w, h: sourceH - 0.04,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.caption, italic: true,
      color: PPTX_BRAND.muted, align: "left", valign: "middle",
    });
  }

  attachSpeakerNotes(slide, spec.speakerNotes);
}
