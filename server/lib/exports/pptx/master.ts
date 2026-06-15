/**
 * W-EXP-5 · pptxgenjs slide-master + branding constants.
 *
 * One source of truth for palette, fonts, slide dimensions, and the
 * running header/footer applied to every non-title slide. Layout files
 * import from here and never from inline literals.
 *
 * The master uses pptxgenjs's `defineSlideMaster` which lets us add a
 * single named master ("MARICO_BASE") that every slide references — global
 * restyles (e.g. swapping accent colour) become a one-edit change. Note:
 * pptxgenjs's master support is solid for shapes/images but quirky for
 * tables (issue #655 lineage); we keep the master to header/footer/page
 * number only.
 */
import type { PptxPres, PptxSlide, PptxRectShape } from "./types.js";
import { EXPORT_HEX, EXPORT_CATEGORICAL } from "../brandPalette.js";

/**
 * Palette + font for the PPTX renderer, built from the single source in
 * `server/lib/exports/brandPalette.ts` (shared with the chartSsr and PDF
 * masters). Bare hex (no `#`) per the pptxgenjs convention.
 */
export const PPTX_BRAND = {
  primary: EXPORT_HEX.primary,
  accent: EXPORT_HEX.accent,
  foreground: EXPORT_HEX.foreground,
  muted: EXPORT_HEX.muted,
  border: EXPORT_HEX.border,
  background: EXPORT_HEX.background,
  /** Categorical palette (no `#` prefix per pptxgenjs convention). */
  categorical: [...EXPORT_CATEGORICAL],
  /** Horizon chips for ImplicationsByHorizon / Recommendations. */
  horizonNow: EXPORT_HEX.horizonNow,
  horizonThisQuarter: EXPORT_HEX.horizonThisQuarter,
  horizonStrategic: EXPORT_HEX.horizonStrategic,
} as const;

export const PPTX_FONT = "Inter";

/**
 * 16:9 widescreen at LAYOUT_WIDE — pptxgenjs's "WIDE" layout = 13.33 × 7.5
 * inches (the modern presentation default). All layout files position
 * shapes assuming this layout.
 */
export const PPTX_SLIDE = {
  widthIn: 13.33,
  heightIn: 7.5,
  /** Outer margin used by every layout for left/right gutters. */
  marginIn: 0.5,
} as const;

/** Master-slide name. Layouts pass it via `pres.addSlide({ masterName })`. */
export const MASTER_NAME = "MARICO_BASE";

/**
 * Define the slide master. Call once after `new pptxgenjs()`.
 * Adds:
 *   - Running header — light separator + tiny brand-line text on the left
 *   - Running footer — date · page x of N · confidentiality
 *
 * Footer fields use pptxgenjs's tokens (e.g. `<page>` / `<page-count>`)
 * which the engine resolves at write time. No runtime concatenation.
 */
export function defineMaster(
  pres: PptxPres,
  ctx: { brandLine: string; confidentiality: string; generatedAt: string }
): void {
  if (!pres.defineSlideMaster) return; // pptxgenjs typing fallback path
  pres.defineSlideMaster({
    title: MASTER_NAME,
    background: { color: PPTX_BRAND.background },
    objects: [
      // Top thin rule
      {
        rect: {
          x: PPTX_SLIDE.marginIn,
          y: 0.18,
          w: PPTX_SLIDE.widthIn - PPTX_SLIDE.marginIn * 2,
          h: 0.02,
          fill: { color: PPTX_BRAND.primary },
        },
      },
      // Brand line (running header)
      {
        text: {
          text: ctx.brandLine,
          options: {
            x: PPTX_SLIDE.marginIn,
            y: 0.22,
            w: PPTX_SLIDE.widthIn - PPTX_SLIDE.marginIn * 2,
            h: 0.28,
            fontFace: PPTX_FONT,
            fontSize: 9,
            color: PPTX_BRAND.muted,
            align: "left",
          },
        },
      },
      // Bottom thin rule
      {
        rect: {
          x: PPTX_SLIDE.marginIn,
          y: PPTX_SLIDE.heightIn - 0.4,
          w: PPTX_SLIDE.widthIn - PPTX_SLIDE.marginIn * 2,
          h: 0.01,
          fill: { color: PPTX_BRAND.border },
        },
      },
      // Footer left — date + confidentiality
      {
        text: {
          text: `${ctx.generatedAt} · ${ctx.confidentiality}`,
          options: {
            x: PPTX_SLIDE.marginIn,
            y: PPTX_SLIDE.heightIn - 0.36,
            w: 7,
            h: 0.3,
            fontFace: PPTX_FONT,
            fontSize: 9,
            color: PPTX_BRAND.muted,
            align: "left",
          },
        },
      },
      // Footer right — slide number
      {
        text: {
          text: "Slide <page> of <page-count>",
          options: {
            x: PPTX_SLIDE.widthIn - 3 - PPTX_SLIDE.marginIn,
            y: PPTX_SLIDE.heightIn - 0.36,
            w: 3,
            h: 0.3,
            fontFace: PPTX_FONT,
            fontSize: 9,
            color: PPTX_BRAND.muted,
            align: "right",
          },
        },
      },
    ],
  });
}

/**
 * Common content area — what each layout has to work with after master
 * header/footer reservations. Used by every layout's title-row + body
 * positioning.
 */
export const CONTENT_BOX: PptxRectShape = {
  x: PPTX_SLIDE.marginIn,
  y: 0.65,
  w: PPTX_SLIDE.widthIn - PPTX_SLIDE.marginIn * 2,
  h: PPTX_SLIDE.heightIn - 0.65 - 0.55,
};

/**
 * Render the action title at the top of the content area. Every non-title
 * layout calls this first to keep typography consistent.
 */
export function renderActionTitle(slide: PptxSlide, actionTitle: string): void {
  slide.addText(actionTitle, {
    x: CONTENT_BOX.x,
    y: CONTENT_BOX.y,
    w: CONTENT_BOX.w,
    h: 0.7,
    fontFace: PPTX_FONT,
    fontSize: 22,
    bold: true,
    color: PPTX_BRAND.foreground,
    align: "left",
    valign: "top",
  });
}

/**
 * Attach speaker notes (PowerPoint presenter view). pptxgenjs exposes
 * `addNotes` on the slide object; some older versions named it differently.
 * We probe for the method to stay version-agnostic.
 */
export function attachSpeakerNotes(slide: PptxSlide, notes: string): void {
  if (typeof slide.addNotes === "function") {
    slide.addNotes(notes);
  }
}
