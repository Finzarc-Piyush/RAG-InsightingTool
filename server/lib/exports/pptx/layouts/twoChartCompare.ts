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
  attachSpeakerNotes,
  eyebrow,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxSlide, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import {
  placeChartOrPlaceholder,
  insightCalloutHeight,
  renderInsightCallout,
  type ChartLayoutDeps,
} from "./chartWithInsight.js";
import { splitChartInsightLanes } from "../../../../shared/chartInsightLanes.js";

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

  // Bottom-up budget: size the comparison callout to its content (capped so the
  // two panes always keep the majority of the band), then give the rest to the
  // panes so nothing collides with the footer or spills onto a chart.
  const gutter = 0.3;
  const eyebrowH = 0.26;
  const gap = 0.16;
  const sourceH = spec.slots.source ? 0.28 : 0;

  const panesTop = top + 0.02;
  const band = contentBottom - panesTop;
  const lanes = splitChartInsightLanes(spec.slots.insight);
  const maxInsightH = band * 0.34; // two panes need the lion's share of the band
  const insightH = insightCalloutHeight(lanes, CONTENT_BOX.w, maxInsightH);

  const panesH = band - gap - insightH - (sourceH ? gap * 0.5 + sourceH : 0);
  const paneW = (CONTENT_BOX.w - gutter) / 2;

  const leftBox: PptxRectShape = { x: CONTENT_BOX.x, y: panesTop, w: paneW, h: panesH };
  const rightBox: PptxRectShape = { ...leftBox, x: CONTENT_BOX.x + paneW + gutter };

  renderPane(slide, deps, spec.slots.leftChartId, leftBox, eyebrowH);
  renderPane(slide, deps, spec.slots.rightChartId, rightBox, eyebrowH);

  // Comparison insight — gold-railed soft callout spanning both panes.
  const insightY = panesTop + panesH + gap;
  const overflow = renderInsightCallout(slide, lanes, {
    x: CONTENT_BOX.x, y: insightY, w: CONTENT_BOX.w, h: insightH,
  });

  if (spec.slots.source) {
    slide.addText(spec.slots.source, {
      x: CONTENT_BOX.x + 0.04, y: insightY + insightH + gap * 0.5, w: CONTENT_BOX.w - 0.08, h: sourceH,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.caption, italic: true,
      color: PPTX_BRAND.muted, align: "left", valign: "middle", fit: "shrink",
    });
  }

  const notes = overflow ? `${spec.speakerNotes}\n\n${overflow}` : spec.speakerNotes;
  attachSpeakerNotes(slide, notes);
}
