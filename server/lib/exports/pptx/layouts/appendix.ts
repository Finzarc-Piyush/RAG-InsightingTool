/**
 * W-EXP-6 · Appendix layout (premium overhaul).
 *
 * Catch-all for supporting material the executive reader can skim — any
 * combination of a supporting chart, a deeper table, and a body of
 * supplementary text. A solid navy "APPENDIX" chip sits top-right so the
 * reader knows to skip. Unlike the old mutually-exclusive branches, EVERY
 * present slot is rendered, stacked top-to-bottom with the content region
 * split evenly between whichever slots resolve. Tables use the SHARED
 * `renderDataTable` (identical styling to TableSlide); charts go through the
 * SHARED `placeChartOrPlaceholder`. If nothing resolves, a muted empty-state
 * card explains why rather than leaving a blank slide.
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  PPTX_SLIDE,
  PPTX_TYPE,
  addCard,
  attachSpeakerNotes,
  charsPerLine,
  chip,
  renderActionTitle,
  renderDataTable,
} from "../master.js";
import type { PptxPres, PptxSlide, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { ChartLayoutDeps } from "./chartWithInsight.js";
import { placeChartOrPlaceholder } from "./chartWithInsight.js";
import type { TableData, TableLayoutDeps } from "./tableSlide.js";

export type AppendixDeps = ChartLayoutDeps & TableLayoutDeps;

/** One resolved block to lay into the content stack. */
type Block =
  | { kind: "chart"; render: (box: PptxRectShape) => void }
  | { kind: "table"; table: TableData }
  | { kind: "body"; text: string };

export function renderAppendix(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "Appendix" }>,
  deps: AppendixDeps
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  // Solid navy "APPENDIX" chip, top-right — a real badge, not bare text.
  const chipW = 1.18;
  chip(
    slide,
    { x: PPTX_SLIDE.widthIn - PPTX_SLIDE.marginIn - chipW, y: 0.2, w: chipW, h: 0.26 },
    "APPENDIX",
    PPTX_BRAND.surfaceNavy,
    { solid: true, fontSize: PPTX_TYPE.caption }
  );

  const top = renderActionTitle(slide, spec.actionTitle);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h; // 6.98; keep draws above ~6.95.
  const maxBottom = contentBottom - 0.03;

  // Collect whichever slots are present, in reading order: chart → table → body.
  const blocks: Block[] = [];
  if (spec.slots.chartId) {
    const chart = deps.resolveChart(spec.slots.chartId);
    blocks.push({
      kind: "chart",
      render: (box) =>
        placeChartOrPlaceholder(slide, chart, box, { renderChartInto: deps.renderChartInto }),
    });
  }
  if (spec.slots.tableId) {
    const table = deps.resolveTable(spec.slots.tableId);
    if (table) blocks.push({ kind: "table", table });
  }
  const body = spec.slots.body?.trim();
  if (body) blocks.push({ kind: "body", text: body });

  // Empty state — nothing resolved. Don't ship a blank slide.
  if (blocks.length === 0) {
    const box: PptxRectShape = {
      x: CONTENT_BOX.x, y: top + 0.04, w: CONTENT_BOX.w, h: maxBottom - (top + 0.04),
    };
    addCard(slide, box, { fill: PPTX_BRAND.surfaceMuted, shadow: false });
    slide.addText("No supporting material was attached to this appendix slide.", {
      x: box.x, y: box.y, w: box.w, h: box.h,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.lead, color: PPTX_BRAND.muted,
      align: "center", valign: "middle", fit: "shrink",
    });
    attachSpeakerNotes(slide, spec.speakerNotes);
    return;
  }

  // Split the content region vertically between present blocks.
  const gap = 0.18;
  const regionTop = top + 0.04;
  const totalH = maxBottom - regionTop;
  const blockH = (totalH - gap * (blocks.length - 1)) / blocks.length;

  blocks.forEach((block, i) => {
    const box: PptxRectShape = {
      x: CONTENT_BOX.x, y: regionTop + i * (blockH + gap), w: CONTENT_BOX.w, h: blockH,
    };
    if (block.kind === "chart") {
      block.render(box);
    } else if (block.kind === "table") {
      // Cap rows to what fits in the allotted slice; shared renderer formats,
      // zebra-stripes, and prints "Showing N of M" when capped.
      const maxRows = Math.max(4, Math.min(14, Math.floor((box.h - 0.34) / 0.3)));
      renderDataTable(slide, box, block.table, { maxRows, fontSize: PPTX_TYPE.table });
    } else {
      addCard(slide, box, { fill: PPTX_BRAND.surfaceMuted, shadow: false, accent: PPTX_BRAND.accent });
      // Clamp the body to what the block holds so it stays legible (no extreme
      // shrink) and never overruns the card.
      const bw = box.w - 0.54;
      const bLineH = (PPTX_TYPE.bodyTight / 72) * 1.06;
      const bMaxLines = Math.max(1, Math.floor((box.h - 0.24) / Math.max(bLineH, 0.01)));
      const bMaxChars = Math.max(40, bMaxLines * charsPerLine(bw, PPTX_TYPE.bodyTight));
      const bShown = block.text.length > bMaxChars ? `${block.text.slice(0, bMaxChars - 1).trimEnd()}…` : block.text;
      slide.addText(bShown, {
        x: box.x + 0.3, y: box.y + 0.12, w: bw, h: box.h - 0.24,
        fontFace: PPTX_FONT, fontSize: PPTX_TYPE.bodyTight, color: PPTX_BRAND.inkSoft,
        align: "left", valign: "top", lineSpacingMultiple: 1.06, fit: "shrink",
      });
    }
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
