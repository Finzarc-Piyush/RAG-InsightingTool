/**
 * W-EXP-6 · Appendix layout.
 *
 * Catch-all for supporting material the executive reader can skip — a
 * supporting chart, a deeper table, or a body of supplementary text.
 * Explicitly labelled "APPENDIX" in the corner so readers know to skim.
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  PPTX_SLIDE,
  attachSpeakerNotes,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";
import type { ChartLayoutDeps } from "./chartWithInsight.js";
import type { TableLayoutDeps } from "./tableSlide.js";

export type AppendixDeps = ChartLayoutDeps & TableLayoutDeps;

export function renderAppendix(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "Appendix" }>,
  deps: AppendixDeps
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  // Top-right APPENDIX badge
  slide.addText("APPENDIX", {
    x: PPTX_SLIDE.widthIn - 1.5 - PPTX_SLIDE.marginIn,
    y: 0.45,
    w: 1.5,
    h: 0.25,
    fontFace: PPTX_FONT,
    fontSize: 10,
    bold: true,
    color: PPTX_BRAND.muted,
    align: "right",
  });

  renderActionTitle(slide, spec.actionTitle);

  const titleH = 0.75;
  const bodyY = CONTENT_BOX.y + titleH + 0.2;
  const bodyH = CONTENT_BOX.h - titleH - 0.4;
  const bounds: PptxRectShape = {
    x: CONTENT_BOX.x,
    y: bodyY,
    w: CONTENT_BOX.w,
    h: bodyH,
  };

  if (spec.slots.chartId) {
    const chart = deps.resolveChart(spec.slots.chartId);
    if (chart) {
      const ok = deps.renderNative(chart, slide as unknown as { addChart: (...args: unknown[]) => unknown }, bounds);
      if (!ok) {
        const svg = deps.renderSvg(chart, {
          width: Math.round(bounds.w * 200),
          height: Math.round(bounds.h * 200),
        });
        if (svg) {
          const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
          slide.addImage({ ...bounds, data: dataUrl });
        }
      }
    }
  } else if (spec.slots.tableId) {
    const table = deps.resolveTable(spec.slots.tableId);
    if (table) {
      const headerRow = table.columns.map((col) => ({
        text: col,
        options: {
          bold: true,
          color: PPTX_BRAND.background,
          fill: { color: PPTX_BRAND.muted },
          fontSize: 10,
          fontFace: PPTX_FONT,
          align: "left",
        },
      }));
      const bodyRows = table.rows.slice(0, 80).map((row, i) =>
        row.map((cell) => ({
          text: cell == null ? "" : String(cell),
          options: {
            color: PPTX_BRAND.foreground,
            fill: { color: i % 2 === 0 ? PPTX_BRAND.background : "F8FAFC" },
            fontSize: 9,
            fontFace: PPTX_FONT,
            align: typeof cell === "number" ? "right" : "left",
          },
        })),
      );
      slide.addTable([headerRow, ...bodyRows], {
        ...bounds,
        border: { type: "solid", pt: 0.4, color: PPTX_BRAND.border },
        fontFace: PPTX_FONT,
        autoPage: false,
      });
    }
  } else if (spec.slots.body) {
    slide.addText(spec.slots.body, {
      ...bounds,
      fontFace: PPTX_FONT,
      fontSize: 11,
      color: PPTX_BRAND.foreground,
      align: "left",
      valign: "top",
    });
  }

  attachSpeakerNotes(slide, spec.speakerNotes);
}
