/**
 * W-EXP-6 · TwoChartCompare layout.
 *
 * Two charts side-by-side under a shared action title, with a one-sentence
 * insight beneath both. Reserved for genuine comparisons (before/after,
 * trend + decomposition) — never just to fit two charts on one slide; the
 * deck-planner system prompt says so explicitly.
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
import type { ChartLayoutDeps } from "./chartWithInsight.js";

export function renderTwoChartCompare(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "TwoChartCompare" }>,
  deps: ChartLayoutDeps
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const titleH = 0.7;
  const insightH = 0.9;
  const gutter = 0.3;
  const totalChartH = CONTENT_BOX.h - titleH - insightH - 0.3;
  const chartW = (CONTENT_BOX.w - gutter) / 2;

  const leftBox: PptxRectShape = {
    x: CONTENT_BOX.x,
    y: CONTENT_BOX.y + titleH + 0.2,
    w: chartW,
    h: totalChartH,
  };
  const rightBox: PptxRectShape = {
    ...leftBox,
    x: CONTENT_BOX.x + chartW + gutter,
  };

  for (const [chartId, box] of [
    [spec.slots.leftChartId, leftBox] as const,
    [spec.slots.rightChartId, rightBox] as const,
  ]) {
    const chart = deps.resolveChart(chartId);
    if (!chart) {
      slide.addShape("rect", {
        ...box,
        fill: { color: "F8FAFC" },
        line: { color: PPTX_BRAND.border, width: 0.5 },
      });
      slide.addText("Chart unavailable.", {
        ...box,
        fontFace: PPTX_FONT,
        fontSize: 12,
        color: PPTX_BRAND.muted,
        align: "center",
        valign: "middle",
      });
      continue;
    }
    const ok = deps.renderNative(chart, slide as unknown as { addChart: (...args: unknown[]) => unknown }, box);
    if (!ok) {
      const svg = deps.renderSvg(chart, {
        width: Math.round(box.w * 200),
        height: Math.round(box.h * 200),
      });
      if (svg) {
        const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
        slide.addImage({ ...box, data: dataUrl });
      }
    }
  }

  slide.addText(spec.slots.insight, {
    x: CONTENT_BOX.x,
    y: leftBox.y + leftBox.h + 0.15,
    w: CONTENT_BOX.w,
    h: insightH - 0.2,
    fontFace: PPTX_FONT,
    fontSize: 16,
    color: PPTX_BRAND.foreground,
    align: "left",
    valign: "top",
  });

  if (spec.slots.source) {
    slide.addText(spec.slots.source, {
      x: CONTENT_BOX.x,
      y: leftBox.y + leftBox.h + 0.85,
      w: CONTENT_BOX.w,
      h: 0.3,
      fontFace: PPTX_FONT,
      fontSize: 10,
      italic: true,
      color: PPTX_BRAND.muted,
      align: "left",
    });
  }

  attachSpeakerNotes(slide, spec.speakerNotes);
}
