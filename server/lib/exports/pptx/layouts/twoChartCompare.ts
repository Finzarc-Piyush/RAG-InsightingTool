/**
 * W-EXP-6 · TwoChartCompare layout.
 *
 * Two equal framed chart cards side-by-side under a shared action title, each
 * topped by a small eyebrow = that chart's own title so the reader knows which
 * pane is which. Beneath both: the comparison insight in a gold-railed soft
 * callout, with an optional muted source caption. Reserved for genuine
 * comparisons (before/after, trend + decomposition) — never just to fit two
 * charts on one slide; the deck-planner system prompt says so explicitly.
 *
 * Charts/placeholders go through the shared `placeChartOrPlaceholder` helper so
 * the framed card + chart (or the muted "unavailable" tile) matches the rest of
 * the deck by construction. The vertical budget is computed from the bottom up
 * so the insight callout + source always clear the footer (~6.92in).
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  PPTX_TYPE,
  addCard,
  attachSpeakerNotes,
  eyebrow,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxSlide, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import { placeChartOrPlaceholder, type ChartLayoutDeps } from "./chartWithInsight.js";

/** Draw the per-pane eyebrow (chart title) + framed chart card for one side. */
function renderPane(
  slide: PptxSlide,
  deps: ChartLayoutDeps,
  chartId: string,
  paneBox: PptxRectShape,
  eyebrowH: number,
): void {
  const chart = deps.resolveChart(chartId);
  const label = (chart?.title ?? "").trim() || "Chart";
  eyebrow(slide, { x: paneBox.x + 0.04, y: paneBox.y, w: paneBox.w - 0.08, h: eyebrowH }, label, {
    color: PPTX_BRAND.primary,
  });
  const chartBox: PptxRectShape = {
    x: paneBox.x,
    y: paneBox.y + eyebrowH,
    w: paneBox.w,
    h: paneBox.h - eyebrowH,
  };
  placeChartOrPlaceholder(slide, chart, chartBox, { renderChartInto: deps.renderChartInto });
}

export function renderTwoChartCompare(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "TwoChartCompare" }>,
  deps: ChartLayoutDeps,
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h; // 6.98 — keep all content above ~6.92

  // Bottom-up budget: reserve the callout + (optional) source first, then give
  // the rest to the two panes so nothing ever collides with the footer.
  const gutter = 0.3;
  const eyebrowH = 0.26;
  const gap = 0.16;
  const insightH = 0.84;
  const sourceH = spec.slots.source ? 0.28 : 0;

  // Panes fill everything between the action title and the callout block.
  const panesTop = top + 0.02;
  const panesH = contentBottom - panesTop - gap - insightH - (sourceH ? gap * 0.5 + sourceH : 0);
  const paneW = (CONTENT_BOX.w - gutter) / 2;

  const leftBox: PptxRectShape = { x: CONTENT_BOX.x, y: panesTop, w: paneW, h: panesH };
  const rightBox: PptxRectShape = { ...leftBox, x: CONTENT_BOX.x + paneW + gutter };

  renderPane(slide, deps, spec.slots.leftChartId, leftBox, eyebrowH);
  renderPane(slide, deps, spec.slots.rightChartId, rightBox, eyebrowH);

  // Comparison insight — gold-railed soft callout spanning both panes.
  const insightY = panesTop + panesH + gap;
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
      x: CONTENT_BOX.x + 0.04, y: insightY + insightH + gap * 0.5, w: CONTENT_BOX.w - 0.08, h: sourceH,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.caption, italic: true,
      color: PPTX_BRAND.muted, align: "left", valign: "middle", fit: "shrink",
    });
  }

  attachSpeakerNotes(slide, spec.speakerNotes);
}
