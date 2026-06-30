import { ChartSpec, DataSummary, Insight } from '../shared/schema.js';
import { callLlm } from './agents/runtime/callLlm.js';
import { LLM_PURPOSE } from './agents/runtime/llmCallPurpose.js';
import { formatCompactNumber } from './formatCompactNumber.js';
import type { ChartInsightSynthesisContext } from './insightSynthesis/types.js';
import { formatSessionAnalysisContextForInsight } from './insightSynthesis/formatSessionContext.js';
import { getInsightModel, getInsightTemperature } from './insightSynthesis/insightModelConfig.js';
import { computePivotPatterns, renderPivotPatternsBlock } from './insightGenerator/pivotPatterns.js';
import { deriveWeekdayPattern } from './insightGenerator/weekdayPattern.js';
import { buildPatternDrivenFallbackShort } from './insightGenerator/deterministicNarratives.js';
import { hasHedge, STAT_NUMBER_RE } from './agents/runtime/verifierCausalCheck.js';
import { splitChartInsightLanes, joinChartInsightLanes, stripDashboardMetaAdviceDoLane } from '../shared/chartInsightLanes.js';
import { logger } from "./logger.js";

/**
 * Break a single-paragraph keyInsight into one line per sentence so the UI
 * (MarkdownRenderer maps "\n" → <br>) renders skimable line breaks. Splits
 * after `.`, `!`, `?` only when followed by an uppercase letter or `(`, so
 * abbreviations like "vs. Y" or decimals like "0.5" are not split.
 */
