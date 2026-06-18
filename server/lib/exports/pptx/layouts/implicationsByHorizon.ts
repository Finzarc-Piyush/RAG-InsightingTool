/**
 * ImplicationsByHorizon layout.
 *
 * Three equal COLUMN CARDS under a shared action title — Now / This quarter /
 * Strategic — each a soft surface card with a coloured header (solid horizon
 * chip + count) and 0–4 bullets beneath. The horizon colour carries through to
 * the bullet glyphs (`bulletColor`) so the colour is hierarchical, not just a
 * header strip. Empty columns render a centred muted "—". Up to 4 entries per
 * column is the verifier's cap (W-EXP-3).
 */
import {
  CONTENT_BOX,
  HORIZON,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  PPTX_TYPE,
  addCard,
  attachSpeakerNotes,
  bulletList,
  chip,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxSlide, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

/** One horizon column: header chip colour/label + its (≤4) implication bullets. */
interface HorizonColumn {
  label: string;
  color: string;
  bullets: string[];
}

/** Render a single column card: surfaceMuted panel, horizon chip + count, bullets. */
function renderColumn(slide: PptxSlide, col: HorizonColumn, box: PptxRectShape): void {
  // Container — soft card with a left rail in the horizon colour.
  addCard(slide, box, {
    fill: PPTX_BRAND.surfaceMuted,
    accent: col.color,
    shadow: true,
  });

  const pad = 0.22;
  const innerX = box.x + pad;
  const innerW = box.w - pad * 2;

  // Header — solid horizon chip on the left + a muted count on the right.
  const headerY = box.y + 0.2;
  const headerH = 0.36;
  const countW = 0.7;
  chip(
    slide,
    { x: innerX, y: headerY, w: innerW - countW, h: headerH },
    col.label,
    col.color,
    { solid: true, fontSize: PPTX_TYPE.chip, align: "center" }
  );
  slide.addText(String(col.bullets.length), {
    x: innerX + innerW - countW, y: headerY, w: countW, h: headerH,
    fontFace: PPTX_FONT, fontSize: PPTX_TYPE.kpiLabel, bold: true,
    color: col.color, align: "right", valign: "middle", fit: "shrink",
  });

  // Body — bullets carry the horizon colour, or a centred muted em-dash.
  const bodyY = headerY + headerH + 0.18;
  const bodyH = box.y + box.h - bodyY - 0.18;
  if (col.bullets.length > 0) {
    bulletList(
      slide,
      col.bullets,
      { x: innerX, y: bodyY, w: innerW, h: bodyH },
      {
        bulletColor: col.color,
        color: PPTX_BRAND.foreground,
        fontSize: PPTX_TYPE.bodyTight,
        gap: 8,
      }
    );
  } else {
    slide.addText("—", {
      x: innerX, y: bodyY, w: innerW, h: bodyH,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.lead,
      color: PPTX_BRAND.muted, align: "center", valign: "middle",
    });
  }
}

export function renderImplicationsByHorizon(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "ImplicationsByHorizon" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h; // 6.98 — keep cards ≤ ~6.9.

  const gutter = 0.3;
  const colW = (CONTENT_BOX.w - 2 * gutter) / 3;
  const colY = top + 0.06;
  const colBottom = Math.min(contentBottom - 0.08, 6.9);
  const colH = colBottom - colY;

  const columns: HorizonColumn[] = [
    { label: HORIZON.now.label, color: HORIZON.now.color, bullets: spec.slots.now },
    { label: HORIZON.thisQuarter.label, color: HORIZON.thisQuarter.color, bullets: spec.slots.thisQuarter },
    { label: HORIZON.strategic.label, color: HORIZON.strategic.color, bullets: spec.slots.strategic },
  ];

  columns.forEach((col, i) => {
    const x = CONTENT_BOX.x + i * (colW + gutter);
    renderColumn(slide, col, { x, y: colY, w: colW, h: colH });
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
