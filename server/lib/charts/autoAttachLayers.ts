/**
 * WC7 · server-side auto-layer attachment.
 *
 * Given a chart spec (v1) and the user's question, infer analytical
 * layers the user almost certainly wants and attach them via the
 * `_autoLayers` escape hatch on the v1 spec. The client `<ChartShim>`
 * v1→v2 converter forwards these into `ChartSpecV2.layers`.
 *
 * Pure heuristic — uses simple regex on the question text. The agent
 * pipeline can override or augment by setting `_autoLayers` directly.
 */

import type { ChartSpec } from "../../shared/schema.js";

// Fix-2 · target detection uses a two-step approach so "above the $100
// target" matches as well as "target of $100":
//   1. require a target/goal/threshold keyword anywhere in the question
//   2. find a currency-prefixed or magnitude-suffixed number anywhere
const TARGET_KEYWORD_RE =
  /\b(target|goal|threshold|benchmark|quota|budget|sla)\b/i;
// Currency-prefixed: $100, ₹2.5K, £1M, etc.
const TARGET_NUMBER_CURRENCY_RE =
  /(\$|₹|£|€)\s*([0-9][0-9.,]*(?:[kKmMbBtT])?)\b/;
// Magnitude-suffixed: 100K, 2.5M, 1B (no currency required because
// the suffix itself signals "this is a quantity").
const TARGET_NUMBER_SUFFIX_RE = /\b([0-9][0-9.,]*[kKmMbBtT])\b/;
const TREND_RE =
  /\b(trend\w*|trajector\w+|slope|grow\w+|declin\w+|project\w+|forecast\w*|outlook|extrapolat\w+|next\s+(?:\d+\s+)?(?:weeks?|months?|quarters?|years?))\b/i;
// Fix-2 · `dip(?:s|ped|ping)?` instead of `dip\w*` — avoids "diplomat",
// "diploma", "diphenyl".
const OUTLIER_RE =
  /\b(outlier\w*|anomal\w+|spike\w*|surge\w*|dip(?:s|ped|ping)?|unusual|exceptional)\b/i;
const COMPARE_RE =
  /\b(vs|versus|compared|year[- ]over[- ]year|yoy|qoq|month over month|mom|prior period|previous period|same period last)\b/i;

// Fix-2 · Reference-line layer is meaningful ONLY for 1-D-magnitude marks
// with a y axis. Heatmap, treemap, sankey, sunburst, radar, gauge, etc.
// have no horizontal y-line concept — gating here prevents nonsense.
const MARK_ALLOW_REFLINE = new Set<ChartSpec["type"]>([
  "line",
  "area",
  "bar",
  "scatter",
]);

/** Cap input regex length to mitigate worst-case backtracking. */
const MAX_QUESTION_LENGTH = 4000;

function autoAttachEnabled(): boolean {
  // Default true; explicit "false" or "0" disables. Lets ops kill the
  // feature globally if regex misfires in production.
  const v = process.env.AUTO_ATTACH_LAYERS_ENABLED;
  return v !== "false" && v !== "0";
}

function parseNumberWithSuffix(raw: string): number | null {
  if (!raw) return null;
  const trimmed = raw.replace(/[,\s]/g, "");
  const m = trimmed.match(/^(-?[0-9]*\.?[0-9]+)([kmbtKMBT]?)$/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  const mult =
    suffix === "k" ? 1e3
      : suffix === "m" ? 1e6
        : suffix === "b" ? 1e9
          : suffix === "t" ? 1e12
            : 1;
  return base * mult;
}

export type AutoLayer = NonNullable<ChartSpec["_autoLayers"]>[number];

/**
 * Returns a list of auto-detected layers for a chart given a question.
 * Returns an empty array when nothing applies. Caller is responsible
 * for assigning to `chart._autoLayers`.
 */
export function inferAutoLayers(
  chart: ChartSpec,
  question: string,
): AutoLayer[] {
  const out: AutoLayer[] = [];
  if (!question) return out;
  // Cap input size so worst-case regex backtracking stays bounded.
  const q = question.length > MAX_QUESTION_LENGTH
    ? question.slice(0, MAX_QUESTION_LENGTH)
    : question;

  const isTimeMark =
    chart.type === "line" ||
    chart.type === "area" ||
    chart.type === "scatter";

  // Target reference line (gated on chart type — Fix-2). Requires a target
  // keyword AND a currency-prefixed or suffix-marked number, so plain
  // "100 customers" doesn't trigger.
  if (MARK_ALLOW_REFLINE.has(chart.type) && TARGET_KEYWORD_RE.test(q)) {
    const cm = q.match(TARGET_NUMBER_CURRENCY_RE);
    const sm = cm ? null : q.match(TARGET_NUMBER_SUFFIX_RE);
    let symbol = "";
    let magnitude = "";
    if (cm) {
      symbol = cm[1] ?? "";
      magnitude = cm[2] ?? "";
    } else if (sm) {
      magnitude = sm[1] ?? "";
    }
    if (magnitude) {
      const num = parseNumberWithSuffix(magnitude);
      if (num !== null) {
        out.push({
          type: "reference-line",
          on: "y",
          value: num,
          label: `Target: ${symbol}${magnitude}`,
        });
      }
    }
  }

  // Trend / forecast on time series.
  if (isTimeMark && TREND_RE.test(q)) {
    out.push({ type: "trend", on: "y", method: "linear" });
    // If forecast/projection hinted explicitly, add a 4-period band.
    if (/\b(forecast|projection|next|future|outlook|extrapolat\w+)\b/i.test(q)) {
      out.push({
        type: "forecast",
        on: "y",
        horizon: 4,
        method: "linear",
        ci: 0.95,
      });
    }
  }

  // Outliers / anomalies.
  if (isTimeMark && OUTLIER_RE.test(q)) {
    out.push({ type: "outliers", threshold: 2, style: "callout" });
  }

  // Comparison overlay (prior period).
  if (isTimeMark && COMPARE_RE.test(q)) {
    out.push({ type: "comparison", against: "prior-period", style: "faded" });
  }

  return out;
}

/**
 * Attach auto-layers in place. Idempotent: existing _autoLayers are
 * preserved (server- or agent-attached layers take priority).
 *
 * Globally disabled when AUTO_ATTACH_LAYERS_ENABLED=false (Fix-2 kill
 * switch) — useful if regex misfires in production.
 */
export function attachAutoLayers(
  chart: ChartSpec,
  question: string,
): ChartSpec {
  if (!autoAttachEnabled()) return chart;
  if (chart._autoLayers && chart._autoLayers.length > 0) return chart;
  const inferred = inferAutoLayers(chart, question);
  if (inferred.length === 0) return chart;
  return { ...chart, _autoLayers: inferred };
}
