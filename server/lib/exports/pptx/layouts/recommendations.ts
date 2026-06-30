/**
 * W-EXP-6 · Recommendations layout — premium card-row redesign.
 *
 * The "what to do" slide, MBB-style: each recommendation is its own white
 * card row (hairline border, no shadow) so 1–8 items read as discrete,
 * scannable commitments instead of a merged wall. Per row: a navy number
 * badge at left; the action verb (bold) with its rationale beneath (ink-soft,
 * NOT washed muted) in one shrink-to-fit text box; on the right a horizon
 * chip with a tiny three-dot confidence meter under it and an optional owner
 * caption. Row height + fonts scale DOWN as the count grows so eight rows
 * still clear the footer. Colours/labels come from the shared HORIZON map and
 * every container/chip is a master primitive — no local rounded-rect or
 * colour decisions here.
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
  charsPerLine,
  chip,
  estimateLineCount,
  renderActionTitle,
  tint,
} from "../master.js";
import type { PptxPres, PptxSlide } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

type Horizon = "now" | "this_quarter" | "strategic";
type Confidence = "low" | "medium" | "high";

/** Truncate `text` to at most `max` chars with an ellipsis; report if it cut. */
function clampToChars(text: string, max: number): { text: string; truncated: boolean } {
  const t = (text ?? "").trim();
  if (max <= 0) return { text: "", truncated: t.length > 0 };
  if (t.length <= max) return { text: t, truncated: false };
  return { text: `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`, truncated: true };
}

/** Filled-dot count for the three-dot confidence meter. */
const CONFIDENCE_FILLED: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

/** Resolve the HORIZON map entry safely under noUncheckedIndexedAccess. */
function horizonMeta(h: Horizon): { color: string; label: string } {
  return HORIZON[h] ?? HORIZON.now;
}

/**
 * Three small dots in the horizon colour — `filled` of them solid, the rest
 * a soft tint — laid out left-to-right. A quiet confidence indicator that
 * sits under the horizon chip without competing with it.
 */
function confidenceDots(
  slide: PptxSlide,
  x: number,
  y: number,
  color: string,
  level: Confidence
): void {
  const filled = CONFIDENCE_FILLED[level] ?? 1;
  const d = 0.075; // dot diameter
  const gap = 0.05;
  for (let i = 0; i < 3; i++) {
    const on = i < filled;
    slide.addShape("ellipse", {
      x: x + i * (d + gap),
      y,
      w: d,
      h: d,
      fill: { color: on ? color : tint(color, 0.78) },
      line: { color: on ? color : tint(color, 0.55), width: 0.5 },
    });
  }
}

