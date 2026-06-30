/**
 * pptxgenjs slide-master + the deck's shared visual LANGUAGE.
 *
 * One source of truth for palette, fonts, slide dimensions, the running
 * header/footer, AND the reusable primitives every layout composes from:
 * action titles (with optional kicker + gold accent tick), cards, chips,
 * eyebrows, dividers, bullet lists, KPI/delta helpers, and a shared data-table
 * renderer. Pushing the look into primitives is what keeps the ten layouts
 * consistent BY CONSTRUCTION — a layout file just calls `addCard`/`chip`/…,
 * never re-invents a rounded rectangle or a colour decision.
 *
 * Palette/number tokens come from the single sources in `../brandPalette.ts`
 * and `../numberFormatExport.ts` (shared with the chartSsr + PDF masters).
 * Bare hex (no `#`) per the pptxgenjs convention.
 */
import type { PptxPres, PptxSlide, PptxRectShape, PptxTextLine, PptxTextOptions } from "./types.js";
import { EXPORT_HEX, EXPORT_CATEGORICAL, tint, shade, onColor } from "../brandPalette.js";
import { formatCell, columnIsNumeric } from "../numberFormatExport.js";
import type { ChartInsightLanes } from "../../../shared/chartInsightLanes.js";

/** Palette for the PPTX renderer, built from the single brand source. */
export const PPTX_BRAND = {
  primary: EXPORT_HEX.primary,
  accent: EXPORT_HEX.accent,
  foreground: EXPORT_HEX.foreground,
  inkSoft: EXPORT_HEX.inkSoft,
  muted: EXPORT_HEX.muted,
  border: EXPORT_HEX.border,
  gridline: EXPORT_HEX.gridline,
  background: EXPORT_HEX.background,
  surfaceMuted: EXPORT_HEX.surfaceMuted,
  surfaceWarm: EXPORT_HEX.surfaceWarm,
  surfaceNavy: EXPORT_HEX.surfaceNavy,
  positive: EXPORT_HEX.positive,
  negative: EXPORT_HEX.negative,
  categorical: [...EXPORT_CATEGORICAL],
  horizonNow: EXPORT_HEX.horizonNow,
  horizonThisQuarter: EXPORT_HEX.horizonThisQuarter,
  horizonStrategic: EXPORT_HEX.horizonStrategic,
} as const;

export const PPTX_FONT = "Inter";

/** Type scale (pt) — one ramp the whole deck shares. */
export const PPTX_TYPE = {
  kicker: 11,
  title: 23,
  sectionLabel: 12,
  lead: 16,
  body: 13.5,
  bodyTight: 12,
  caption: 9.5,
  chip: 10.5,
  kpiValue: 33,
  kpiLabel: 11.5,
  kpiDelta: 12,
  table: 10,
  tableHeader: 10.5,
} as const;

/** 16:9 widescreen — pptxgenjs "LAYOUT_WIDE" = 13.33 × 7.5 in. */
export const PPTX_SLIDE = {
  widthIn: 13.33,
  heightIn: 7.5,
  marginIn: 0.5,
} as const;

export const MASTER_NAME = "MARICO_BASE";

/** Soft, premium drop shadow for cards/tiles. */
const CARD_SHADOW = {
  type: "outer" as const,
  color: "1B2A3F",
  opacity: 0.16,
  blur: 9,
  offset: 3,
  angle: 90,
};

/**
 * Define the slide master. Call once after `new pptxgenjs()`.
 * A restrained running header (small gold mark + brand line) and a footer
 * (hairline + date · confidentiality, slide x / N). No heavy full-width rule.
 */
