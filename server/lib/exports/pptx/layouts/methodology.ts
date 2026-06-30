/**
 * W-EXP-6 · Methodology layout (premium overhaul).
 *
 * Back-of-deck, but readable: the `body` prose is split into paragraphs (on
 * blank lines, else into sentence groups) and rendered in the LEFT ~62% of the
 * content width with comfortable spacing; any `caveats` sit in a soft card on
 * the RIGHT ~34% under a muted "CAVEATS" eyebrow + a bulletList. With no
 * caveats the body uses the full width. Composes the master primitives only —
 * no bespoke rectangles or colour decisions. The verifier (W-EXP-3) enforces
 * back-third placement so this slide doesn't surface before the substance.
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  PPTX_TYPE,
  addCard,
  attachSpeakerNotes,
  bulletList,
  charsPerLine,
  eyebrow,
  renderActionTitle,
} from "../master.js";
import type { PptxPres, PptxSlide, PptxRectShape, PptxTextLine } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

/**
 * Split prose into display paragraphs: prefer author-supplied blank-line
 * breaks; if there are none, group sentences (~2 per paragraph) so a wall of
 * text gains breathing room without re-flowing the author's intent.
 */
function splitParagraphs(body: string): string[] {
  const byBlank = body
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  if (byBlank.length > 1) return byBlank;

  // No blank lines → group sentences into pairs for readable chunks.
  const flat = (byBlank[0] ?? body).replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g);
  if (!sentences || sentences.length <= 1) return flat.length > 0 ? [flat] : [];

  const groups: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const a = sentences[i] ?? "";
    const b = sentences[i + 1] ?? "";
    const para = `${a}${b}`.trim();
    if (para.length > 0) groups.push(para);
  }
  return groups;
}

/** Render the body paragraphs as one autofitting text block with para spacing. */
function renderBody(slide: PptxSlide, paragraphs: string[], box: PptxRectShape): void {
  if (box.h <= 0 || paragraphs.length === 0) return;
  const runs: PptxTextLine[] = paragraphs.map((p, i) => ({
    text: p,
    options: {
      fontSize: PPTX_TYPE.bodyTight,
      color: PPTX_BRAND.inkSoft,
      breakLine: true,
      paraSpaceAfter: i === paragraphs.length - 1 ? 0 : 9,
    },
  }));
  slide.addText(runs, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fontFace: PPTX_FONT,
    align: "left",
    valign: "top",
    lineSpacingMultiple: 1.15,
    fit: "shrink",
  });
}

export function renderMethodology(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "Methodology" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle, { kicker: "Methodology" });

  // Hard floor: never draw past ~6.9in (footer hairline lives at ~7.08).
  const contentBottom = Math.min(CONTENT_BOX.y + CONTENT_BOX.h, 6.9);
  const bodyTop = top + 0.04;
  const colH = Math.max(0, contentBottom - bodyTop);

  const caveats = (spec.slots.caveats ?? []).filter((c) => c.trim().length > 0);
  const hasCaveats = caveats.length > 0;

  // The body can be up to 3500 chars; clamp it to what the column legibly holds
  // (so fit:"shrink" never crushes it to an unreadable size) and preserve the
  // full text in the speaker notes.
  const bodyW = hasCaveats ? CONTENT_BOX.w * 0.62 : CONTENT_BOX.w;
  const bodyLineH = (PPTX_TYPE.bodyTight / 72) * 1.15;
  const bodyMaxLines = Math.max(1, Math.floor(colH / Math.max(bodyLineH, 0.01)));
  const bodyBudget = Math.max(40, Math.floor(bodyMaxLines * charsPerLine(bodyW, PPTX_TYPE.bodyTight) * 0.92));
  const rawBody = spec.slots.body.trim();
  const bodyTruncated = rawBody.length > bodyBudget;
  const bodyText = bodyTruncated ? `${rawBody.slice(0, bodyBudget - 1).trimEnd()}…` : rawBody;
  const paragraphs = splitParagraphs(bodyText);

  if (hasCaveats) {
    // Two columns: body ~62% left, caveats card ~34% right, ~4% gutter.
    const gutter = CONTENT_BOX.w * 0.04;
    const cardW = CONTENT_BOX.w - bodyW - gutter;
    const cardX = CONTENT_BOX.x + bodyW + gutter;

    renderBody(slide, paragraphs, {
      x: CONTENT_BOX.x,
      y: bodyTop,
      w: bodyW,
      h: colH,
    });

    // Caveats card — soft surface, muted eyebrow, open-glyph bullet list.
    addCard(
      slide,
      { x: cardX, y: bodyTop, w: cardW, h: colH },
      { fill: PPTX_BRAND.surfaceMuted, shadow: false, accent: PPTX_BRAND.muted }
    );
    const pad = 0.22;
    eyebrow(
      slide,
      { x: cardX + pad, y: bodyTop + pad, w: cardW - pad * 2, h: 0.24 },
      "Caveats",
      { color: PPTX_BRAND.muted }
    );
    const listY = bodyTop + pad + 0.34;
    bulletList(
      slide,
      caveats,
      { x: cardX + pad, y: listY, w: cardW - pad * 2, h: Math.max(0, colH - (listY - bodyTop) - pad) },
      {
        fontSize: PPTX_TYPE.caption,
        color: PPTX_BRAND.muted,
        bulletColor: PPTX_BRAND.muted,
        gap: 6,
      }
    );
  } else {
    // No caveats → body uses the full content width.
    renderBody(slide, paragraphs, {
      x: CONTENT_BOX.x,
      y: bodyTop,
      w: bodyW,
      h: colH,
    });
  }

  const notes = bodyTruncated ? `${spec.speakerNotes}\n\nFull methodology:\n${rawBody}` : spec.speakerNotes;
  attachSpeakerNotes(slide, notes);
}
