/**
 * W-EXP-5 · TableSlide layout.
 *
 * Native pptxgenjs `addTable` only — tables-as-image are forbidden by the
 * deck verifier (W-EXP-3) precisely because that's the second amateur
 * tell (the first being raster charts). Native tables let recipients
 * copy values into Excel, recolour rows, and resize columns.
 *
 * Resolves `tableRef` against an optional callback (similar to ChartWithInsight's
 * chartId resolver). Inline tables are rendered as-is.
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  attachSpeakerNotes,
  renderActionTitle,
} from "../master.js";
import type { PptxPres } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

export interface TableData {
  caption?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface TableIdResolver {
  /** Returns null when the id doesn't correspond to a table in the dashboard. */
  (tableId: string): TableData | null;
}

export interface TableLayoutDeps {
  resolveTable: TableIdResolver;
}

export function renderTableSlide(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "TableSlide" }>,
  deps: TableLayoutDeps
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const ref = spec.slots.tableRef;
  let table: TableData | null = null;
  if (ref.kind === "ref") {
    table = deps.resolveTable(ref.tableId);
  } else {
    table = {
      caption: spec.slots.caption,
      columns: ref.columns,
      rows: ref.rows,
    };
  }

  const insightH = spec.slots.insight ? 0.6 : 0;
  const tableY = CONTENT_BOX.y + 0.85 + insightH;
  const tableH = CONTENT_BOX.h - 0.85 - insightH - 0.2;

  // Optional one-sentence takeaway above the table
  if (spec.slots.insight) {
    slide.addText(spec.slots.insight, {
      x: CONTENT_BOX.x,
      y: CONTENT_BOX.y + 0.8,
      w: CONTENT_BOX.w,
      h: insightH,
      fontFace: PPTX_FONT,
      fontSize: 14,
      color: PPTX_BRAND.muted,
      italic: true,
      align: "left",
      valign: "top",
    });
  }

  if (!table) {
    slide.addShape("rect", {
      x: CONTENT_BOX.x,
      y: tableY,
      w: CONTENT_BOX.w,
      h: tableH,
      fill: { color: "F8FAFC" },
      line: { color: PPTX_BRAND.border },
    });
    slide.addText("Table unavailable for this slide.", {
      x: CONTENT_BOX.x,
      y: tableY,
      w: CONTENT_BOX.w,
      h: tableH,
      fontFace: PPTX_FONT,
      fontSize: 14,
      color: PPTX_BRAND.muted,
      align: "center",
      valign: "middle",
    });
    attachSpeakerNotes(slide, spec.speakerNotes);
    return;
  }

  // Header row
  const headerRow = table.columns.map((col) => ({
    text: col,
    options: {
      bold: true,
      color: PPTX_BRAND.background,
      fill: { color: PPTX_BRAND.primary },
      align: "left",
      fontSize: 11,
      fontFace: PPTX_FONT,
    },
  }));
  // Body rows — alternate zebra fills for legibility
  const bodyRows = table.rows.slice(0, 60).map((row, i) =>
    row.map((cell) => ({
      text: cell == null ? "" : String(cell),
      options: {
        color: PPTX_BRAND.foreground,
        fill: { color: i % 2 === 0 ? PPTX_BRAND.background : "F8FAFC" },
        align: typeof cell === "number" ? "right" : "left",
        fontSize: 10,
        fontFace: PPTX_FONT,
      },
    })),
  );

  slide.addTable([headerRow, ...bodyRows], {
    x: CONTENT_BOX.x,
    y: tableY,
    w: CONTENT_BOX.w,
    h: Math.min(tableH, 0.35 + table.rows.length * 0.28),
    border: { type: "solid", pt: 0.5, color: PPTX_BRAND.border },
    fontFace: PPTX_FONT,
    autoPage: false,
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
