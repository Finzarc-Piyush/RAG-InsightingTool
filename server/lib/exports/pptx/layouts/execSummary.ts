/**
 * W-EXP-5 · ExecSummary layout.
 *
 * Slide #2 by convention. Action title at the top, then 3–6 takeaway
 * bullets (each a complete sentence with its own number where possible).
 * Reading just this slide must convey the whole answer — Pyramid Principle.
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

export function renderExecSummary(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "ExecSummary" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const bulletY = CONTENT_BOX.y + 1.0;
  const bulletH = CONTENT_BOX.h - 1.1;

  const lines: PptxTextLine[] = spec.slots.bullets.map((b) => ({
    text: b,
    options: {
      bullet: { type: "bullet", code: "25CF" }, // ● filled disc
      paraSpaceAfter: 14,
      fontSize: 18,
      color: PPTX_BRAND.foreground,
    },
  }));

  slide.addText(lines, {
    x: CONTENT_BOX.x + 0.2,
    y: bulletY,
    w: CONTENT_BOX.w - 0.2,
    h: bulletH,
    fontFace: PPTX_FONT,
    valign: "top",
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
