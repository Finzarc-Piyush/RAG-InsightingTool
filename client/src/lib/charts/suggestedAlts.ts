/**
 * Suggested-alternatives heuristic recommender. WC2.5.
 *
 * Returns up to 3 alternative marks ONLY when the current chart
 * violates a heuristic (12+ pie slices, line over categorical x,
 * scatter without numeric y, etc.). Returns an empty array when the
 * current mark is appropriate — the UI hides the panel in that case,
 * so we don't add Tableau-style "Show Me" noise on every chart.
 *
 * Pure functions. No DOM. Replaces / supersedes the v1 logic in
 * client/src/lib/pivot/chartRecommendation.ts in the long run; for
 * now it's used by ChartCanvas only.
 */

import type { ChartEncoding, ChartV2Mark } from "@/shared/schema";
import { asString } from "./encodingResolver";
import type { Row } from "./encodingResolver";

export interface Suggestion {
  mark: ChartV2Mark;
  reason: string;
}

export interface SuggestionsInput {
  mark: ChartV2Mark;
  encoding: ChartEncoding;
  data: Row[];
}

export interface ChartShapeStats {
  rowCount: number;
  /** Distinct count for x; undefined when no x encoding. */
  xCardinality?: number;
  /** Distinct count for color. */
  colorCardinality?: number;
  /** True when y has any negative values. */
  yHasNegatives?: boolean;
  /** True when x is categorical (n / o). */
  xIsCategorical?: boolean;
  /** True when x is temporal. */
  xIsTemporal?: boolean;
}

export function computeShapeStats(input: SuggestionsInput): ChartShapeStats {
  const { encoding, data } = input;
  const stats: ChartShapeStats = { rowCount: data.length };

  if (encoding.x) {
    const distinct = new Set(data.map((r) => asString(r[encoding.x!.field])));
    stats.xCardinality = distinct.size;
    stats.xIsCategorical = encoding.x.type === "n" || encoding.x.type === "o";
    stats.xIsTemporal = encoding.x.type === "t";
  }
  if (encoding.color) {
    const distinct = new Set(
      data.map((r) => asString(r[encoding.color!.field])),
    );
    stats.colorCardinality = distinct.size;
  }
  if (encoding.y) {
    let neg = false;
    for (const r of data) {
      const v = Number(r[encoding.y.field]);
      if (Number.isFinite(v) && v < 0) {
        neg = true;
        break;
      }
    }
    stats.yHasNegatives = neg;
  }

  return stats;
}

const PIE_SLICE_LIMIT = 12;
const BAR_CATEGORY_LIMIT = 50;
const HEATMAP_MIN_CELLS = 8;

export function suggestAlternatives(input: SuggestionsInput): Suggestion[] {
  const stats = computeShapeStats(input);
  const out: Suggestion[] = [];
  const { mark, encoding } = input;

  // Pie / arc with too many slices → bar / treemap.
  if (mark === "arc" && (stats.xCardinality ?? 0) > PIE_SLICE_LIMIT) {
    out.push({
      mark: "bar",
      reason: `${stats.xCardinality} slices is too many to read at a glance — bars rank cleanly.`,
    });
    out.push({
      mark: "treemap",
      reason: "Treemap shows proportional area without label overlap.",
    });
  }

  // Pie with negative values → waterfall.
  if (mark === "arc" && stats.yHasNegatives) {
    out.push({
      mark: "waterfall",
      reason: "Pie can't represent negative values — waterfall shows the bridge.",
    });
  }

  // Bar with too many categories → treemap.
  if (mark === "bar" && (stats.xCardinality ?? 0) > BAR_CATEGORY_LIMIT) {
    out.push({
      mark: "treemap",
      reason: `${stats.xCardinality} bars are unreadable — treemap is denser.`,
    });
  }

  // Line over categorical x → bar (lines imply continuity).
  if (mark === "line" && stats.xIsCategorical && !stats.xIsTemporal) {
    out.push({
      mark: "bar",
      reason: "Line implies temporal continuity. Use bar for categories.",
    });
  }

  // Scatter without quantitative y → bar.
  if (
    mark === "point" &&
    encoding.y?.type !== "q"
  ) {
    out.push({
      mark: "bar",
      reason: "Scatter needs a quantitative y. Bar fits this shape better.",
    });
  }

  // Heatmap with few cells → bar.
  if (mark === "rect") {
    const yField = encoding.y?.field;
    const cells =
      (stats.xCardinality ?? 0) *
      (yField
        ? new Set(input.data.map((r) => asString(r[yField]))).size
        : 0);
    if (cells > 0 && cells < HEATMAP_MIN_CELLS) {
      out.push({
        mark: "bar",
        reason: "Too few cells for a heatmap — bar shows magnitudes more directly.",
      });
    }
  }

  // Multi-series stacked bar with too many series → 100% normalized + treemap.
  if (
    (mark === "bar" || mark === "area") &&
    (stats.colorCardinality ?? 0) > PIE_SLICE_LIMIT
  ) {
    out.push({
      mark: "treemap",
      reason: `${stats.colorCardinality} stacked series is hard to compare — treemap groups them visually.`,
    });
  }

  // Trend question with single point → bar.
  if (
    (mark === "line" || mark === "area") &&
    stats.rowCount > 0 &&
    (stats.xCardinality ?? 0) <= 2
  ) {
    out.push({
      mark: "bar",
      reason: "Lines need at least 3 points to show trend; bar reads cleaner here.",
    });
  }

  // Cap at 3 distinct alternatives (preserve insertion order).
  const seen = new Set<ChartV2Mark>();
  const ranked: Suggestion[] = [];
  for (const s of out) {
    if (seen.has(s.mark)) continue;
    if (s.mark === mark) continue; // never suggest the same mark
    seen.add(s.mark);
    ranked.push(s);
    if (ranked.length >= 3) break;
  }
  return ranked;
}
