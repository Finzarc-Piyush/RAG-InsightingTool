/**
 * Per-mark feature flags for the chart v2 migration.
 *
 * Each existing v1 mark (bar, line, area, scatter, pie, heatmap) defaults
 * `false` — meaning the legacy ChartRenderer is still used. As each v2
 * renderer reaches parity (see docs/architecture/charting.md §2 checklist)
 * its flag flips to `true`. Two consecutive weeks with zero flips is the
 * gate for deleting the legacy renderer in wave WC9.4.
 *
 * Flag resolution order (first match wins):
 *   1. Vite build-time env: VITE_USE_PREMIUM_<TYPE>=true|false
 *   2. Runtime override in localStorage: chart.premium.<type>=true|false
 *      (useful for dev / QA without rebuilding)
 *   3. Compile-time default in DEFAULT_FLAGS below.
 *
 * The localStorage override is intentionally global, not per-message:
 * it's a debugging knob, not a user preference.
 */

export const V1_CHART_TYPES = [
  "bar",
  "line",
  "area",
  "scatter",
  "pie",
  "heatmap",
] as const;
export type ChartV1Type = (typeof V1_CHART_TYPES)[number];

/**
 * V2 mark catalog (informational; not flag-gated individually because
 * net-new marks have no legacy counterpart to flip back to).
 */
export const V2_MARKS = [
  // visx (primary, non-lazy)
  "point",
  "line",
  "area",
  "bar",
  "arc",
  "rect",
  "rule",
  "text",
  "box",
  "errorbar",
  "regression",
  "combo",
  "waterfall",
  "funnel",
  "bubble",
  "radar",
  // echarts (lazy specialty bundles)
  "treemap",
  "sunburst",
  "sankey",
  "parallel",
  "calendar",
  "choropleth",
  "candlestick",
  "gauge",
  "kpi",
] as const;
export type ChartV2Mark = (typeof V2_MARKS)[number];

/**
 * Marks that ship via lazy-loaded ECharts bundles (separate code split).
 * Exported so PremiumChart can dispatch to the correct renderer family.
 */
export const ECHARTS_MARKS = new Set<ChartV2Mark>([
  "treemap",
  "sunburst",
  "sankey",
  "parallel",
  "calendar",
  "choropleth",
  "candlestick",
  "gauge",
  "kpi",
]);

const DEFAULT_FLAGS: Record<ChartV1Type, boolean> = {
  bar: false,
  line: false,
  area: false,
  scatter: false,
  pie: false,
  heatmap: false,
};

const LS_PREFIX = "chart.premium.";

function readEnv(type: ChartV1Type): boolean | null {
  const key = `VITE_USE_PREMIUM_${type.toUpperCase()}`;
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const raw = env?.[key];
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function readLocalStorage(type: ChartV1Type): boolean | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(`${LS_PREFIX}${type}`);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    /* localStorage may throw in privacy modes; fall through */
  }
  return null;
}

/**
 * Resolve whether the v2 (Visx) renderer should be used for a v1 chart type.
 * Pure function — safe to call from render paths.
 */
export function isPremiumChartEnabled(type: ChartV1Type): boolean {
  const env = readEnv(type);
  if (env !== null) return env;
  const ls = readLocalStorage(type);
  if (ls !== null) return ls;
  return DEFAULT_FLAGS[type];
}

/**
 * Dev-only: flip the flag at runtime via localStorage. Survives reload.
 * Returns the new effective value.
 */
export function setPremiumChartFlag(
  type: ChartV1Type,
  enabled: boolean | null,
): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return DEFAULT_FLAGS[type];
  }
  const key = `${LS_PREFIX}${type}`;
  if (enabled === null) {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, String(enabled));
  }
  return isPremiumChartEnabled(type);
}

/**
 * Snapshot of every flag's effective value. Useful for debug overlays
 * and parity-gallery test harnesses.
 */
export function getAllPremiumChartFlags(): Record<ChartV1Type, boolean> {
  const out = {} as Record<ChartV1Type, boolean>;
  for (const t of V1_CHART_TYPES) {
    out[t] = isPremiumChartEnabled(t);
  }
  return out;
}

/**
 * True when at least one v1 type is using the v2 renderer. Lets the
 * legacy ChartRenderer skip work it no longer needs to do.
 */
export function anyPremiumChartEnabled(): boolean {
  return V1_CHART_TYPES.some((t) => isPremiumChartEnabled(t));
}
