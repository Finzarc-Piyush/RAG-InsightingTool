/**
 * KpiRow layout — the "three numbers ARE the story" slide.
 *
 * Action title + 2–5 equal KPI cards (addCard, white fill + shadow, left rail
 * coloured by confidence: high→primary, medium→accent, low→muted). The tile
 * band is vertically CENTRED between the title baseline and the content bottom
 * so the row never strands near the top. Per card: a muted eyebrow label, the
 * big pre-formatted value (centred, shrink-to-fit, never wraps), and — when a
 * delta is present — a small soft chip carrying `deltaWithArrow` in its
 * direction colour.
 *
 * Values are pre-formatted upstream; the renderer never reformats them. All
 * sizing is derived from the tile count so 2-tile and 5-tile rows both compose
 * cleanly with one 0.3in gutter and no overflow below the footer.
 */
import {
  CONTENT_BOX,
  MASTER_NAME,
  PPTX_BRAND,
  PPTX_FONT,
  PPTX_TYPE,
  addCard,
  chip,
  deltaColor,
  deltaWithArrow,
  eyebrow,
  renderActionTitle,
  attachSpeakerNotes,
} from "../master.js";
import type { PptxPres, PptxSlide } from "../types.js";
import type { SlideSpec } from "../../../../shared/exportSchema.js";

/** Left-rail colour keyed to the KPI's stated confidence. */
function confidenceRail(conf: "low" | "medium" | "high" | undefined): string {
  if (conf === "high") return PPTX_BRAND.primary;
  if (conf === "medium") return PPTX_BRAND.accent;
  if (conf === "low") return PPTX_BRAND.muted;
  return PPTX_BRAND.primary; // unstated reads as a confident headline number
}

export function renderKpiRow(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "KpiRow" }>
): void {
  const slide: PptxSlide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  const top = renderActionTitle(slide, spec.actionTitle);

  const kpis = spec.slots.kpis;
  const count = Math.max(1, kpis.length);
  const contentBottom = CONTENT_BOX.y + CONTENT_BOX.h; // 6.98 — keep clear of footer

  // Tile band: tall, but capped so it sits comfortably above the footer, then
  // centred between the title baseline and ~6.8in so it never strands up top.
  const bandTop = top + 0.1;
  const bandBottom = Math.min(contentBottom - 0.18, 6.8);
  const bandH = bandBottom - bandTop;
  const tileH = Math.max(1.8, Math.min(3.1, bandH));
  const tileY = bandTop + Math.max(0, (bandH - tileH) / 2); // vertical centring

  const gutter = 0.3;
  const tileW = (CONTENT_BOX.w - (count - 1) * gutter) / count;

  // Inner geometry, scaled gently so wider tiles (few KPIs) breathe more.
  const pad = Math.min(0.34, Math.max(0.22, tileW * 0.07));
  const railInset = 0.12; // clear of the addCard left accent rail (~0.07 + margin)
  const innerX = (x: number) => x + railInset;
  const innerW = tileW - railInset - pad;

  const deltaChipH = 0.36;
  const labelH = 0.34;
  const valueH = Math.max(0.9, tileH - labelH - deltaChipH - pad * 2 - 0.18);

  kpis.forEach((kpi, i) => {
    const x = CONTENT_BOX.x + i * (tileW + gutter);

    addCard(
      slide,
      { x, y: tileY, w: tileW, h: tileH },
      { fill: PPTX_BRAND.background, shadow: true, accent: confidenceRail(kpi.confidence) }
    );

    // Eyebrow label — muted, top of the card.
    eyebrow(
      slide,
      { x: innerX(x), y: tileY + pad, w: innerW, h: labelH },
      kpi.label,
      { color: PPTX_BRAND.muted, align: "center" }
    );

    // Big value — centred, bold, shrink-to-fit, single line (never wraps).
    slide.addText(kpi.value, {
      x: innerX(x),
      y: tileY + pad + labelH,
      w: innerW,
      h: valueH,
      fontFace: PPTX_FONT,
      fontSize: PPTX_TYPE.kpiValue,
      bold: true,
      color: PPTX_BRAND.foreground,
      align: "center",
      valign: "middle",
      wrap: false,
      fit: "shrink",
    });

    // Delta — emphasised inside a soft chip, centred under the value.
    if (kpi.delta && kpi.delta.trim()) {
      const label = deltaWithArrow(kpi.delta);
      const color = deltaColor(kpi.delta);
      const chipW = Math.min(innerW, Math.max(1.0, label.length * 0.085 + 0.4));
      chip(
        slide,
        {
          x: innerX(x) + (innerW - chipW) / 2,
          y: tileY + tileH - pad - deltaChipH,
          w: chipW,
          h: deltaChipH,
        },
        label,
        color,
        { fontSize: PPTX_TYPE.kpiDelta, align: "center" }
      );
    }
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}