export function defineMaster(
  pres: PptxPres,
  ctx: { brandLine: string; confidentiality: string; generatedAt: string }
): void {
  if (!pres.defineSlideMaster) return; // pptxgenjs typing fallback path
  const m = PPTX_SLIDE.marginIn;
  pres.defineSlideMaster({
    title: MASTER_NAME,
    background: { color: PPTX_BRAND.background },
    objects: [
      // Brand mark — small gold square.
      { rect: { x: m, y: 0.26, w: 0.13, h: 0.13, fill: { color: PPTX_BRAND.accent } } },
      // Brand line (running header).
      {
        text: {
          text: ctx.brandLine,
          options: {
            x: m + 0.22, y: 0.2, w: PPTX_SLIDE.widthIn - m * 2 - 0.22, h: 0.26,
            fontFace: PPTX_FONT, fontSize: 9, bold: true, color: PPTX_BRAND.primary,
            charSpacing: 0.4, align: "left", valign: "middle",
          },
        },
      },
      // Footer hairline.
      {
        rect: {
          x: m, y: PPTX_SLIDE.heightIn - 0.42,
          w: PPTX_SLIDE.widthIn - m * 2, h: 0.008, fill: { color: PPTX_BRAND.border },
        },
      },
      // Footer left — date + confidentiality.
      {
        text: {
          text: `${ctx.generatedAt}   ·   ${ctx.confidentiality}`,
          options: {
            x: m, y: PPTX_SLIDE.heightIn - 0.38, w: 8, h: 0.3,
            fontFace: PPTX_FONT, fontSize: 8.5, color: PPTX_BRAND.muted, align: "left", valign: "middle",
          },
        },
      },
      // Footer right — slide number.
      {
        text: {
          text: "Slide <page> / <page-count>",
          options: {
            x: PPTX_SLIDE.widthIn - 3 - m, y: PPTX_SLIDE.heightIn - 0.38, w: 3, h: 0.3,
            fontFace: PPTX_FONT, fontSize: 8.5, color: PPTX_BRAND.muted, align: "right", valign: "middle",
          },
        },
      },
    ],
  });
}

/** Content area available to each layout after master header/footer. */
export const CONTENT_BOX: PptxRectShape = {
  x: PPTX_SLIDE.marginIn,
  y: 0.62,
  w: PPTX_SLIDE.widthIn - PPTX_SLIDE.marginIn * 2,
  h: PPTX_SLIDE.heightIn - 0.62 - 0.52,
};

// ── Text geometry estimators ─────────────────────────────────────────────────
//
// One deterministic estimator the WHOLE deck shares. Every layout that places
// variable-length text into a box sizes that box from these helpers rather than
// relying on PowerPoint's `<a:normAutofit/>` (which pptxgenjs emits with NO
// computed fontScale, so PowerPoint under-shrinks multi-line text and the text
// spills out of the box — the root cause of text landing on charts / off the
// slide). 1 inch = 72 pt. Inter's average glyph advance for mixed sentence case
// is ≈ 0.50 × fontSize pt of width; we err slightly LOW on chars-per-line so the
// estimate yields MORE lines = a TALLER box = no overflow.
const AVG_CHAR_ADVANCE_RATIO = 0.5;

/** Approx. characters that fit on one line `widthIn` wide at `fontSizePt`. */
export function charsPerLine(widthIn: number, fontSizePt: number): number {
  if (widthIn <= 0 || fontSizePt <= 0) return 1;
  return Math.max(1, Math.floor((widthIn * 72) / (fontSizePt * AVG_CHAR_ADVANCE_RATIO)));
}

/**
 * Estimate the wrapped line count for `text` in a box `widthIn` wide at
 * `fontSizePt`, honouring explicit "\n" hard breaks. Minimum 1.
 */
export function estimateLineCount(text: string, widthIn: number, fontSizePt: number): number {
  const cpl = charsPerLine(widthIn, fontSizePt);
  const segments = (text ?? "").split("\n");
  let lines = 0;
  for (const seg of segments) {
    const len = seg.trim().length;
    lines += len === 0 ? 1 : Math.ceil(len / cpl);
  }
  return Math.max(1, lines);
}

