/**
 * W-EXP-5 · KpiRow layout.
 *
 * Action title + 2–5 KPI tiles in a row. Each tile: a small label, a big
 * pre-formatted value, and an optional delta line. No charts — KpiRow
 * exists for the moment when 3 numbers are the whole story.
 *
 * Tile width is computed from CONTENT_BOX so 2-tile and 5-tile rows both
 * fill the slide cleanly.
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

export function renderKpiRow(
  pres: PptxPres,
  spec: Extract<SlideSpec, { layout: "KpiRow" }>
): void {
  const slide = pres.addSlide({ masterName: MASTER_NAME });
  slide.background = { color: PPTX_BRAND.background };

  renderActionTitle(slide, spec.actionTitle);

  const kpis = spec.slots.kpis;
  const gutter = 0.3;
  const totalGutters = (kpis.length - 1) * gutter;
  const tileW = (CONTENT_BOX.w - totalGutters) / kpis.length;
  const tileY = CONTENT_BOX.y + 1.1;
  const tileH = 2.6;

  kpis.forEach((kpi, i) => {
    const x = CONTENT_BOX.x + i * (tileW + gutter);
    // Tile background — soft accent with a left bar.
    slide.addShape("rect", {
      x,
      y: tileY,
      w: tileW,
      h: tileH,
      fill: { color: "F8FAFC" }, // slate-50
      line: { color: PPTX_BRAND.border, width: 0.5 },
    });
    slide.addShape("rect", {
      x,
      y: tileY,
      w: 0.08,
      h: tileH,
      fill: { color: confidenceColor(kpi.confidence) },
      line: { color: confidenceColor(kpi.confidence) },
    });
    // Label
    slide.addText(kpi.label, {
      x: x + 0.25,
      y: tileY + 0.2,
      w: tileW - 0.4,
      h: 0.35,
      fontFace: PPTX_FONT,
      fontSize: 12,
      color: PPTX_BRAND.muted,
      align: "left",
      valign: "top",
    });
    // Value (big)
    slide.addText(kpi.value, {
      x: x + 0.25,
      y: tileY + 0.55,
      w: tileW - 0.4,
      h: 1.2,
      fontFace: PPTX_FONT,
      fontSize: 38,
      bold: true,
      color: PPTX_BRAND.foreground,
      align: "left",
      valign: "middle",
    });
    // Delta (optional)
    if (kpi.delta) {
      slide.addText(kpi.delta, {
        x: x + 0.25,
        y: tileY + 1.85,
        w: tileW - 0.4,
        h: 0.4,
        fontFace: PPTX_FONT,
        fontSize: 13,
        color: deltaColor(kpi.delta),
        align: "left",
        valign: "top",
      });
    }
  });

  attachSpeakerNotes(slide, spec.speakerNotes);
}

function confidenceColor(conf: "low" | "medium" | "high" | undefined): string {
  if (conf === "high") return PPTX_BRAND.primary;
  if (conf === "medium") return PPTX_BRAND.accent;
  if (conf === "low") return PPTX_BRAND.muted;
  return PPTX_BRAND.primary;
}

function deltaColor(delta: string): string {
  // Green when the delta starts with `+`, red with `-`/`−`, muted otherwise.
  if (/^\s*\+/.test(delta)) return PPTX_BRAND.horizonStrategic;
  if (/^\s*[-−]/.test(delta)) return PPTX_BRAND.horizonNow;
  return PPTX_BRAND.muted;
}
