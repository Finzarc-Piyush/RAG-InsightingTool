/**
 * Auto-generated screen-reader summary for a chart. WC8.3.
 *
 * Builds a single short paragraph from a v2 spec + resolved rows that
 * a screen reader can announce instead of just "image". Stays factual
 * and concise — no narrative interpretation, just shape + extrema.
 */

import type { ChartSpecV2 } from "@/shared/schema";
import { aggregate } from "./dataEngine";
import { asNumber, asString, type Row } from "./encodingResolver";
import { formatKMB } from "./format";

const MARK_LABEL: Record<ChartSpecV2["mark"], string> = {
  point: "Scatter chart",
  line: "Line chart",
  area: "Area chart",
  bar: "Bar chart",
  arc: "Pie chart",
  rect: "Heatmap",
  rule: "Reference line",
  text: "Text annotation",
  box: "Boxplot",
  errorbar: "Error-bar chart",
  regression: "Scatter chart with trend line",
  combo: "Combo bar-and-line chart",
  waterfall: "Waterfall chart",
  funnel: "Funnel chart",
  bubble: "Bubble chart",
  radar: "Radar chart",
  treemap: "Treemap",
  sunburst: "Sunburst chart",
  sankey: "Sankey diagram",
  parallel: "Parallel coordinates chart",
  calendar: "Calendar heatmap",
  choropleth: "Geographic chart",
  candlestick: "Candlestick chart",
  gauge: "Gauge",
  kpi: "KPI tile",
};

const MAX_DESC_LEN = 280;

// Spoken numbers go through the SAME compact formatter the visx renderers use
// (formatKMB) so the screen-reader description matches the on-screen label
// exactly — this used to be a private K/M/B copy that drifted (e.g. "15.0K" vs
// the rendered "15K"). Non-finite stays "n/a" for clearer speech than "—".
function format(v: number): string {
  return Number.isFinite(v) ? formatKMB(v) : "n/a";
}

export function chartA11ySummary(
  spec: ChartSpecV2,
  data: Row[],
): string {
  const markLabel = MARK_LABEL[spec.mark] ?? "Chart";
  const titlePart = spec.config?.title?.text
    ? `: ${spec.config.title.text}`
    : "";
  const xField = spec.encoding.x?.field;
  const yField = spec.encoding.y?.field;
  const colorField = spec.encoding.color?.field;

  // Audit fix: bar marks now expose orientation + layout that change
  // visual interpretation. Surface both in the screen-reader summary.
  const orientationPart =
    spec.mark === "bar" && spec.config?.barOrientation === "horizontal"
      ? " (horizontal)"
      : "";
  const layoutPart =
    spec.mark === "bar" && spec.config?.barLayout
      ? `, ${spec.config.barLayout} layout`
      : "";

  const parts: string[] = [`${markLabel}${orientationPart}${layoutPart}${titlePart}.`];

  // Dimensions sentence.
  const dims: string[] = [];
  if (xField) dims.push(`X axis: ${xField}`);
  if (yField) dims.push(`Y axis: ${yField}`);
  if (colorField) dims.push(`color: ${colorField}`);
  if (dims.length > 0) parts.push(dims.join("; ") + ".");

  // Extrema sentence (only when y is quantitative and x is categorical).
  if (yField && data.length > 0) {
    const yValues = data
      .map((r) => asNumber(r[yField]))
      .filter((v) => Number.isFinite(v));
    if (yValues.length > 0) {
      const min = aggregate(yValues, "min");
      const max = aggregate(yValues, "max");
      const mean = aggregate(yValues, "mean");
      // Find which X categories hold the extremes.
      let highX: string | null = null;
      let lowX: string | null = null;
      let highVal = -Infinity;
      let lowVal = Infinity;
      for (const r of data) {
        const v = asNumber(r[yField]);
        if (!Number.isFinite(v)) continue;
        if (v > highVal) {
          highVal = v;
          highX = xField ? asString(r[xField]) : null;
        }
        if (v < lowVal) {
          lowVal = v;
          lowX = xField ? asString(r[xField]) : null;
        }
      }
      const range =
        highX && lowX && highX !== lowX
          ? `Highest: ${highX} at ${format(max)}; lowest: ${lowX} at ${format(min)}`
          : `Range: ${format(min)} to ${format(max)}`;
      parts.push(`${range}; mean ${format(mean)}.`);
      parts.push(`${data.length} data points.`);
    }
  } else if (data.length > 0) {
    parts.push(`${data.length} data points.`);
  }

  const out = parts.join(" ");
  return out.length > MAX_DESC_LEN
    ? out.slice(0, MAX_DESC_LEN - 1) + "…"
    : out;
}
