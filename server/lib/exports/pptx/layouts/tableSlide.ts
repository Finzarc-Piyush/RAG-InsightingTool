/**
 * TableSlide layout — a native data table as the hero.
 *
 * Premium-export overhaul: this file no longer hand-rolls a header band, zebra
 * fills, or column widths. It COMPOSES the shared `renderDataTable` primitive
 * (one table styling across TableSlide + Appendix — number formatting,
 * right-aligned numerics, zebra rows, "Showing N of M") and frames it the same
 * way every other layout frames content: action title → optional lead insight →
 * muted caption label → the table. Tables-as-image stay forbidden (the verifier's
 * second amateur tell) — `renderDataTable` emits a native pptxgenjs table so
 * recipients can copy values into Excel.
 *
 * Resolves `tableRef`: kind 'ref' → `deps.resolveTable(tableId)`; kind 'inline'
 * → the columns/rows carried on the ref. A missing table falls back to a muted
 * "Table unavailable" empty-state card.
 */
import {
  CONTENT_BOX, MASTER_NAME, PPTX_BRAND, PPTX_FONT, PPTX_TYPE,
  addCard, eyebrow, estimateTextHeight, renderActionTitle, renderDataTable, attachSpeakerNotes,
} from "../master.js";
import type { PptxPres, PptxSlide, PptxRectShape } from "../types.js";
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

/** Muted, centred empty-state card when the referenced table can't be resolved. */
function placeUnavailable(slide: PptxSlide, box: PptxRectShape): void {
  addCard(slide, box, { fill: PPTX_BRAND.surfaceMuted, shadow: false });
  slide.addText("Table unavailable for this slide.", {
    x: box.x, y: box.y, w: box.w, h: box.h,
    fontFace: PPTX_FONT, fontSize: 14, color: PPTX_BRAND.muted,
    align: "center", valign: "middle",
  });
}

export function renderTableSlide(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "TableSlide" }>,
  deps: TableLayoutDeps
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h; // 6.98 — never draw past ~6.95

  // Resolve the table: ref → resolver; inline → the columns/rows on the ref.
  const ref = spec.slots.tableRef;
  const table: TableData | null =
    ref.kind === "ref"
      ? deps.resolveTable(ref.tableId)
      : { caption: spec.slots.caption, columns: ref.columns, rows: ref.rows };

  let y = top;

  // Optional lead insight (the "so-what") under the title — sized to its text so
  // a 2-line insight doesn't crush to an unreadable size or shove the table off.
  if (spec.slots.insight) {
    const insightH = Math.min(1.0, Math.max(0.4, estimateTextHeight(spec.slots.insight, CONTENT_BOX.w, PPTX_TYPE.lead)));
    slide.addText(spec.slots.insight, {
      x: CONTENT_BOX.x, y, w: CONTENT_BOX.w, h: insightH,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.lead, color: PPTX_BRAND.foreground,
      align: "left", valign: "top", lineSpacingMultiple: 1.04, fit: "shrink",
    });
    y += insightH + 0.1;
  }

  // Small muted caption label above the table (slot caption, else table's own).
  const caption = spec.slots.caption ?? table?.caption;
  if (caption) {
    eyebrow(slide, { x: CONTENT_BOX.x, y, w: CONTENT_BOX.w, h: 0.22 }, caption, {
      color: PPTX_BRAND.muted,
    });
    y += 0.3;
  }

  const tableBox: PptxRectShape = {
    x: CONTENT_BOX.x,
    y: y + 0.02,
    w: CONTENT_BOX.w,
    h: Math.max(0.6, contentBottom - (y + 0.02)),
  };

  if (!table || table.columns.length === 0) {
    placeUnavailable(slide, tableBox);
    attachSpeakerNotes(slide, spec.speakerNotes);
    return;
  }

  // Delegate the whole table to the shared renderer — header band, zebra,
  // number formatting, right-aligned numerics, and "Showing N of M".
  renderDataTable(slide, tableBox, { columns: table.columns, rows: table.rows }, {
    maxRows: 12,
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