/**
 * Estimate the rendered height (inches) of `text` in a box `widthIn` wide at
 * `fontSizePt`. `padIn` covers the addText box inset (~0.1in/side) plus a small
 * safety margin.
 */
export function estimateTextHeight(
  text: string,
  widthIn: number,
  fontSizePt: number,
  opts: { lineSpacingMultiple?: number; padIn?: number } = {}
): number {
  const lineSpacing = opts.lineSpacingMultiple ?? 1.05;
  const padIn = opts.padIn ?? 0.16;
  const lines = estimateLineCount(text, widthIn, fontSizePt);
  const lineHeightIn = (fontSizePt / 72) * lineSpacing;
  return lines * lineHeightIn + padIn;
}

/**
 * Estimate the rendered height (inches) of a structured chart insight rendered
 * as headline (lead pt, bold) + optional WHY/DO lanes (smaller pt), each lane on
 * its own paragraph with `paraSpaceAfterPt` between lanes. Mirrors how
 * `renderChartWithInsight` lays the lanes out so the box is sized to fit them.
 */
export function measureInsightLanes(
  lanes: ChartInsightLanes,
  widthIn: number,
  opts: { headlinePt: number; lanePt: number; paraSpaceAfterPt?: number; padIn?: number }
): number {
  const paraGapIn = (opts.paraSpaceAfterPt ?? 4) / 72;
  const padIn = opts.padIn ?? 0.16;
  // Each lane's own text height with NO extra pad (we add the box pad once).
  let h = estimateTextHeight(lanes.headline || " ", widthIn, opts.headlinePt, { padIn: 0 });
  const extra: string[] = [];
  if (lanes.why && lanes.why.trim()) extra.push(`Why: ${lanes.why.trim()}`);
  if (lanes.do && lanes.do.trim()) extra.push(`Do: ${lanes.do.trim()}`);
  for (const laneText of extra) {
    h += paraGapIn + estimateTextHeight(laneText, widthIn, opts.lanePt, { padIn: 0 });
  }
  return h + padIn;
}

export interface ActionTitleOpts {
  /** Small uppercase eyebrow above the title (e.g. "FINDINGS · 03"). */
  kicker?: string;
  /** Accent colour for the kicker + the tick under the title. Default gold. */
  accent?: string;
}

/**
 * Render the action title block. Returns the Y (inches) where body content
 * should begin — every non-cover layout uses this so spacing stays uniform.
 */
export function renderActionTitle(
  slide: PptxSlide,
  actionTitle: string,
  opts: ActionTitleOpts = {}
): number {
  const accent = opts.accent ?? PPTX_BRAND.accent;
  let y = CONTENT_BOX.y;
  if (opts.kicker) {
    slide.addText(opts.kicker.toUpperCase(), {
      x: CONTENT_BOX.x, y, w: CONTENT_BOX.w, h: 0.24,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.kicker, bold: true,
      color: accent, charSpacing: 1.6, align: "left", valign: "middle",
    });
    y += 0.28;
  }
  // Reserve the title's REAL height: a long action title (≤280 chars) wraps to
  // 2+ lines at 23pt, but the box used to be a fixed 0.72in (~1 line) — so the
  // accent tick landed on the title and every layout received a `top` that
  // overlapped its own title. Cap rendering at 2 lines (clamp the string with an
  // ellipsis as a backstop) and size the box to those lines so `top` is honest.
  const titleLines = Math.min(2, estimateLineCount(actionTitle, CONTENT_BOX.w, PPTX_TYPE.title));
  const maxTitleChars = charsPerLine(CONTENT_BOX.w, PPTX_TYPE.title) * 2;
  const titleText =
    actionTitle.length > maxTitleChars ? `${actionTitle.slice(0, maxTitleChars - 1).trimEnd()}…` : actionTitle;
  const titleH = Math.max(0.5, titleLines * (PPTX_TYPE.title / 72) * 1.06 + 0.12);
  slide.addText(titleText, {
    x: CONTENT_BOX.x, y, w: CONTENT_BOX.w, h: titleH,
    fontFace: PPTX_FONT, fontSize: PPTX_TYPE.title, bold: true,
    color: PPTX_BRAND.foreground, align: "left", valign: "top",
    lineSpacingMultiple: 1.0, fit: "shrink",
  });
  const tickY = y + titleH + 0.04;
  slide.addShape("roundRect", {
    x: CONTENT_BOX.x, y: tickY, w: 0.5, h: 0.05,
    rectRadius: 0.025, fill: { color: accent }, line: { color: accent },
  });
  return tickY + 0.22;
}