function insertSentenceBreaks(s: string): string {
  return s.replace(/([.!?])\s+(?=[A-Z(])/g, '$1\n\n');
}

// keyInsight: grounded numbers + LLM interpretation, now manager-grade and
// SHORT — up to 3 lanes (HEADLINE / optional hedged WHY: / optional DO:),
// emitted via the shared WHY:/DO: wire format. 550 chars comfortably fits three
// tight lanes; the old 2200 produced the "wall of text nobody reads" managers
// complained about. `enforceInsightLimit`/`truncateInsight`/the prompt all read
// this constant — never hardcode the number elsewhere.
const KEY_INSIGHT_MAX_CHARS = 550;

/**
 * Pick the dimension name to use when narrating "top performers". For multi-series charts
 * (e.g. a pivot with column dimension Category), top performers are series labels — values
 * of `chartSpec.seriesColumn`, NOT of `chartSpec.x`. This keeps prompt text and the
 * deterministic fallback from calling a Category value a "Region".
 */
export function resolveTopPerfDimension(
  chartSpec: Pick<ChartSpec, 'x' | 'seriesColumn' | 'seriesKeys'>
): string {
  const hasSeries =
    Array.isArray(chartSpec.seriesKeys) && chartSpec.seriesKeys.length > 0;
  if (hasSeries) {
    const sc = chartSpec.seriesColumn?.trim();
    return sc && sc.length > 0 ? sc : 'series';
  }
  return chartSpec.x;
}

/**
 * Build the deterministic fallback narrative used when the model output fails grounding.
 * Pure & testable; consumes pre-formatted numeric strings for the bottom threshold so the
 * caller can reuse its existing formatY closure.
 */
export function buildDeterministicChartInsightFallback(args: {
  chartSpec: Pick<ChartSpec, 'x' | 'y' | 'seriesColumn' | 'seriesKeys'>;
  topX: unknown;
  topY: number;
  avgY: number;
  yP75: number;
  bottomThreshold: string;
  formatY: (n: number) => string;
  bottomX?: unknown;
}): string {
  const { chartSpec, topX, topY, avgY, formatY, bottomX } = args;
  const dim = resolveTopPerfDimension(chartSpec);
  // IUX2 · plain-English, no banned jargon. Was "p75 …, prioritize …, moving
  // weaker segments above …" — which contradicted the manager-friendly ban
  // list this work introduced. Still names the leader + its value so the
  // grounding contract (name the top category/value) holds.
  const headline = `${dim} "${topX}" leads on ${chartSpec.y} at ${formatY(topY)}, clearly ahead of the typical ${formatY(avgY)} across the rest.`;
  // Always end with a managerial next move — the headline-only fallback used to
  // ship with no DO lane, so a manager got the WHAT but never a next step.
  const doLane = buildDeterministicDoLane({
    topLabel: topX === undefined || topX === null ? '' : String(topX),
    bottomLabel:
      bottomX === undefined || bottomX === null ? undefined : String(bottomX),
  });
  return joinChartInsightLanes({ headline, do: doLane });
}

/**
 * Build a concrete, grounded "DO:" action from the chart's named leader (and,
 * when available, its laggard). Deliberately conservative and mechanism-anchored
 * — it suggests a real comparison / drill-down / reallocation, never a vague
 * "monitor" or "investigate". Used as the deterministic safety net so a manager
 * ALWAYS gets a next step: appended whenever the model omits the DO lane (or a
 * gate strips it), and baked into the headline-only fallback above. The client
 * mirrors this shape in `deriveTileDoLane` for already-persisted tiles.
 */
export function buildDeterministicDoLane(args: {
  topLabel: string;
  bottomLabel?: string;
}): string {
  const top = (args.topLabel ?? '').trim();
  const bottom = (args.bottomLabel ?? '').trim();
  if (top && bottom && top !== bottom) {
    return `Compare what **${top}** does that **${bottom}** doesn't — break the gap down by region, pack or channel and shift effort (distribution, mix or pricing) toward what's working, or decide **${bottom}** isn't worth the investment.`;
  }
  if (top) {
    return `Dig into what's driving **${top}** — break it down by region, pack or channel and double down on the levers (distribution, mix or pricing) behind it.`;
  }
  return `Break this down by a second factor (region, pack or channel) to see where the gap concentrates, then shift effort to the biggest contributor.`;
}

const normalizeInsightText = (value: string) => (value || '').replace(/\s+/g, ' ').trim();
const enforceInsightLimit = (value: string) => {
  if (value.length > KEY_INSIGHT_MAX_CHARS) {
    logger.warn(`⚠️ keyInsight exceeded ${KEY_INSIGHT_MAX_CHARS} characters`, {
      length: value.length,
      preview: value,
    });
  }
  return value;
};

/**
 * Hold the in-`keyInsight` WHY lane to the SAME rail as the answer envelope's
 * likelyDrivers: a `WHY:` lane that is not clearly hedged, or that smuggles a
 * statistic-shaped number into the mechanism, is DROPPED entirely (the HEADLINE
 * and any DO lane are kept). This is the deterministic gate behind the prompt's
 * WHY permission (L-022) — reusing the exported `hasHedge` / `STAT_NUMBER_RE`
 * from the verifier rather than a private copy. Pure; a no-op on legacy untagged
 * strings (no WHY lane → nothing to gate).
 */
export function sanitizeChartWhyLane(keyInsight: string): string {
  const lanes = splitChartInsightLanes(keyInsight);
  if (!lanes.why) return keyInsight;
  const whyOk = hasHedge(lanes.why) && !STAT_NUMBER_RE.test(lanes.why);
  if (whyOk) return keyInsight;
  return joinChartInsightLanes({ headline: lanes.headline, do: lanes.do });
}

export async function generateChartInsights(
  chartSpec: ChartSpec,
  chartData: Record<string, any>[],
  summary: DataSummary,
  chatInsights?: Insight[],
  synthesisContext?: ChartInsightSynthesisContext
): Promise<{ keyInsight: string }> {
  if (!chartData || chartData.length === 0) {
    return {
      keyInsight: "No data available for analysis"
    };
  }

  // Check if this is a dual-axis line chart
  const isDualAxis = chartSpec.type === 'line' && !!(chartSpec as any).y2;
  const y2Variable = (chartSpec as any).y2;
  const y2Label = (chartSpec as any).y2Label || y2Variable;

  // Multi-series charts pivot data: each series key IS a data column, chartSpec.y is a display label only
  const seriesKeys = Array.isArray(chartSpec.seriesKeys) && chartSpec.seriesKeys.length > 0
    ? chartSpec.seriesKeys : null;

  // When ranking by series, top performers are values of the series dimension (seriesColumn),
  // not values of the X dimension. Label the dimension accordingly so the prompt and fallback
  // never call a Category value a "Region" (or whatever chartSpec.x happens to be).
  const topPerfDimension = resolveTopPerfDimension(chartSpec);

  const xValues = chartData.map(row => row[chartSpec.x]).filter(v => v !== null && v !== undefined);
  const yValues = seriesKeys
    ? seriesKeys.flatMap(k => chartData.map(row => row[k]).filter(v => v !== null && v !== undefined))
    : chartData.map(row => row[chartSpec.y]).filter(v => v !== null && v !== undefined);
  const y2Values = isDualAxis ? chartData.map(row => row[y2Variable]).filter(v => v !== null && v !== undefined) : [];

  const numericX: number[] = xValues.map(v => Number(String(v).replace(/[%,,]/g, ''))).filter(v => !isNaN(v));
  const numericY: number[] = yValues.map(v => Number(String(v).replace(/[%,,]/g, ''))).filter(v => !isNaN(v));
  const numericY2: number[] = isDualAxis ? y2Values.map(v => Number(String(v).replace(/[%,,]/g, ''))).filter(v => !isNaN(v)) : [];

  const maxY = numericY.length > 0 ? Math.max(...numericY) : 0;
  const minY = numericY.length > 0 ? Math.min(...numericY) : 0;
  const avgY = numericY.length > 0 ? numericY.reduce((a, b) => a + b, 0) / numericY.length : 0;

  // Helper functions for deterministic, numeric insights
  const percentile = (arr: number[], p: number): number => {
    if (arr.length === 0) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo]!;
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  };

  const roundSmart = (v: number): string => formatCompactNumber(v);

  // Calculate statistics for Y2 if dual-axis
  const maxY2 = numericY2.length > 0 ? Math.max(...numericY2) : 0;
  const minY2 = numericY2.length > 0 ? Math.min(...numericY2) : 0;
  const avgY2 = numericY2.length > 0 ? numericY2.reduce((a, b) => a + b, 0) / numericY2.length : 0;

  // Detect if Y-axis appears to be a percentage column (contains '%' in raw values)
  const yIsPercent = yValues.some(v => typeof v === 'string' && v.includes('%'));
  const y2IsPercent = isDualAxis ? y2Values.some(v => typeof v === 'string' && v.includes('%')) : false;
  const formatY = (val: number): string => yIsPercent ? `${roundSmart(val)}%` : roundSmart(val);
  const formatY2 = (val: number): string => y2IsPercent ? `${roundSmart(val)}%` : roundSmart(val);

  // Calculate standard deviation
  const stdDev = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
  };

  const parseNum = (v: any): number => Number(String(v ?? '').replace(/[%,,]/g, ''));

  // Find top/bottom performers — for multi-series charts, rank series by aggregate sum
  const findTopPerformers = (data: Record<string, any>[], yKey: string, limit: number = 3): Array<{x: any, y: number}> => {
    if (seriesKeys) {
      return seriesKeys
        .map(k => ({ x: k, y: data.reduce((s, r) => s + (isNaN(parseNum(r[k])) ? 0 : parseNum(r[k])), 0) }))
        .filter(item => !isNaN(item.y))
        .sort((a, b) => b.y - a.y)
        .slice(0, limit);
    }
    return data
      .map(row => ({ x: row[chartSpec.x], y: parseNum(row[yKey]) }))
      .filter(item => !isNaN(item.y))
      .sort((a, b) => b.y - a.y)
      .slice(0, limit);
  };

  const findBottomPerformers = (data: Record<string, any>[], yKey: string, limit: number = 3): Array<{x: any, y: number}> => {
    if (seriesKeys) {
      return seriesKeys
        .map(k => ({ x: k, y: data.reduce((s, r) => s + (isNaN(parseNum(r[k])) ? 0 : parseNum(r[k])), 0) }))
        .filter(item => !isNaN(item.y))
        .sort((a, b) => a.y - b.y)
        .slice(0, limit);
    }
    return data
      .map(row => ({ x: row[chartSpec.x], y: parseNum(row[yKey]) }))
      .filter(item => !isNaN(item.y))
      .sort((a, b) => a.y - b.y)
      .slice(0, limit);
  };

  // Calculate percentiles for Y values
  const yP25 = percentile(numericY, 0.25);
  const yP50 = percentile(numericY, 0.5);
  const yP75 = percentile(numericY, 0.75);
  const yP90 = percentile(numericY, 0.9);
  const yStdDev = stdDev(numericY);
  const yMedian = yP50;

  // Calculate statistics for Y2 if dual-axis
  const y2P25 = isDualAxis && numericY2.length > 0 ? percentile(numericY2, 0.25) : NaN;
  const y2P50 = isDualAxis && numericY2.length > 0 ? percentile(numericY2, 0.5) : NaN;
  const y2P75 = isDualAxis && numericY2.length > 0 ? percentile(numericY2, 0.75) : NaN;
  const y2P90 = isDualAxis && numericY2.length > 0 ? percentile(numericY2, 0.9) : NaN;
  const y2StdDev = isDualAxis ? stdDev(numericY2) : 0;
  const y2Median = y2P50;
  const y2CV = isDualAxis && avgY2 !== 0 ? (y2StdDev / Math.abs(avgY2)) * 100 : 0;
  const y2Variability = isDualAxis ? (y2CV > 30 ? 'high' : y2CV > 15 ? 'moderate' : 'low') : '';

  const pearsonR = (xs: number[], ys: number[]): number => {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return NaN;
    const x = xs.slice(0, n);
    const y = ys.slice(0, n);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(x);
    const my = mean(y);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i]! - mx;
      const dy = y[i]! - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    const den = Math.sqrt(dx2 * dy2);
    return den === 0 ? NaN : num / den;
  };

  // Detect if this is a correlation chart (impact analysis) - check this BEFORE early return
  const isCorrelationChart = (chartSpec as any)._isCorrelationChart === true;
  const targetVariable = (chartSpec as any)._targetVariable || chartSpec.y;
  const factorVariable = (chartSpec as any)._factorVariable || chartSpec.x;

  const bothNumeric = numericX.length > 0 && numericY.length > 0;

  // Enhanced statistics for all chart types
  const topPerformers = findTopPerformers(chartData, chartSpec.y, 3);
  const bottomPerformers = findBottomPerformers(chartData, chartSpec.y, 3);
  const topPerformerStr = topPerformers.length > 0 
    ? topPerformers.map(p => `${p.x} (${formatY(p.y)})`).join(', ')
    : 'N/A';
  const bottomPerformerStr = bottomPerformers.length > 0
    ? bottomPerformers.map(p => `${p.x} (${formatY(p.y)})`).join(', ')
    : 'N/A';

  // Y2 statistics for dual-axis charts
  const topPerformersY2 = isDualAxis ? findTopPerformers(chartData, y2Variable, 3) : [];
  const bottomPerformersY2 = isDualAxis ? findBottomPerformers(chartData, y2Variable, 3) : [];
  const topPerformerStrY2 = isDualAxis && topPerformersY2.length > 0 
    ? topPerformersY2.map(p => `${p.x} (${formatY2(p.y)})`).join(', ')
    : 'N/A';
  const bottomPerformerStrY2 = isDualAxis && bottomPerformersY2.length > 0
    ? bottomPerformersY2.map(p => `${p.x} (${formatY2(p.y)})`).join(', ')
    : 'N/A';

  // Calculate coefficient of variation (CV) to measure variability
  const cv = avgY !== 0 ? (yStdDev / Math.abs(avgY)) * 100 : 0;
  const variability = cv > 30 ? 'high' : cv > 15 ? 'moderate' : 'low';

  // For bar/pie charts with categorical X, identify top categories (skip for multi-series — top performers already covers it)
  const isCategoricalX = numericX.length === 0;
  let topCategories = '';
  if (!seriesKeys && isCategoricalX && chartData.length > 0) {
    const categoryStats = chartData
      .map(row => ({ x: row[chartSpec.x], y: parseNum(row[chartSpec.y]) }))
      .filter(item => !isNaN(item.y))
      .sort((a, b) => b.y - a.y)
      .slice(0, 3);
    topCategories = categoryStats.map(c => `${c.x} (${formatY(c.y)})`).join(', ');
  }

  // For correlation charts, calculate X-axis statistics for insights
  const numericXValues = chartData.map(row => Number(String(row[chartSpec.x]).replace(/[%,,]/g, ''))).filter(v => !isNaN(v));
  const xP25 = numericXValues.length > 0 ? percentile(numericXValues, 0.25) : NaN;
  const xP50 = numericXValues.length > 0 ? percentile(numericXValues, 0.5) : NaN;
  const xP75 = numericXValues.length > 0 ? percentile(numericXValues, 0.75) : NaN;
  const xP90 = numericXValues.length > 0 ? percentile(numericXValues, 0.9) : NaN;
  const avgX = numericXValues.length > 0 ? numericXValues.reduce((a, b) => a + b, 0) / numericXValues.length : NaN;
  const minX = numericXValues.length > 0 ? Math.min(...numericXValues) : NaN;
  const maxX = numericXValues.length > 0 ? Math.max(...numericXValues) : NaN;
  
  // Find X values corresponding to top Y performers (to identify optimal X range)
  const topYIndices = chartData
    .map((row, idx) => ({ idx, y: Number(String(row[chartSpec.y]).replace(/[%,,]/g, '')) }))
    .filter(item => !isNaN(item.y))
    .sort((a, b) => b.y - a.y)
    .slice(0, Math.min(10, Math.floor(chartData.length * 0.2))) // Top 20% or top 10, whichever is smaller
    .map(item => item.idx);
  const xValuesForTopY = topYIndices.map(idx => Number(String(chartData[idx]![chartSpec.x]).replace(/[%,,]/g, ''))).filter(v => !isNaN(v));
  const avgXForTopY = xValuesForTopY.length > 0 ? xValuesForTopY.reduce((a, b) => a + b, 0) / xValuesForTopY.length : NaN;
  const xRangeForTopY = xValuesForTopY.length > 0 ? {
    min: Math.min(...xValuesForTopY),
    max: Math.max(...xValuesForTopY),
    p25: percentile(xValuesForTopY, 0.25),
    p75: percentile(xValuesForTopY, 0.75),
  } : null;

  // Detect if X-axis is percentage
  const xIsPercent = chartData.some(row => {
    const xVal = row[chartSpec.x];
    return typeof xVal === 'string' && xVal.includes('%');
  });
  const formatX = (val: number): string => {
    if (isNaN(val)) return 'N/A';
    if (xIsPercent) return `${roundSmart(val)}%`;
    return roundSmart(val);
  };

  let scatterNumericFactsBlock = '';
  if (bothNumeric && !isCorrelationChart && numericX.length > 0 && numericY.length > 0) {
    const yP80 = percentile(numericY, 0.8);
    const pairs = chartData
      .map(
        (r) =>
          [
            Number(String(r[chartSpec.x]).replace(/[%,,]/g, '')),
            Number(String(r[chartSpec.y]).replace(/[%,,]/g, '')),
          ] as [number, number]
      )
      .filter(([vx, vy]) => !isNaN(vx) && !isNaN(vy));
    const r = pearsonR(numericX, numericY);
    const xMin = Math.min(...numericX);
    const xMax = Math.max(...numericX);
    const xAvg = numericX.reduce((a, b) => a + b, 0) / numericX.length;
    const top20 = pairs.filter(([, vy]) => vy >= yP80);
    const xAvgTopY =
      top20.length > 0
        ? top20.map(([vx]) => vx).reduce((a, b) => a + b, 0) / top20.length
        : NaN;
    const assoc =
      isNaN(r) ? '' : `${Math.abs(r) > 0.7 ? 'strong' : Math.abs(r) > 0.4 ? 'moderate' : 'weak'} ${r > 0 ? 'positive' : 'negative'} association`;
    scatterNumericFactsBlock = `
NUMERIC XY RELATIONSHIP (ground truth from plotted points):
- Valid pairs: ${pairs.length}
- Pearson r: ${isNaN(r) ? 'N/A' : roundSmart(r)}${assoc ? ` (${assoc})` : ''}
- ${chartSpec.y}: ${formatY(minY)}–${formatY(maxY)}, average ${formatY(avgY)}
- ${chartSpec.x}: ${formatX(xMin)}–${formatX(xMax)}, average ${formatX(xAvg)}
- Top ~20% of ${chartSpec.y} are ≥ ${formatY(yP80)}; among those points, average ${chartSpec.x} is ${isNaN(xAvgTopY) ? 'N/A' : formatX(xAvgTopY)}`.trim();
  }

  const truncateInsight = (value: string): string => {
    const v = value ?? '';
    if (v.length <= KEY_INSIGHT_MAX_CHARS) return v;
    return (v.slice(0, Math.max(0, KEY_INSIGHT_MAX_CHARS - 3)).trimEnd() + '...');
  };

  const stripMarkdownToPlainOneLine = (text: string): string => {
    return (text || '')
      .replace(/\*\*/g, '') // remove bold markers
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+:\s+/g, ': ') // normalize colon spacing
      .trim();
  };

  // Reuse prior chat-level insight only when there is no active user question (enrichment should prefer fresh LLM copy).
  if (
    !synthesisContext?.userQuestion?.trim() &&
    chatInsights &&
    Array.isArray(chatInsights) &&
    chatInsights.length > 0
  ) {
    const topX = topPerformers.length > 0 ? topPerformers[0]!.x : undefined;
    const topY = topPerformers.length > 0 ? topPerformers[0]!.y : undefined;
    const topXStr = topX === undefined || topX === null ? '' : String(topX).toLowerCase().trim();
    const topYStr =
      typeof topY === 'number' && !isNaN(topY) ? formatY(topY).toLowerCase() : '';

    const ranked = chatInsights
      .filter((ins: Insight | undefined) => !!ins?.text)
      .map((ins: Insight) => {
        const plain = stripMarkdownToPlainOneLine(ins.text);
        const lower = plain.toLowerCase();

        let score = 0;
        if (topXStr && isCategoricalX && lower.includes(topXStr)) score += 5;
        if (topYStr && lower.includes(topYStr)) score += 3;
        if (chartSpec.y && lower.includes(String(chartSpec.y).toLowerCase())) score += 1;
        if (chartSpec.x && lower.includes(String(chartSpec.x).toLowerCase())) score += 1;
        if (lower.includes('actionable suggestion') || lower.includes('actionable suggestion:')) score += 1;

        return { score, plain };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (best && best.score >= 4) {
      const candidate = truncateInsight(best.plain);

      const mentionsTopX = isCategoricalX ? (topXStr ? candidate.toLowerCase().includes(topXStr) : true) : true;
      const mentionsTopY = topYStr ? candidate.toLowerCase().includes(topYStr) : true;

      // For categorical charts, require both top X and its top Y to avoid mismatches.
      if ((!isCategoricalX || (mentionsTopX && mentionsTopY))) {
        return { keyInsight: insertSentenceBreaks(enforceInsightLimit(candidate)) };
      }
    }
  }

  // Fallback to model for non-numeric cases; request quantified insights explicitly
  // W9 · a correlation is an ASSOCIATION, not an established cause. (Definitional
  // pairs — GC% ↔ NR — are already filtered out upstream in correlationAnalyzer,
  // so a chart that reaches here is non-definitional but still only correlation-
  // grade.) Describe how the two MOVE TOGETHER and where the association is
  // strongest; do NOT prescribe "change X to improve Y" — that asserts causation
  // the data does not establish. Calibrated language ("associated with", "tends
  // to move with"), and flag it as a hypothesis to validate, never a lever.
  const correlationContext = isCorrelationChart ? `
CRITICAL: This is a CORRELATION chart — it shows an ASSOCIATION, NOT a proven cause.
- Y-axis (${chartSpec.y}) and X-axis (${chartSpec.x}) MOVE TOGETHER in the data.
- This does NOT establish that ${factorVariable} drives ${targetVariable}. Correlation ≠ causation.

WHERE THE ASSOCIATION IS STRONGEST (${factorVariable}):
- Range: ${formatX(minX)} to ${formatX(maxX)}, average ${formatX(avgX)}, median ${formatX(xP50)}
${xRangeForTopY ? `- The highest ${targetVariable} values tend to occur where ${factorVariable} is ${formatX(xRangeForTopY.min)}-${formatX(xRangeForTopY.max)} (avg ${formatX(avgXForTopY)}).` : ''}

INSIGHT FORMAT (association, not action):
- Describe the relationship: "${targetVariable} tends to be higher where ${factorVariable} is ..." using the numeric ranges above.
- NEVER instruct the reader to CHANGE ${factorVariable} to MOVE ${targetVariable} — the data does not establish that lever.
- If you suggest anything, suggest VALIDATION: "worth testing whether ${factorVariable} actually drives ${targetVariable}" — a hypothesis, not a directive.
- NEVER use percentile labels ("P75", "P90") — use the numeric values themselves.

` : '';

  const userQuestionBlock = synthesisContext?.userQuestion?.trim()
    ? `\n\nUSER QUESTION (prioritize an insight that answers this):\n${synthesisContext.userQuestion.trim().slice(0, 2000)}`
    : '';

  const sacBlock = formatSessionAnalysisContextForInsight(synthesisContext?.sessionAnalysisContext)
    ? `\n\nSESSION CONTEXT (dataset understanding; do not contradict):\n${formatSessionAnalysisContextForInsight(synthesisContext?.sessionAnalysisContext)}`
    : '';

  const permBlock = synthesisContext?.permanentContext?.trim()
    ? `\n\nUSER NOTES:\n${synthesisContext.permanentContext.trim()}`
    : '';

  // Build chat insights context if available
  const chatInsightsContext = chatInsights && chatInsights.length > 0
    ? `\n\nRELEVANT CHAT-LEVEL INSIGHTS (optional cross-check; prefer DATA FACTS + user question):
${chatInsights.map((insight, idx) => `${idx + 1}. ${insight.text}`).join('\n')}

The keyInsight should connect this chart (${chartSpec.x}, ${chartSpec.y}${isDualAxis ? `, ${y2Label}` : ''}) to the analysis as the HEADLINE line plus, where they genuinely apply, an optional hedged 'WHY: ' line and an optional 'DO: ' next step. ≤${KEY_INSIGHT_MAX_CHARS} characters total.`
    : '';

  const dataFactsContext = `
DATA FACTS (ground truth from the chart data; use these explicitly in the output):
- Top ${chartSpec.y} performer(s) by ${topPerfDimension}: ${topPerformerStr}
- Bottom ${chartSpec.y} performer(s) by ${topPerfDimension}: ${bottomPerformerStr}
${isDualAxis ? `- Top ${y2Label} performer(s): ${topPerformerStrY2}\n- Bottom ${y2Label} performer(s): ${bottomPerformerStrY2}` : ''}`.trim();

  // Wave 1 · pivot patterns: derived signals (concentration, gap, dispersion,
  // segments, temporal, dual-axis) that the LLM needs to escape the formulaic
  // "leader-vs-laggard" pattern. Pure function over chartData; pushes the
  // model toward driver / risk / next-check phrasing.
  const pivotPatterns = computePivotPatterns(chartData, {
    x: chartSpec.x,
    y: chartSpec.y,
    type: chartSpec.type,
    seriesKeys: chartSpec.seriesKeys,
    y2: (chartSpec as any).y2,
  });
  const pivotPatternsBlock = renderPivotPatternsBlock(pivotPatterns, formatY);
  const pivotPatternsSection = pivotPatternsBlock ? `\n\n${pivotPatternsBlock}` : '';

  // Deterministic day-of-week grounding: for a single-measure date-axis trend,
  // detect a recurring weekly off-day (e.g. Sundays sit at ~0) and feed it in as
  // ground truth so the WHY names the weekly rhythm instead of speculating about
  // the dips. Pure + self-guarding (returns null for non-temporal / no-rhythm
  // series), so it never pollutes charts that have no weekly structure.
  const weekdayPattern =
    seriesKeys || isDualAxis
      ? null
      : deriveWeekdayPattern(chartData, chartSpec.x, chartSpec.y, formatY);
  const weekdayPatternSection = weekdayPattern ? `\n\n${weekdayPattern.block}` : '';

  const scatterBlock = scatterNumericFactsBlock ? `\n${scatterNumericFactsBlock}\n` : '';

  const prompt = `Return JSON with the listed fields.

TASK: Brief a busy manager (NOT a statistician) on THIS chart in AT MOST 3 short lines. Use the real numbers from DATA FACTS / PIVOT PATTERNS / blocks below, but translate them into everyday language—never invent metrics. PIVOT PATTERNS are internal analysis signals: read them to find the story, but NEVER echo their labels (no "quartile", "concentration", "HHI", "CV", "P75", "mass", "trough"). Emit these lanes, each on its OWN line, omitting any optional lane that does not genuinely apply:
  Line 1 — HEADLINE (REQUIRED): the single most important comparison in plain words WITH the actual number(s), naming each group by its EXACT label from DATA FACTS (e.g. "Female passengers survived at 74% versus 19% for male passengers — nearly 4× higher"). One sentence. No hedge here; no "WHY:"/"DO:" prefix.
  Line 2 — start the line literally with "WHY: " then ONE clearly-hedged hypothesis for why the pattern might exist, drawn from the question and general real-world / business knowledge (OPTIONAL). It MUST open with a hedge ("likely", "may reflect", "consistent with", "one plausible reason") so it never reads as a measured fact, and MUST NOT contain any number (numbers belong in the headline). Omit the whole line if there is no credible reason. EXCEPTION — if a TEMPORAL CALENDAR block appears below, the WHY MUST use it: state the weekly rhythm plainly (e.g. "WHY: the regular dips are Sundays — a non-working day, so the weekly rise-and-fall is expected") and do NOT present that off-day pattern as a surprise, a demand swing, or a data gap. A calendar fact is observed, so a light hedge is fine but never contradict it.
  Line 3 — start the line literally with "DO: " then THE single most useful next move a manager could make on this — their strategic next step. Name a concrete lever (price, distribution, mix, segment, channel, cadence, season) or a specific drill-down, and tie it to the named leader/laggard (e.g. "DO: Copy SAFF GOLD's metro distribution playbook to NIHAR NHO, where the same reach should lift sell-through"). Give a DO line for essentially every chart; OMIT it ONLY when the pattern is a fixed historical or structural fact nobody could ever act on. Never pad with a vague or generic step.

Keep it tight — a manager should absorb all of it in a few seconds. Drop a lane rather than padding it.

If ${chartSpec.y} is a rate, share, ratio or average, the categories do NOT add up to a meaningful total — compare them directly (e.g. "X is about 4× Y"), render any 0–1 value as a percentage (e.g. 0.742 → 74%, 0.189 → 19%) rather than a raw decimal, and never say "X% of the total".

Use general business sense where it does not contradict the numbers.

CHART CONTEXT
- Type: ${chartSpec.type}
- Title: ${chartSpec.title}
- X: ${chartSpec.x}${isCorrelationChart ? ' (FACTOR)' : ''}
${seriesKeys ? `- Series: ${chartSpec.seriesColumn?.trim() || 'series'} (${seriesKeys.join(', ')})\n` : ''}- Y: ${chartSpec.y}${isCorrelationChart ? ' (TARGET)' : ''}${isDualAxis ? ` | Y2: ${y2Label}` : ''}
- Points: ${chartData.length}
- Y stats: ${formatY(minY)}–${formatY(maxY)} (avg ${formatY(avgY)}, 75th percentile: ${formatY(yP75)})${isDualAxis ? ` | Y2: ${formatY2(minY2)}–${formatY2(maxY2)} (avg ${formatY2(avgY2)})` : ''}

${dataFactsContext}${pivotPatternsSection}${weekdayPatternSection}
${scatterBlock}${correlationContext}${userQuestionBlock}${sacBlock}${permBlock}${chatInsightsContext}

OUTPUT JSON (exact keys only):
{
  "keyInsight": "Up to 3 lines (≤${KEY_INSIGHT_MAX_CHARS} characters total), no statistics jargon, no markdown headings. Wrap every data-derived label and number in markdown bold (**…**). Line 1 is the HEADLINE: name the leading ${topPerfDimension} and its ${chartSpec.y} from DATA FACTS using the category's EXACT label text (not a synonym) with the real number (never labels like P75/P90), both bolded (e.g. **PCNO(R)** at **75.9**). Then an OPTIONAL line starting 'WHY: ' (one clearly-hedged, number-free reason — omit if none is credible) and — for essentially every chart — a line starting 'DO: ' giving the single most useful managerial next move (a concrete lever or drill-down, tied to a named category). Omit the DO line only when the pattern is a fixed fact nobody could act on."
}`;

  try {
    const response = await callLlm(
      {
        model: getInsightModel() as string,
        messages: [
          {
            role: 'system',
            content: `You are a senior analyst briefing a busy manager who is NOT a statistician. Output JSON with a single key "keyInsight": AT MOST 3 short lines interpreting the chart using ONLY the provided numbers, each lane on its OWN line and any optional lane omitted when it does not apply:
  • the HEADLINE — the main comparison with real numbers (no hedge, no prefix);
  • optionally a line starting "WHY: " — ONE clearly-hedged real-world reason for the pattern;
  • a line starting "DO: " — the single most useful managerial next move (a concrete lever or drill-down, tied to a named category). Give one for essentially every chart; omit ONLY when the pattern is a fixed fact nobody could ever act on.
Keep it tight: a manager should grasp all of it in a few seconds. Drop any lane rather than padding it.

WRITE FOR A NON-MATH READER — translate the analysis, never parrot jargon:
- BANNED words (must never appear in the output): mass, quartile, upper-quartile, lower-quartile, bottom-quartile, percentile, P25, P75, P90, HHI, CV, coefficient of variation, concentration index, long-tail, dispersion, trough. PIVOT PATTERNS labels are internal signals only — read them, then say it plainly.
- Prefer plain phrasing: "nearly 4× higher", "about 3 in 4", "drives most of the total", "spread fairly evenly", "just one group does most of it", "the highest / lowest point" — not index or percentile language.

ANTI-PATTERNS — do NOT write any of these:
- "Increase {y} where {y} is low" / "improve underperformers" / "lift weaker segments" — generic, not a mechanism.
- "Focus on {top}" / "prioritize {leader}" without naming a *mechanism* (price, distribution, mix, segment, channel, cadence, season).
- Sentences that only restate which value is highest or lowest with no interpretation.
- Vague next-actions ("monitor", "investigate further", "look deeper"). If you give a next step, make it specific and clearly worth doing.
- Meta-tool advice ("build / create / set up a dashboard, scorecard, tracker, monitoring view, or report to track this") — that is NOT a managerial action, it is just describing the surface the reader is already looking at. Recommend the underlying business decision (with a mechanism — price, distribution, mix, segment, channel, cadence, season), or OMIT the DO line.
- A forced next step when nothing can be done: if the pattern is a fixed historical or structural fact the reader cannot change, OMIT the next step instead of inventing a generic one.

The "WHY: " line is a plausible cause drawn from the question and general world / business knowledge (e.g. why one group leads, why a season spikes). It is a HYPOTHESIS: ALWAYS introduce it with a hedge ("likely", "may reflect", "consistent with") so it is unmistakably an explanation and not a measured fact, and NEVER attach a number to it (numbers stay in the measured headline). This keeps the chart's "why" consistent with the answer envelope's hedged causal lane. If there is no credible reason, OMIT the WHY line entirely — never pad it.

NEVER META-HEDGE: do not describe your OWN reasoning or the evidence as uncertain/undefined/incomplete (banned: "HHI is undefined", "CV not informative", "cannot be stated from the supplied evidence", "the data may be mis-coded or not populated", "from this slice alone"). When a series is ALL ZERO (or every value is the same), do not analyze its (non-existent) spread — state the plain, likely DOMAIN reason for the flatness in one sentence (e.g. "Adherence is 0% for every planned type here because it is only recorded on Market-Working days — the other types are not measurement opportunities, not low performers."), then stop. A flat-zero metric is an expected structural fact, not a data-quality problem to speculate about.

Never use percentile shorthand like P75 or P90 — use numeric values. Always abbreviate magnitudes ≥1000 with K / M / B (e.g. 108547 → 109K, 15240 → 15.2K, 1500000 → 1.5M); never emit raw digit strings for thousands or millions. Never print more than two decimal places for any number. EMPHASIS: wrap every token taken from the data — exact category / series / metric labels AND the numeric figures — in markdown bold (**…**), e.g. "**PCNO(R)** leads at **75.9** versus **NIHAR NHO** at **24.5**". Bold only data-derived tokens, never ordinary prose, and no markdown headers.`,
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: getInsightTemperature(),
        max_tokens: 1400,
      },
      { purpose: LLM_PURPOSE.INSIGHT_GEN }
    );

    const content = response.choices[0]!.message.content || '{}';
    const result = JSON.parse(content);

    // Model might return either { keyInsight } or an { insights: [...] } shape.
    let modelKeyInsight: string | undefined;

    if (result.insights && Array.isArray(result.insights) && result.insights.length > 0) {
      // Build per-chart keyInsight from the first returned insight object.
      const first = result.insights[0] || {};
      const title = normalizeInsightText(first.title || 'Insight');
      const observation = normalizeInsightText(first.observation || first.text || '');
      const combined = normalizeInsightText([title, observation].filter(Boolean).join(': '));
      modelKeyInsight = combined;
    } else {
      // Expected output format: { keyInsight }
      modelKeyInsight = normalizeInsightText(
        result.keyInsight || "Data shows interesting patterns worth investigating"
      );
    }

    // Hedge-gate the WHY: lane before anything else uses the text — an unhedged
    // or numbered "why" is dropped, the headline + DO lane survive (L-022).
    modelKeyInsight = sanitizeChartWhyLane(modelKeyInsight);

    // Gate the DO: lane the same way (deterministic, ships BEFORE the prompt
    // permission per L-022): "build a dashboard / scorecard / tracker / report
    // to track this" is meta-tool advice, not a managerial action — drop it
    // (headline + WHY survive) rather than ship it. The prompt also bans it, but
    // the model free-styles at temp 0.45, so the code gate is the guarantee.
    modelKeyInsight = stripDashboardMetaAdviceDoLane(modelKeyInsight);

    // Always-show-a-Do: if the model omitted the DO lane (or a gate stripped it),
    // append a deterministic, grounded next step so a manager always gets a clear
    // move. The model's own DO always wins when present; this is only the safety
    // net. Restricted to categorical-x charts — naming a "leader vs laggard"
    // action over a numeric/continuous x (scatter/trend) would read as nonsense,
    // so those keep the model's DO or none.
    if (isCategoricalX && !splitChartInsightLanes(modelKeyInsight).do) {
      const topLabel =
        topPerformers.length > 0 && topPerformers[0]!.x != null
          ? String(topPerformers[0]!.x)
          : '';
      const bottomLabel =
        bottomPerformers.length > 0 && bottomPerformers[0]?.x != null
          ? String(bottomPerformers[0]!.x)
          : undefined;
      if (topLabel) {
        modelKeyInsight = joinChartInsightLanes({
          ...splitChartInsightLanes(modelKeyInsight),
          do: buildDeterministicDoLane({ topLabel, bottomLabel }),
        });
      }
    }

    const candidate = truncateInsight(modelKeyInsight);

    // Deterministic verification: ensure the output explicitly names the top category/value.
    const topX = topPerformers.length > 0 ? topPerformers[0]!.x : undefined;
    const topY = topPerformers.length > 0 ? topPerformers[0]!.y : undefined;
    const topXNorm = topX === undefined || topX === null ? '' : String(topX).toLowerCase().trim();
    const topYStr = typeof topY === 'number' && !isNaN(topY) ? formatY(topY) : '';
    // IUX2 · accept multiple renderings of the top value when grounding. A
    // manager-friendly answer renders a 0–1 rate/share as a percentage
    // ("74.2%" / "74%"), never the raw "0.742" that formatY emits for such a
    // column — so a correct, plain-English answer must still count as grounded.
    // Without this the de-jargoned LLM output is rejected and the statistical
    // fallback ships for every rate-by-category chart.
    const topYForms = topYStr ? [topYStr.toLowerCase()] : [];
    if (typeof topY === 'number' && !isNaN(topY) && topY >= 0 && topY <= 1) {
      topYForms.push(`${(topY * 100).toFixed(1)}%`, `${Math.round(topY * 100)}%`);
    }

    const candidateLower = candidate.toLowerCase();
    let passes = true;
    const rVal = bothNumeric && !isCorrelationChart ? pearsonR(numericX, numericY) : NaN;
    const rStr = !isNaN(rVal) ? roundSmart(rVal).toLowerCase() : '';

    if (topYForms.length > 0) {
      passes = passes && topYForms.some((f) => candidateLower.includes(f));
    }
    if (isCategoricalX && topXNorm) {
      passes = passes && candidateLower.includes(topXNorm);
    }
    // Numeric XY: allow grounding via Pearson r if top-Y string match failed (e.g. formatting).
    if (!isCategoricalX && bothNumeric && !isCorrelationChart && topYStr && !passes && rStr) {
      passes = candidateLower.includes(rStr);
    }

    if (!passes && topX !== undefined && typeof topY === 'number' && !isNaN(topY)) {
      // Prefer the pattern-driven fallback when patterns are usable — keyed off
      // concentration / dispersion / trend / relationship / diagnostic families
      // instead of the formulaic "prioritize the leader, lift the laggards"
      // template. The SHORT variant emits HEADLINE + a DO lane only (no verbose
      // driver/risk wall, no speculative WHY), matching the manager-grade shape.
      const usePatternFallback =
        pivotPatterns.topPerformers.length > 0 && pivotPatterns.rowCount >= 2;

      if (usePatternFallback) {
        const { text } = buildPatternDrivenFallbackShort({
          patterns: pivotPatterns,
          chartSpec,
          dimensionLabel: topPerfDimension,
          formatY,
        });
        return {
          keyInsight: insertSentenceBreaks(truncateInsight(text)),
        };
      }

      const bottomThresholdStr =
        bottomPerformers.length > 0 && typeof bottomPerformers[0]?.y === 'number'
          ? formatY(bottomPerformers[0].y)
          : formatY(yP25);

      const fallback = buildDeterministicChartInsightFallback({
        chartSpec,
        topX,
        topY,
        avgY,
        yP75,
        bottomThreshold: bottomThresholdStr,
        formatY,
        bottomX: bottomPerformers.length > 0 ? bottomPerformers[0]!.x : undefined,
      });

      return {
        keyInsight: insertSentenceBreaks(truncateInsight(fallback)),
      };
    }

    return {
      keyInsight: insertSentenceBreaks(enforceInsightLimit(candidate)),
    };
  } catch (error) {
    logger.error('Error generating chart insights:', error);
    return {
      keyInsight: insertSentenceBreaks(
        `This ${chartSpec.type} chart shows ${chartData.length} data points with values ranging from ${formatCompactNumber(minY)} to ${formatCompactNumber(maxY)}`
      )
    };
  }
}


