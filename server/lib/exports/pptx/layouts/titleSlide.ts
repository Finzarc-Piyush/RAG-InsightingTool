/**
 * W-EXP-5 · TitleSlide layout.
 *
 * Cover slide. Big deck title centered, thin accent rule, sub-title (the
 * question being answered), prepared-for + confidentiality + date stacked
 * at the bottom-left. No chart, no table — just typography and one
 * accent rule that visually anchors the rest of the deck.
 */
import { PPTX_BRAND, PPTX_FONT, PPTX_SLIDE, attachSpeakerNotes } from "../master.js";
import type { PptxPres } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

interface TitleSlideContext {
  deckTitle: string;
  deckSubtitle?: string;
  generatedAt: string;
  confidentiality: string;
  preparedFor?: string;
}

export function renderTitleSlide(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "TitleSlide" }>,
  ctx: TitleSlideContext
): void {
  const slide = pres.addSlide();
  slide.background = { color: PPTX_BRAND.background };

  // Brand-tinted vertical bar on the far left as a visual anchor.
  slide.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.16,
    h: PPTX_SLIDE.heightIn,
    fill: { color: PPTX_BRAND.primary },
    line: { color: PPTX_BRAND.primary },
  });

  // Big deck title — uses the SlideSpec's actionTitle; the deck-planner
  // is required to give the title slide a specific actionTitle (not just
  // the dashboard name). Display the dashboard name AS the actionTitle so
  // both code paths converge.
  slide.addText(ctx.deckTitle, {
    x: 0.6,
    y: 2.3,
    w: PPTX_SLIDE.widthIn - 1.2,
    h: 1.5,
    fontFace: PPTX_FONT,
    fontSize: 40,
    bold: true,
    color: PPTX_BRAND.foreground,
    align: "left",
    valign: "middle",
  });

  // Thin accent rule under the title.
  slide.addShape("rect", {
    x: 0.6,
    y: 3.85,
    w: 1.2,
    h: 0.05,
    fill: { color: PPTX_BRAND.primary },
    line: { color: PPTX_BRAND.primary },
  });

  // Subtitle — the question being answered, or the planner's actionTitle
  // when no subtitle exists.
  const subtitle = spec.slots.subtitle ?? ctx.deckSubtitle ?? spec.actionTitle;
  slide.addText(subtitle, {
    x: 0.6,
    y: 4.0,
    w: PPTX_SLIDE.widthIn - 1.2,
    h: 1.0,
    fontFace: PPTX_FONT,
    fontSize: 18,
    color: PPTX_BRAND.muted,
    align: "left",
    valign: "top",
  });

  // Bottom-left meta block.
  const metaLines: string[] = [];
  const preparedFor = spec.slots.preparedFor ?? ctx.preparedFor;
  if (preparedFor) metaLines.push(`Prepared for: ${preparedFor}`);
  metaLines.push(`Generated: ${ctx.generatedAt}`);
  metaLines.push(`${spec.slots.confidentiality ?? ctx.confidentiality}`);
  slide.addText(metaLines.join("\n"), {
    x: 0.6,
    y: PPTX_SLIDE.heightIn - 1.6,
    w: PPTX_SLIDE.widthIn - 1.2,
    h: 1.0,
    fontFace: PPTX_FONT,
    fontSize: 12,
    color: PPTX_BRAND.muted,
    align: "left",
    valign: "bottom",
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