// ── Primitives ───────────────────────────────────────────────────────────────

export interface CardOpts {
  fill?: string;
  border?: string;
  radius?: number;
  shadow?: boolean;
  /** Left accent rail colour. */
  accent?: string;
}

/** Rounded card — the universal container (KPI tile, list row, panel). */
export function addCard(slide: PptxSlide, box: PptxRectShape, opts: CardOpts = {}): void {
  slide.addShape("roundRect", {
    x: box.x, y: box.y, w: box.w, h: box.h,
    rectRadius: opts.radius ?? 0.09,
    fill: { color: opts.fill ?? PPTX_BRAND.background },
    line: { color: opts.border ?? PPTX_BRAND.border, width: 0.75 },
    ...(opts.shadow === false ? {} : { shadow: CARD_SHADOW }),
  });
  if (opts.accent) {
    slide.addShape("roundRect", {
      x: box.x, y: box.y + 0.08, w: 0.07, h: box.h - 0.16,
      rectRadius: 0.035, fill: { color: opts.accent }, line: { color: opts.accent },
    });
  }
}

/** Estimate a chip's width (inches) for a label at the chip font size. */
export function chipWidth(label: string, fontSize: number = PPTX_TYPE.chip): number {
  return Math.max(0.62, label.length * fontSize * 0.0095 + 0.34);
}

export interface ChipOpts {
  solid?: boolean;
  fontSize?: number;
  align?: "left" | "center" | "right";
  bold?: boolean;
}

/**
 * Soft "badge" chip (default) or solid pill. One chip style across the deck.
 * Soft = tinted fill + darkened-colour text; solid = colour fill + readable text.
 */
export function chip(
  slide: PptxSlide,
  box: { x: number; y: number; w: number; h?: number },
  label: string,
  color: string,
  opts: ChipOpts = {}
): void {
  const h = box.h ?? 0.32;
  const solid = opts.solid === true;
  slide.addShape("roundRect", {
    x: box.x, y: box.y, w: box.w, h,
    rectRadius: Math.min(0.12, h / 2),
    fill: { color: solid ? color : tint(color, 0.84) },
    line: { color: solid ? color : tint(color, 0.55), width: 0.75 },
  });
  slide.addText(label, {
    x: box.x, y: box.y, w: box.w, h,
    fontFace: PPTX_FONT, fontSize: opts.fontSize ?? PPTX_TYPE.chip,
    bold: opts.bold ?? true,
    color: solid ? onColor(color) : shade(color, 0.12),
    align: opts.align ?? "center", valign: "middle", fit: "shrink",
  });
}

/** Small uppercase, letter-spaced eyebrow/label. */
export function eyebrow(
  slide: PptxSlide,
  box: { x: number; y: number; w: number; h?: number },
  text: string,
  opts: { color?: string; align?: "left" | "center" | "right" } = {}
): void {
  slide.addText(text.toUpperCase(), {
    x: box.x, y: box.y, w: box.w, h: box.h ?? 0.24,
    fontFace: PPTX_FONT, fontSize: PPTX_TYPE.kicker, bold: true,
    color: opts.color ?? PPTX_BRAND.muted, charSpacing: 1.4,
    align: opts.align ?? "left", valign: "middle",
  });
}

