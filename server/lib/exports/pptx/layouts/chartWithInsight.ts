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
  addCard, renderActionTitle, attachSpeakerNotes, measureInsightLanes,
} from "../master.js";
import type { PptxPres, PptxSlide, PptxRectShape, PptxTextLine } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { ChartSpec } from "../../../../shared/schema.js";
import { splitChartInsightLanes, type ChartInsightLanes } from "../../../../shared/chartInsightLanes.js";

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
  slide: PptxSlide,
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

// ── So-what callout (shared with TwoChartCompare) ────────────────────────────
const INSIGHT_HEADLINE_PT = PPTX_TYPE.lead; // 16 — the WHAT, prominent
const INSIGHT_LANE_PT = PPTX_TYPE.bodyTight; // 12 — the WHY / DO lanes, quieter
const INSIGHT_X_INSET = 0.32;
const INSIGHT_W_INSET = 0.56;
const INSIGHT_FLOOR_H = 0.62;

/** Join the lanes back into prose for speaker notes (overflow preservation). */
function joinLanesForNotes(lanes: ChartInsightLanes): string {
  const out: string[] = [];
  if (lanes.headline.trim()) out.push(lanes.headline.trim());
  if (lanes.why?.trim()) out.push(`Why: ${lanes.why.trim()}`);
  if (lanes.do?.trim()) out.push(`Do: ${lanes.do.trim()}`);
  return out.join("\n");
}

/**
 * Height (inches) the so-what callout needs for `lanes` at content width `boxW`,
 * clamped to [floor, maxH]. The caller subtracts this from the chart box so the
 * two never collide — the fix for insight text spilling onto the chart.
 */
export function insightCalloutHeight(lanes: ChartInsightLanes, boxW: number, maxH: number): number {
  const textW = boxW - INSIGHT_W_INSET;
  const need =
    measureInsightLanes(lanes, textW, {
      headlinePt: INSIGHT_HEADLINE_PT,
      lanePt: INSIGHT_LANE_PT,
      paraSpaceAfterPt: 4,
    }) + 0.2;
  return Math.min(Math.max(need, INSIGHT_FLOOR_H), maxH);
}

/**
 * Render the gold-railed so-what callout into `box`. Sizes the lanes per-lane
 * (headline prominent, WHY/DO quieter) and TOP-aligns so any residual overflow
 * is downward + clipped inside the box, never up onto the chart. Returns the full
 * lane text to append to speaker notes when the box was too small to hold it all
 * (so nothing is lost), or "" when everything fit.
 */
export function renderInsightCallout(slide: PptxSlide, lanes: ChartInsightLanes, box: PptxRectShape): string {
  addCard(slide, box, { fill: PPTX_BRAND.surfaceMuted, accent: PPTX_BRAND.accent, shadow: false });

  const textW = box.w - INSIGHT_W_INSET;
  const need =
    measureInsightLanes(lanes, textW, {
      headlinePt: INSIGHT_HEADLINE_PT,
      lanePt: INSIGHT_LANE_PT,
      paraSpaceAfterPt: 4,
    }) + 0.2;

  const runs: PptxTextLine[] = [];
  if (lanes.headline.trim()) {
    runs.push({
      text: lanes.headline.trim(),
      options: { fontSize: INSIGHT_HEADLINE_PT, bold: true, color: PPTX_BRAND.foreground, breakLine: true, paraSpaceAfter: 4 },
    });
  }
  if (lanes.why?.trim()) {
    runs.push({
      text: `Why: ${lanes.why.trim()}`,
      options: { fontSize: INSIGHT_LANE_PT, color: PPTX_BRAND.inkSoft, breakLine: true, paraSpaceAfter: 3 },
    });
  }
  if (lanes.do?.trim()) {
    runs.push({
      text: `Do: ${lanes.do.trim()}`,
      options: { fontSize: INSIGHT_LANE_PT, color: PPTX_BRAND.foreground, breakLine: true },
    });
  }
  if (runs.length === 0) return "";

  slide.addText(runs, {
    x: box.x + INSIGHT_X_INSET, y: box.y + 0.08, w: textW, h: box.h - 0.16,
    fontFace: PPTX_FONT, align: "left", valign: "top", lineSpacingMultiple: 1.05, fit: "shrink",
  });

  // Belt-and-braces: with a ≤400-char insight the capped box is always large
  // enough, so this rarely fires; if a caller ever passes more text than the box
  // can hold, preserve the full lane text in the speaker notes.
  return need > box.h + 0.02 ? joinLanesForNotes(lanes) : "";
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
  const chartTop = top + 0.02;

  const sourceH = spec.slots.source ? 0.3 : 0;
  const gap = 0.16;

  // Size the so-what callout to its content (capped at 40% of the content band so
  // the chart always keeps ≥60%), then give the chart the remainder. With the
  // callout's TRUE height reserved, the insight can never overlap the chart or run
  // off the slide.
  const lanes = splitChartInsightLanes(spec.slots.insight);
  const band = contentBottom - chartTop;
  const maxInsightH = band * 0.4;
  const insightH = insightCalloutHeight(lanes, CONTENT_BOX.w, maxInsightH);

  const chartBox: PptxRectShape = {
    x: CONTENT_BOX.x, y: chartTop, w: CONTENT_BOX.w,
    h: band - insightH - sourceH - gap * 2,
  };
  placeChartOrPlaceholder(slide, deps.resolveChart(spec.slots.chartId), chartBox, deps);

  const insightY = chartBox.y + chartBox.h + gap;
  const overflow = renderInsightCallout(slide, lanes, {
    x: CONTENT_BOX.x, y: insightY, w: CONTENT_BOX.w, h: insightH,
  });

  if (spec.slots.source) {
    slide.addText(spec.slots.source, {
      x: CONTENT_BOX.x, y: insightY + insightH + 0.04, w: CONTENT_BOX.w, h: sourceH - 0.04,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.caption, italic: true,
      color: PPTX_BRAND.muted, align: "left", valign: "middle",
    });
  }

  const notes = overflow ? `${spec.speakerNotes}\n\n${overflow}` : spec.speakerNotes;
  attachSpeakerNotes(slide, notes);
}
