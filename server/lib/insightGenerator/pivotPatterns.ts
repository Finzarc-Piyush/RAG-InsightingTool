import type { ChartSpec } from "../../shared/schema.js";

export type PerformerRow = { x: string; y: number; share: number };

export type PivotPatterns = {
  rowCount: number;
  total: number;
  isCategoricalX: boolean;
  isTemporal: boolean;
  dualAxis: boolean;

  topPerformers: PerformerRow[];
  bottomPerformers: PerformerRow[];

  top1Share?: number;
  top3Share?: number;
  hhi?: number;

  topToBottomRatio?: number;
  p90p10Ratio?: number;
  leaderVsMedianMultiple?: number;

  mean?: number;
  median?: number;
  stdDev?: number;
  cv?: number;
  variability?: "low" | "moderate" | "high";
  iqr?: number;
  longTailCount?: number;
  longTailShare?: number;

  segmentsAboveP75: string[];
  segmentsBelowP25: string[];

  trendDirection?: "up" | "down" | "mixed" | "flat";
  recentVsPriorDelta?: number;
  peakLabel?: string;
  troughLabel?: string;

  yY2Correlation?: number;
  yY2Strength?: "weak" | "moderate" | "strong";
};

const parseNum = (v: unknown): number =>
  Number(String(v ?? "").replace(/[%,]/g, ""));