/** Hairline divider. */
export function divider(
  slide: PptxSlide,
  box: { x: number; y: number; w: number },
  color: string = PPTX_BRAND.border
): void {
  slide.addShape("rect", { x: box.x, y: box.y, w: box.w, h: 0.01, fill: { color }, line: { color } });
}

/**
 * Bullet list with a coloured square glyph + ink text (real paragraphs).
 * Autofits; meant for short scannable items (implications, caveats).
 */
export function bulletList(
  slide: PptxSlide,
  items: string[],
  box: PptxRectShape,
  opts: { fontSize?: number; color?: string; bulletColor?: string; gap?: number } = {}
): void {
  const fontSize = opts.fontSize ?? PPTX_TYPE.bodyTight;
  const color = opts.color ?? PPTX_BRAND.foreground;
  const bulletColor = opts.bulletColor ?? PPTX_BRAND.accent;
  const gap = opts.gap ?? 7;

  // Clamp each item to what the box can legibly hold so the list neither shrinks
  // to an unreadable size (fit:"shrink" on a huge blob) nor overflows the box.
  // Distribute the available lines across the items.
  const lineH = (fontSize / 72) * 1.04;
  const totalLines = Math.max(items.length, Math.floor(box.h / Math.max(lineH, 0.01)));
  const linesPerItem = Math.max(1, Math.floor(totalLines / Math.max(1, items.length)));
  const cpl = charsPerLine(Math.max(0.5, box.w - 0.25), fontSize); // 0.25 ≈ bullet glyph indent
  const maxCharsPerItem = Math.max(8, linesPerItem * cpl);
  const shown = items.map((it) => {
    const t = (it ?? "").trim();
    return t.length > maxCharsPerItem ? `${t.slice(0, maxCharsPerItem - 1).trimEnd()}…` : t;
  });

  const runs: PptxTextLine[] = [];
  shown.forEach((item) => {
    runs.push({ text: "▪  ", options: { color: bulletColor, fontSize, bold: true } });
    runs.push({ text: item, options: { color, fontSize, breakLine: true, paraSpaceAfter: gap } });
  });
  slide.addText(runs, {
    x: box.x, y: box.y, w: box.w, h: box.h,
    fontFace: PPTX_FONT, valign: "top", lineSpacingMultiple: 1.04, fit: "shrink",
  });
}

/** Colour for a +/- delta string (▲ green / ▼ red / – muted). */
export function deltaColor(delta: string | undefined): string {
  if (!delta) return PPTX_BRAND.muted;
  const t = delta.trim();
  if (/^[+▲]/.test(t) || /\bup\b/i.test(t)) return PPTX_BRAND.positive;
  if (/^[-−▼]/.test(t) || /\bdown\b/i.test(t)) return PPTX_BRAND.negative;
  return PPTX_BRAND.muted;
}

/** Prefix a delta string with a ▲/▼ arrow glyph if it doesn't already have one. */
export function deltaWithArrow(delta: string): string {
  const t = delta.trim();
  if (/^[▲▼]/.test(t)) return t;
  if (/^[+]/.test(t) || /\bup\b/i.test(t)) return `▲ ${t.replace(/^\+\s*/, "")}`;
  if (/^[-−]/.test(t) || /\bdown\b/i.test(t)) return `▼ ${t.replace(/^[-−]\s*/, "")}`;
  return t;
}

export const HORIZON = {
  now: { color: PPTX_BRAND.horizonNow, label: "Now" },
  this_quarter: { color: PPTX_BRAND.horizonThisQuarter, label: "This quarter" },
  thisQuarter: { color: PPTX_BRAND.horizonThisQuarter, label: "This quarter" },
  strategic: { color: PPTX_BRAND.horizonStrategic, label: "Strategic" },
} as const;

