/**
 * TitleSlide layout — the cover.
 *
 * A deep-navy brand panel on the left (wordmark + gold mark + cover meta) and
 * the deck title set large on a warm-white field to the right, anchored by a
 * gold accent rule. The split gives the deck immediate "character" without a
 * logo asset — the navy/gold lockup carries the identity.
 */
import {
  PPTX_BRAND, PPTX_FONT, PPTX_SLIDE, PPTX_TYPE, attachSpeakerNotes, tint,
} from "../master.js";
import type { PptxPres } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

interface TitleSlideContext {
  deckTitle: string;
  deckSubtitle?: string;
  generatedAt: string;
  confidentiality: string;
  preparedFor?: string;
}

const PANEL_W = 4.7;
const lightOnNavy = tint(PPTX_BRAND.primary, 0.78); // soft slate for meta on navy

export function renderTitleSlide(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "TitleSlide" }>,
  ctx: TitleSlideContext
): void {
  const slide = pres.addSlide();
  slide.background = { color: PPTX_BRAND.surfaceWarm };

  // ── Left brand panel (navy) ──────────────────────────────────────────────
  slide.addShape("rect", {
    x: 0, y: 0, w: PANEL_W, h: PPTX_SLIDE.heightIn,
    fill: { color: PPTX_BRAND.surfaceNavy }, line: { color: PPTX_BRAND.surfaceNavy },
  });
  // Thin gold seam down the panel edge.
  slide.addShape("rect", {
    x: PANEL_W, y: 0, w: 0.05, h: PPTX_SLIDE.heightIn,
    fill: { color: PPTX_BRAND.accent }, line: { color: PPTX_BRAND.accent },
  });

  // Wordmark — gold square + brand line.
  slide.addShape("rect", { x: 0.62, y: 0.74, w: 0.2, h: 0.2, fill: { color: PPTX_BRAND.accent }, line: { color: PPTX_BRAND.accent } });
  slide.addText("MARICO", {
    x: 0.94, y: 0.7, w: PANEL_W - 1.1, h: 0.3,
    fontFace: PPTX_FONT, fontSize: 14, bold: true, color: "FFFFFF", charSpacing: 2, align: "left", valign: "middle",
  });
  slide.addText("INSIGHTING TOOL", {
    x: 0.94, y: 1.0, w: PANEL_W - 1.1, h: 0.26,
    fontFace: PPTX_FONT, fontSize: 9.5, bold: true, color: PPTX_BRAND.accent, charSpacing: 2.4, align: "left", valign: "middle",
  });

  // Cover meta — bottom of the panel.
  const metaLines: { text: string; options: Record<string, unknown> }[] = [];
  const preparedFor = spec.slots.preparedFor ?? ctx.preparedFor;
  if (preparedFor) {
    metaLines.push({ text: "PREPARED FOR\n", options: { fontSize: 8.5, bold: true, color: PPTX_BRAND.accent, charSpacing: 1.5, breakLine: true } });
    metaLines.push({ text: `${preparedFor}\n`, options: { fontSize: 12, color: "FFFFFF", breakLine: true, paraSpaceAfter: 10 } });
  }
  metaLines.push({ text: "GENERATED\n", options: { fontSize: 8.5, bold: true, color: PPTX_BRAND.accent, charSpacing: 1.5, breakLine: true } });
  metaLines.push({ text: `${ctx.generatedAt}     ·     ${spec.slots.confidentiality ?? ctx.confidentiality}`, options: { fontSize: 12, color: lightOnNavy, breakLine: true } });
  slide.addText(metaLines, {
    x: 0.62, y: PPTX_SLIDE.heightIn - 2.0, w: PANEL_W - 1.0, h: 1.6,
    fontFace: PPTX_FONT, align: "left", valign: "bottom", lineSpacingMultiple: 1.1,
  });

  // ── Right content field ──────────────────────────────────────────────────
  const cx = PANEL_W + 0.65;
  const cw = PPTX_SLIDE.widthIn - cx - 0.6;

  slide.addText("ANALYTICAL REVIEW", {
    x: cx, y: 2.35, w: cw, h: 0.3,
    fontFace: PPTX_FONT, fontSize: PPTX_TYPE.kicker, bold: true, color: PPTX_BRAND.accent, charSpacing: 2, align: "left", valign: "middle",
  });
  slide.addText(ctx.deckTitle, {
    x: cx, y: 2.72, w: cw, h: 1.9,
    fontFace: PPTX_FONT, fontSize: 34, bold: true, color: PPTX_BRAND.foreground, align: "left", valign: "top",
    lineSpacingMultiple: 1.02, fit: "shrink",
  });
  // Gold accent rule.
  slide.addShape("roundRect", {
    x: cx, y: 4.7, w: 0.95, h: 0.055, rectRadius: 0.025,
    fill: { color: PPTX_BRAND.accent }, line: { color: PPTX_BRAND.accent },
  });
  const subtitle = spec.slots.subtitle ?? ctx.deckSubtitle ?? spec.actionTitle;
  slide.addText(subtitle, {
    x: cx, y: 4.92, w: cw, h: 1.3,
    fontFace: PPTX_FONT, fontSize: 16, color: PPTX_BRAND.inkSoft, align: "left", valign: "top",
    lineSpacingMultiple: 1.1, fit: "shrink",
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