const percentile = (arr: number[], p: number): number => {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

const stdev = (arr: number[]): number => {
  if (arr.length === 0) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
  return Math.sqrt(v);
};

const pearson = (xs: number[], ys: number[]): number => {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n;
  const my = sy / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? NaN : num / den;
};

const looksTemporal = (values: unknown[]): boolean => {
  const sample = values.slice(0, 20).filter((v) => v != null);
  if (sample.length === 0) return false;
  let ok = 0;
  for (const v of sample) {
    if (v instanceof Date) { ok++; continue; }
    if (typeof v === "string") {
      // Require a separator or quarter prefix so plain numerics like "2024"
      // alone don't get classified as temporal.
      if (!/[-/: ]|^Q[1-4]\b/i.test(v)) continue;
      const t = Date.parse(v);
      if (!isNaN(t)) ok++;
    }
  }
  return ok / sample.length >= 0.6;
};

export function computePivotPatterns(
  chartData: Record<string, unknown>[],
  chartSpec: Pick<ChartSpec, "x" | "y" | "type" | "seriesKeys"> & { y2?: string }
): PivotPatterns {
  const seriesKeys =
    Array.isArray(chartSpec.seriesKeys) && chartSpec.seriesKeys.length > 0
      ? chartSpec.seriesKeys
      : null;
  const dualAxis = chartSpec.type === "line" && !!chartSpec.y2;
  const y2Var = chartSpec.y2;

  type Ranked = { label: string; value: number };
  let ranked: Ranked[];
  if (seriesKeys) {
    ranked = seriesKeys.map((k) => ({
      label: String(k),
      value: chartData.reduce(
        (s, r) => s + (Number.isFinite(parseNum(r[k])) ? parseNum(r[k]) : 0),
        0
      ),
    }));
  } else {
    ranked = chartData.map((r) => ({
      label: String(r[chartSpec.x] ?? ""),
      value: parseNum(r[chartSpec.y]),
    }));
  }
  ranked = ranked.filter((r) => Number.isFinite(r.value));

  const positiveValues = ranked.map((r) => Math.max(0, r.value));
  const total = positiveValues.reduce((s, v) => s + v, 0);
  const sortedDesc = [...ranked].sort((a, b) => b.value - a.value);
  const sortedAsc = [...ranked].sort((a, b) => a.value - b.value);

  const safeShare = (v: number): number | undefined =>
    total > 0 ? Math.max(0, v) / total : undefined;

  const topPerformers: PerformerRow[] = sortedDesc.slice(0, 3).map((r) => ({
    x: r.label,
    y: r.value,
    share: total > 0 ? Math.max(0, r.value) / total : 0,
  }));
  const bottomPerformers: PerformerRow[] = sortedAsc.slice(0, 3).map((r) => ({
    x: r.label,
    y: r.value,
    share: total > 0 ? Math.max(0, r.value) / total : 0,
  }));

  const top1Share = sortedDesc[0] ? safeShare(sortedDesc[0].value) : undefined;
  const top3Share = sortedDesc.length > 0
    ? safeShare(sortedDesc.slice(0, 3).reduce((s, r) => s + Math.max(0, r.value), 0))
    : undefined;
  const hhi = total > 0
    ? ranked.reduce((s, r) => s + (Math.max(0, r.value) / total) ** 2, 0)
    : undefined;

  const numericY = ranked.map((r) => r.value);
  const mean =
    numericY.length > 0 ? numericY.reduce((a, b) => a + b, 0) / numericY.length : undefined;
  const yP10 = percentile(numericY, 0.1);
  const yP25 = percentile(numericY, 0.25);
  const yP50 = percentile(numericY, 0.5);
  const yP75 = percentile(numericY, 0.75);
  const yP90 = percentile(numericY, 0.9);
  const sigma = stdev(numericY);
  const cv =
    mean !== undefined && mean !== 0 ? sigma / Math.abs(mean) : undefined;
  const variability: PivotPatterns["variability"] | undefined =
    cv === undefined ? undefined : cv > 0.3 ? "high" : cv > 0.15 ? "moderate" : "low";

  const top = sortedDesc[0]?.value;
  const bot = sortedAsc[0]?.value;
  const topToBottomRatio =
    typeof top === "number" && typeof bot === "number" && bot !== 0 && Number.isFinite(bot)
      ? top / Math.abs(bot)
      : undefined;
  const p90p10Ratio =
    Number.isFinite(yP10) && Number.isFinite(yP90) && yP10 !== 0
      ? yP90 / Math.abs(yP10)
      : undefined;
  const leaderVsMedianMultiple =
    Number.isFinite(yP50) && yP50 !== 0 && typeof top === "number"
      ? top / Math.abs(yP50)
      : undefined;

  const iqr = Number.isFinite(yP25) && Number.isFinite(yP75) ? yP75 - yP25 : undefined;
  const longTail = ranked.filter((r) => r.value < yP25);
  const longTailCount = longTail.length;
  const longTailShare =
    total > 0
      ? longTail.reduce((s, r) => s + Math.max(0, r.value), 0) / total
      : undefined;

  const segmentsAboveP75 = Number.isFinite(yP75)
    ? ranked
        .filter((r) => r.value >= yP75 && r.label)
        .map((r) => r.label)
        .slice(0, 6)
    : [];
  const segmentsBelowP25 = Number.isFinite(yP25)
    ? ranked
        .filter((r) => r.value <= yP25 && r.label)
        .map((r) => r.label)
        .slice(0, 6)
    : [];

  const isCategoricalX = (() => {
    if (seriesKeys) return true;
    const xs = chartData.map((r) => r[chartSpec.x]).filter((v) => v != null);
    if (xs.length === 0) return true;
    const numericCount = xs.filter((v) => Number.isFinite(parseNum(v))).length;
    return numericCount / xs.length < 0.5;
  })();

  const isTemporal =
    !seriesKeys && looksTemporal(chartData.map((r) => r[chartSpec.x]));

  let trendDirection: PivotPatterns["trendDirection"];
  let recentVsPriorDelta: number | undefined;
  let peakLabel: string | undefined;
  let troughLabel: string | undefined;

  if (isTemporal) {
    const tRows = chartData
      .map((r) => {
        const xVal = r[chartSpec.x];
        const t = xVal instanceof Date ? xVal.getTime() : Date.parse(String(xVal));
        return {
          label: String(xVal ?? ""),
          t,
          y: parseNum(r[chartSpec.y]),
        };
      })
      .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.y))
      .sort((a, b) => a.t - b.t);

    if (tRows.length >= 4) {
      const window = Math.max(1, Math.floor(tRows.length / 3));
      const recent = tRows.slice(-window);
      const prior = tRows.slice(-window * 2, -window);
      const recentAvg = recent.reduce((s, r) => s + r.y, 0) / recent.length;
      const priorAvg =
        prior.length > 0 ? prior.reduce((s, r) => s + r.y, 0) / prior.length : NaN;
      if (Number.isFinite(priorAvg) && priorAvg !== 0) {
        recentVsPriorDelta = (recentAvg - priorAvg) / Math.abs(priorAvg);
      }

      let up = 0;
      let down = 0;
      for (let i = 1; i < tRows.length; i++) {
        if (tRows[i].y > tRows[i - 1].y) up++;
        else if (tRows[i].y < tRows[i - 1].y) down++;
      }
      const swings = up + down;
      if (swings > 0) {
        const upShare = up / swings;
        const flatDelta =
          Number.isFinite(priorAvg) && priorAvg !== 0
            ? Math.abs((recentAvg - priorAvg) / priorAvg)
            : Infinity;
        if (upShare >= 0.7) trendDirection = "up";
        else if (upShare <= 0.3) trendDirection = "down";
        else if (flatDelta < 0.05) trendDirection = "flat";
        else trendDirection = "mixed";
      }

      const peak = tRows.reduce((a, b) => (b.y > a.y ? b : a));
      const trough = tRows.reduce((a, b) => (b.y < a.y ? b : a));
      peakLabel = peak.label;
      troughLabel = trough.label;
    }
  }

  let yY2Correlation: number | undefined;
  let yY2Strength: PivotPatterns["yY2Strength"];
  if (dualAxis && y2Var) {
    const ys: number[] = [];
    const y2s: number[] = [];
    for (const r of chartData) {
      const v1 = parseNum(r[chartSpec.y]);
      const v2 = parseNum(r[y2Var]);
      if (Number.isFinite(v1) && Number.isFinite(v2)) {
        ys.push(v1);
        y2s.push(v2);
      }
    }
    const r = pearson(ys, y2s);
    if (!isNaN(r)) {
      yY2Correlation = r;
      const a = Math.abs(r);
      yY2Strength = a > 0.7 ? "strong" : a > 0.4 ? "moderate" : "weak";
    }
  }

  return {
    rowCount: chartData.length,
    total,
    isCategoricalX,
    isTemporal,
    dualAxis,
    topPerformers,
    bottomPerformers,
    top1Share,
    top3Share,
    hhi,
    topToBottomRatio,
    p90p10Ratio,
    leaderVsMedianMultiple,
    mean,
    median: Number.isFinite(yP50) ? yP50 : undefined,
    stdDev: sigma,
    cv,
    variability,
    iqr,
    longTailCount,
    longTailShare,
    segmentsAboveP75,
    segmentsBelowP25,
    trendDirection,
    recentVsPriorDelta,
    peakLabel,
    troughLabel,
    yY2Correlation,
    yY2Strength,
  };
}

