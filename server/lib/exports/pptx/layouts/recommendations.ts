/**
 * W-EXP-6 · Recommendations layout.
 *
 * Numbered actionable recommendations with horizon chip + optional owner
 * + optional confidence. Mirrors how MBB decks render the "what to do"
 * slide: action verb up front, rationale beneath, horizon chip on the
 * right so the reader can scan timing at a glance.
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  attachSpeakerNotes,
  renderActionTitle,
} from "../master.js";
import type { PptxPres } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

const HORIZON_COLOR: Record<"now" | "this_quarter" | "strategic", string> = {
  now: PPTX_BRAND.horizonNow,
  this_quarter: PPTX_BRAND.horizonThisQuarter,
  strategic: PPTX_BRAND.horizonStrategic,
};

const HORIZON_LABEL: Record<"now" | "this_quarter" | "strategic", string> = {
  now: "Now",
  this_quarter: "This quarter",
  strategic: "Strategic",
};

export function renderRecommendations(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "Recommendations" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const titleH = 0.75;
  const items = spec.slots.items;
  const itemH = Math.min(1.0, (CONTENT_BOX.h - titleH - 0.4) / Math.max(1, items.length));
  const startY = CONTENT_BOX.y + titleH + 0.15;

  items.forEach((item, i) => {
    const y = startY + i * itemH;
    // Number bullet
    slide.addShape("ellipse", {
      x: CONTENT_BOX.x,
      y: y + 0.1,
      w: 0.45,
      h: 0.45,
      fill: { color: PPTX_BRAND.primary },
      line: { color: PPTX_BRAND.primary },
    });
    slide.addText(String(i + 1), {
      x: CONTENT_BOX.x,
      y: y + 0.1,
      w: 0.45,
      h: 0.45,
      fontFace: PPTX_FONT,
      fontSize: 14,
      bold: true,
      color: PPTX_BRAND.background,
      align: "center",
      valign: "middle",
    });
    // Action (bold) + rationale (regular)
    slide.addText(
      [
        {
          text: item.action,
          options: {
            bold: true,
            fontSize: 16,
            color: PPTX_BRAND.foreground,
            paraSpaceAfter: 4,
          },
        },
        {
          text: item.rationale,
          options: {
            fontSize: 12,
            color: PPTX_BRAND.muted,
          },
        },
      ],
      {
        x: CONTENT_BOX.x + 0.6,
        y,
        w: CONTENT_BOX.w - 0.6 - 2.4,
        h: itemH - 0.05,
        fontFace: PPTX_FONT,
        valign: "top",
      },
    );
    // Horizon chip (right side)
    const chipX = CONTENT_BOX.x + CONTENT_BOX.w - 2.2;
    slide.addShape("roundRect", {
      x: chipX,
      y: y + 0.1,
      w: 1.7,
      h: 0.4,
      rectRadius: 0.18,
      fill: { color: HORIZON_COLOR[item.horizon] },
      line: { color: HORIZON_COLOR[item.horizon] },
    });
    slide.addText(HORIZON_LABEL[item.horizon], {
      x: chipX,
      y: y + 0.1,
      w: 1.7,
      h: 0.4,
      fontFace: PPTX_FONT,
      fontSize: 11,
      bold: true,
      color: PPTX_BRAND.background,
      align: "center",
      valign: "middle",
    });
    // Optional owner / confidence pill stacked below the chip
    const subParts: string[] = [];
    if (item.owner) subParts.push(item.owner);
    if (item.confidence) subParts.push(`${item.confidence} confidence`);
    if (subParts.length > 0) {
      slide.addText(subParts.join(" · "), {
        x: chipX,
        y: y + 0.55,
        w: 1.7,
        h: 0.3,
        fontFace: PPTX_FONT,
        fontSize: 9,
        color: PPTX_BRAND.muted,
        align: "center",
        valign: "top",
      });
    }
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
