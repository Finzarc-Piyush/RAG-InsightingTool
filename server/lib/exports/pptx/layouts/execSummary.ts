/**
 * ExecSummary layout — slide #2 by convention.
 *
 * Reading just this slide must convey the whole answer (Pyramid Principle).
 * Instead of an 18pt bulleted wall of text, each takeaway is its OWN slim card
 * row stacked vertically: a navy NUMBER badge on the left, the sentence to its
 * right (ink, valign-middle, shrink-to-fit). The lead takeaway gets a gold left
 * rail + bold text so the eye lands on it first. Row height is derived from the
 * count so 3 generous rows or 6 compact rows both fit between the action title
 * and the footer line — scannable and hierarchical, never a paragraph blob.
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  PPTX_TYPE,
  addCard,
  attachSpeakerNotes,
  charsPerLine,
  chip,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxRectShape } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

export function renderExecSummary(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "ExecSummary" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h; // 6.98
  const floor = Math.min(contentBottom, 6.9); // never draw past the footer

  // Schema guarantees 3–6 items; clamp defensively anyway.
  const bullets = spec.slots.bullets.slice(0, 6);
  const n = Math.max(1, bullets.length);

  // Distribute the vertical band into n rows + (n-1) gaps. Tighter gaps when
  // there are more rows so 6 compact rows still breathe.
  const bandY = top + 0.06;
  const bandH = floor - bandY;
  const gap = n <= 3 ? 0.2 : n <= 4 ? 0.16 : 0.12;
  const rowH = (bandH - gap * (n - 1)) / n;

  // Badge + text metrics scale gently with density.
  const badge = Math.min(0.62, rowH * 0.62); // square-ish number chip
  const badgeFont =
    rowH >= 1.2 ? PPTX_TYPE.kpiLabel : rowH >= 0.95 ? PPTX_TYPE.chip : PPTX_TYPE.caption;
  const textFont = n <= 3 ? PPTX_TYPE.lead : n <= 4 ? PPTX_TYPE.body : PPTX_TYPE.bodyTight;
  const railPad = 0.14; // clears the addCard accent rail (~0.07 wide at x+0)
  const badgeX = CONTENT_BOX.x + 0.22;
  const textX = badgeX + badge + 0.26;
  const textW = CONTENT_BOX.x + CONTENT_BOX.w - textX - 0.24;

  bullets.forEach((text, i) => {
    const lead = i === 0;
    const rowY = bandY + i * (rowH + gap);
    const box: PptxRectShape = { x: CONTENT_BOX.x, y: rowY, w: CONTENT_BOX.w, h: rowH };

    // Slim row card — subtle fill, no shadow; lead row carries a gold rail.
    addCard(slide, box, {
      fill: lead ? PPTX_BRAND.surfaceWarm : PPTX_BRAND.surfaceMuted,
      shadow: false,
      accent: lead ? PPTX_BRAND.accent : undefined,
    });

    // Navy number badge, vertically centred in the row.
    const badgeY = rowY + (rowH - badge) / 2;
    chip(
      slide,
      { x: badgeX + railPad, y: badgeY, w: badge, h: badge },
      String(i + 1),
      PPTX_BRAND.primary,
      { solid: true, fontSize: badgeFont, align: "center", bold: true }
    );

    // Takeaway sentence — clamped to what the row holds so it can't spill onto
    // the neighbouring card, then middle-aligned (clamp guarantees it fits).
    const tLineH = (textFont / 72) * 1.02;
    const tMaxLines = Math.max(1, Math.floor(rowH / Math.max(tLineH, 0.01)));
    const tMaxChars = Math.max(8, tMaxLines * charsPerLine(textW - railPad, textFont));
    const t = (text ?? "").trim();
    const shownText = t.length > tMaxChars ? `${t.slice(0, tMaxChars - 1).trimEnd()}…` : t;
    slide.addText(shownText, {
      x: textX + railPad, y: rowY, w: textW - railPad, h: rowH,
      fontFace: PPTX_FONT, fontSize: textFont,
      bold: lead,
      color: PPTX_BRAND.foreground,
      align: "left", valign: "middle",
      lineSpacingMultiple: 1.02, fit: "shrink",
    });
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