const fmtPct = (v: number | undefined, digits = 0): string =>
  v === undefined || !Number.isFinite(v) ? "N/A" : `${(v * 100).toFixed(digits)}%`;
const fmtNum = (v: number | undefined, digits = 2): string =>
  v === undefined || !Number.isFinite(v) ? "N/A" : v.toFixed(digits);

export function renderPivotPatternsBlock(
  p: PivotPatterns,
  formatY: (n: number) => string
): string {
  const lines: string[] = [];
  lines.push(
    "PIVOT PATTERNS (use these to find drivers, risks, and gaps — do NOT default to the formulaic 'leader-vs-laggard' pattern):"
  );

  if (p.top1Share !== undefined && p.top3Share !== undefined && p.hhi !== undefined) {
    const concentrationLabel =
      p.hhi > 0.25 ? "concentrated" : p.hhi < 0.1 ? "spread out" : "moderately concentrated";
    lines.push(
      `- Concentration (${concentrationLabel}): top segment ${fmtPct(p.top1Share)} of total; top three ${fmtPct(p.top3Share)}`
    );
  }
  const gapParts: string[] = [];
  if (p.topToBottomRatio !== undefined && Number.isFinite(p.topToBottomRatio))
    gapParts.push(`top is ${fmtNum(p.topToBottomRatio, 1)}× the bottom`);
  if (p.leaderVsMedianMultiple !== undefined && Number.isFinite(p.leaderVsMedianMultiple))
    gapParts.push(`leader is ${fmtNum(p.leaderVsMedianMultiple, 1)}× the typical segment`);
  if (gapParts.length > 0) lines.push(`- Gap: ${gapParts.join(", ")}`);

  if (p.cv !== undefined) {
    const variabilityLabel =
      p.variability === "high" ? "varies a lot" : p.variability === "low" ? "fairly stable" : "moderately variable";
    const cvParts: string[] = [`${variabilityLabel}`];
    if (p.longTailCount !== undefined && p.longTailShare !== undefined && p.longTailCount > 0) {
      cvParts.push(
        `${p.longTailCount} smaller segment${p.longTailCount === 1 ? "" : "s"} contribute only ${fmtPct(p.longTailShare)}`
      );
    }
    lines.push(`- Spread: ${cvParts.join("; ")}`);
  }

  if (p.segmentsAboveP75.length > 0 || p.segmentsBelowP25.length > 0) {
    const segParts: string[] = [];
    if (p.segmentsAboveP75.length > 0)
      segParts.push(`top quartile → ${p.segmentsAboveP75.join(", ")}`);
    if (p.segmentsBelowP25.length > 0)
      segParts.push(`bottom quartile → ${p.segmentsBelowP25.join(", ")}`);
    lines.push(`- Segments: ${segParts.join("; ")}`);
  }

  if (p.isTemporal) {
    const tParts: string[] = [];
    if (p.trendDirection) tParts.push(`direction ${p.trendDirection}`);
    if (p.recentVsPriorDelta !== undefined && Number.isFinite(p.recentVsPriorDelta)) {
      const sign = p.recentVsPriorDelta >= 0 ? "+" : "";
      tParts.push(`recent vs prior ${sign}${(p.recentVsPriorDelta * 100).toFixed(1)}%`);
    }
    if (p.peakLabel) tParts.push(`peak ${p.peakLabel}`);
    if (p.troughLabel) tParts.push(`trough ${p.troughLabel}`);
    if (tParts.length > 0) lines.push(`- Temporal: ${tParts.join(", ")}`);
  }

  if (p.dualAxis && p.yY2Correlation !== undefined) {
    lines.push(
      `- Dual-axis: Y vs Y2 correlation r=${fmtNum(p.yY2Correlation, 2)} (${p.yY2Strength})`
    );
  }

  return lines.length > 1 ? lines.join("\n") : "";
}
