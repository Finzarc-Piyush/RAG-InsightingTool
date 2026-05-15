/**
 * W-EXP-6 · Methodology layout.
 *
 * Body prose + caveats list. Small font, end-of-deck styling. The verifier
 * (W-EXP-3) enforces back-third placement so this slide doesn't surface
 * before the reader has the substance.
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

export function renderMethodology(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "Methodology" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const titleH = 0.7;
  const caveats = spec.slots.caveats ?? [];
  const caveatsH = caveats.length > 0 ? Math.min(2.0, 0.5 + caveats.length * 0.3) : 0;
  const bodyH = CONTENT_BOX.h - titleH - caveatsH - 0.4;

  // Body prose (small font, justified-ish via fontSize 12 for compact density)
  slide.addText(spec.slots.body, {
    x: CONTENT_BOX.x,
    y: CONTENT_BOX.y + titleH + 0.15,
    w: CONTENT_BOX.w,
    h: bodyH,
    fontFace: PPTX_FONT,
    fontSize: 12,
    color: PPTX_BRAND.foreground,
    align: "left",
    valign: "top",
    paraSpaceAfter: 8,
  });

  // Caveats — small, muted, bullet-prefixed
  if (caveats.length > 0) {
    slide.addText("Caveats", {
      x: CONTENT_BOX.x,
      y: CONTENT_BOX.y + titleH + 0.15 + bodyH + 0.05,
      w: CONTENT_BOX.w,
      h: 0.3,
      fontFace: PPTX_FONT,
      fontSize: 11,
      bold: true,
      color: PPTX_BRAND.muted,
    });
    const lines: PptxTextLine[] = caveats.map((c) => ({
      text: c,
      options: {
        bullet: { type: "bullet", code: "25CB" }, // ○ open circle for less-emphatic list
        paraSpaceAfter: 4,
        fontSize: 10,
        color: PPTX_BRAND.muted,
      },
    }));
    slide.addText(lines, {
      x: CONTENT_BOX.x + 0.2,
      y: CONTENT_BOX.y + titleH + 0.15 + bodyH + 0.4,
      w: CONTENT_BOX.w - 0.2,
      h: caveatsH - 0.4,
      fontFace: PPTX_FONT,
      valign: "top",
    });
  }

  attachSpeakerNotes(slide, spec.speakerNotes);
}
