/**
 * W-EXP-6 · ImplicationsByHorizon layout.
 *
 * Three columns under a shared action title — Now / This quarter /
 * Strategic. Each column has a coloured header pill matching the master's
 * horizon palette (red for now, amber for this_quarter, green for
 * strategic) and 0–4 bullets beneath. Up to 4 entries per column is the
 * verifier's cap (W-EXP-3).
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  attachSpeakerNotes,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxTextLine } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

export function renderImplicationsByHorizon(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "ImplicationsByHorizon" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const titleH = 0.8;
  const gutter = 0.3;
  const colW = (CONTENT_BOX.w - 2 * gutter) / 3;
  const colY = CONTENT_BOX.y + titleH + 0.2;
  const colH = CONTENT_BOX.h - titleH - 0.4;
  const headerH = 0.45;

  const columns: Array<{
    label: string;
    color: string;
    bullets: string[];
  }> = [
    { label: "Now", color: PPTX_BRAND.horizonNow, bullets: spec.slots.now },
    { label: "This quarter", color: PPTX_BRAND.horizonThisQuarter, bullets: spec.slots.thisQuarter },
    { label: "Strategic", color: PPTX_BRAND.horizonStrategic, bullets: spec.slots.strategic },
  ];

  columns.forEach((col, i) => {
    const x = CONTENT_BOX.x + i * (colW + gutter);
    // Header pill
    slide.addShape("rect", {
      x,
      y: colY,
      w: colW,
      h: headerH,
      fill: { color: col.color },
      line: { color: col.color },
    });
    slide.addText(col.label, {
      x,
      y: colY,
      w: colW,
      h: headerH,
      fontFace: PPTX_FONT,
      fontSize: 14,
      bold: true,
      color: PPTX_BRAND.background,
      align: "center",
      valign: "middle",
    });
    // Bullets
    if (col.bullets.length > 0) {
      const lines: PptxTextLine[] = col.bullets.map((b) => ({
        text: b,
        options: {
          bullet: { type: "bullet", code: "25CF" },
          paraSpaceAfter: 8,
          fontSize: 12,
          color: PPTX_BRAND.foreground,
        },
      }));
      slide.addText(lines, {
        x: x + 0.1,
        y: colY + headerH + 0.18,
        w: colW - 0.2,
        h: colH - headerH - 0.2,
        fontFace: PPTX_FONT,
        valign: "top",
      });
    } else {
      slide.addText("—", {
        x,
        y: colY + headerH + 0.2,
        w: colW,
        h: 0.5,
        fontFace: PPTX_FONT,
        fontSize: 12,
        color: PPTX_BRAND.muted,
        align: "center",
      });
    }
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