export interface DataTableOpts {
  maxRows?: number;
  fontSize?: number;
  headerColor?: string;
}

/**
 * Shared data-table renderer — ONE styling for TableSlide + Appendix.
 * Primary header band, zebra rows, right-aligned & number-formatted numerics,
 * proportional column widths, horizontal-rule-only grid, and an explicit
 * "Showing N of M" note when rows are capped (never silent truncation).
 * Returns the Y (inches) just below the table.
 */
export function renderDataTable(
  slide: PptxSlide,
  box: PptxRectShape,
  data: { columns: string[]; rows: Array<Array<string | number | null>> },
  opts: DataTableOpts = {}
): number {
  const maxRows = opts.maxRows ?? 14;
  const fontSize = opts.fontSize ?? PPTX_TYPE.table;
  const headerColor = opts.headerColor ?? PPTX_BRAND.primary;
  const cols = data.columns;
  const allRows = data.rows;
  const shown = allRows.slice(0, maxRows);

  const numericCol = cols.map((_, ci) => columnIsNumeric(allRows, ci));

  // Proportional column widths from header + sampled cell text length.
  const sample = shown.slice(0, 20);
  const weights = cols.map((c, ci) => {
    let w = String(c).length;
    for (const r of sample) w = Math.max(w, String(r[ci] ?? "").length);
    return Math.max(4, Math.min(w, 42));
  });
  const wsum = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((w) => Math.max(0.7, (w / wsum) * box.w));

  const hairline = { type: "solid" as const, pt: 0.5, color: PPTX_BRAND.border };
  const noBorder = { type: "none" as const };
  const cellBorder = [hairline, noBorder, hairline, noBorder] as const;

  const headerRow = cols.map((c) => ({
    text: String(c),
    options: {
      bold: true, color: onColor(headerColor), fill: { color: headerColor },
      align: (numericCol[cols.indexOf(c)] ? "right" : "left") as "left" | "right",
      valign: "middle" as const, fontSize: PPTX_TYPE.tableHeader,
      margin: [3, 5, 3, 5] as [number, number, number, number],
    },
  }));

  const bodyRows = shown.map((row, ri) =>
    cols.map((_, ci) => ({
      text: formatCell(row[ci], cols[ci]),
      options: {
        color: PPTX_BRAND.foreground,
        fill: { color: ri % 2 === 0 ? PPTX_BRAND.background : PPTX_BRAND.surfaceMuted },
        align: (numericCol[ci] ? "right" : "left") as "left" | "right",
        valign: "middle" as const, fontSize,
        margin: [3, 5, 3, 5] as [number, number, number, number],
        border: cellBorder as unknown as PptxTextOptions["border"],
      },
    }))
  );

  const rowH = Math.max(0.26, Math.min(0.44, (box.h - 0.3) / (shown.length + 1)));
  slide.addTable([headerRow, ...bodyRows], {
    x: box.x, y: box.y, w: box.w, colW, rowH,
    border: cellBorder, fontFace: PPTX_FONT, autoPage: false, valign: "middle",
  });

  const tableBottom = box.y + rowH * (shown.length + 1);
  if (allRows.length > shown.length) {
    slide.addText(`Showing ${shown.length} of ${allRows.length} rows`, {
      x: box.x, y: tableBottom + 0.06, w: box.w, h: 0.26,
      fontFace: PPTX_FONT, fontSize: PPTX_TYPE.caption, italic: true,
      color: PPTX_BRAND.muted, align: "right", valign: "middle",
    });
    return tableBottom + 0.34;
  }
  return tableBottom + 0.1;
}

/** Attach speaker notes (probe for the method to stay version-agnostic). */
export function attachSpeakerNotes(slide: PptxSlide, notes: string): void {
  if (typeof slide.addNotes === "function") slide.addNotes(notes);
}

// Re-export colour helpers so layouts have one import source.
export { tint, shade, onColor };