export function renderRecommendations(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "Recommendations" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h;
  const lane = Math.min(contentBottom, 6.9); // never draw past ~6.9in

  const items = spec.slots.items;
  const count = Math.max(1, items.length);

  // Row geometry: divide the lane into N rows with a small inter-row gap.
  const rowGap = count >= 7 ? 0.07 : count >= 5 ? 0.1 : 0.14;
  const rowH = Math.max(0.46, (lane - top - rowGap * (count - 1)) / count);

  // Font ramp shrinks as rows get denser — keeps two text lines inside a row.
  const dense = rowH < 0.66;
  const actionFs = dense ? PPTX_TYPE.bodyTight : PPTX_TYPE.body;
  const rationaleFs = dense ? PPTX_TYPE.caption : PPTX_TYPE.bodyTight;

  // Column geometry inside each card.
  const padX = 0.16;
  const badgeW = Math.min(0.5, rowH - 0.22);
  const textX = CONTENT_BOX.x + padX + badgeW + 0.18;
  const rightW = 1.78; // reserved right rail for horizon chip + meter
  const rightX = CONTENT_BOX.x + CONTENT_BOX.w - rightW - padX;
  const textW = rightX - textX - 0.16;

  // Each row holds action (bold) + rationale in a FIXED-height box. The rationale
  // can be up to 800 chars — far more than a dense 0.46in row holds — so clamp
  // both to a per-row char budget (and TOP-align) instead of letting shrink-to-fit
  // spill text over the row. The full untruncated text is preserved in notes.
  const overflowNotes: string[] = [];
  const innerH = rowH - 0.12;
  const aLineH = (actionFs / 72) * 1.02;
  const rLineH = (rationaleFs / 72) * 1.02;

  items.forEach((item, i) => {
    const y = top + i * (rowH + rowGap);
    const meta = horizonMeta(item.horizon as Horizon);

    // Per-row char budgets: action gets ≤2 lines, rationale gets the remainder.
    const aMaxLines = Math.min(2, estimateLineCount(item.action, textW, actionFs));
    const aClamp = clampToChars(item.action, aMaxLines * charsPerLine(textW, actionFs));
    const aHeight = aMaxLines * aLineH + 2 / 72; // + paraSpaceAfter
    const rRemaining = Math.max(rLineH, innerH - aHeight);
    const rLines = Math.max(1, Math.floor(rRemaining / rLineH));
    const rClamp = clampToChars(item.rationale, rLines * charsPerLine(textW, rationaleFs));
    if (aClamp.truncated || rClamp.truncated) {
      overflowNotes.push(`${i + 1}. ${(item.action ?? "").trim()} — ${(item.rationale ?? "").trim()}`);
    }

    // Card row — white, hairline border, no shadow (stacked rows want calm).
    addCard(slide, { x: CONTENT_BOX.x, y, w: CONTENT_BOX.w, h: rowH }, {
      fill: PPTX_BRAND.background,
      border: PPTX_BRAND.border,
      shadow: false,
      radius: 0.07,
    });

    // Navy number badge (solid chip primitive).
    const badgeY = y + (rowH - badgeW) / 2;
    chip(
      slide,
      { x: CONTENT_BOX.x + padX, y: badgeY, w: badgeW, h: badgeW },
      String(i + 1),
      PPTX_BRAND.primary,
      { solid: true, align: "center", bold: true, fontSize: dense ? 11 : 13 }
    );

    // Action (bold) + rationale (ink-soft) as two runs, clamped to fit + TOP-
    // aligned so neither spills over the row.
    slide.addText(
      [
        {
          text: aClamp.text,
          options: {
            bold: true,
            fontSize: actionFs,
            color: PPTX_BRAND.foreground,
            breakLine: true,
            paraSpaceAfter: 2,
          },
        },
        {
          text: rClamp.text,
          options: {
            fontSize: rationaleFs,
            color: PPTX_BRAND.inkSoft,
            breakLine: true,
          },
        },
      ],
      {
        x: textX,
        y: y + 0.06,
        w: textW,
        h: rowH - 0.12,
        fontFace: PPTX_FONT,
        valign: "top",
        lineSpacingMultiple: 1.02,
        fit: "shrink",
      }
    );

    // Right rail — horizon chip, confidence meter under it, optional owner.
    const chipH = dense ? 0.26 : 0.3;
    const hasConf = Boolean(item.confidence);
    const hasOwner = Boolean(item.owner);
    // Stack height = chip + (dots) + (owner) — vertically centre the cluster.
    const dotsH = hasConf ? 0.075 + 0.06 : 0;
    const ownerH = hasOwner ? 0.18 : 0;
    const stackH = chipH + dotsH + ownerH;
    let cy = y + (rowH - stackH) / 2;

    chip(slide, { x: rightX, y: cy, w: rightW, h: chipH }, meta.label, meta.color, {
      fontSize: dense ? 9.5 : PPTX_TYPE.chip,
    });
    cy += chipH;

    if (hasConf) {
      cy += 0.06;
      // Centre the three-dot meter within the right rail.
      const meterW = 3 * 0.075 + 2 * 0.05;
      confidenceDots(slide, rightX + (rightW - meterW) / 2, cy, meta.color, item.confidence as Confidence);
      cy += 0.075;
    }

    if (hasOwner) {
      slide.addText(item.owner ?? "", {
        x: rightX,
        y: cy + 0.02,
        w: rightW,
        h: 0.18,
        fontFace: PPTX_FONT,
        fontSize: PPTX_TYPE.caption,
        color: PPTX_BRAND.muted,
        align: "center",
        valign: "middle",
        fit: "shrink",
      });
    }
  });

  const notes = overflowNotes.length
    ? `${spec.speakerNotes}\n\nFull recommendations:\n${overflowNotes.join("\n")}`
    : spec.speakerNotes;
  attachSpeakerNotes(slide, notes);
}
