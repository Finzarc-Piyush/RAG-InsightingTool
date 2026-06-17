import { ChartSpec, DataSummary, Insight } from '../shared/schema.js';
import { callLlm } from './agents/runtime/callLlm.js';
import { LLM_PURPOSE } from './agents/runtime/llmCallPurpose.js';
import { formatCompactNumber } from './formatCompactNumber.js';
import type { ChartInsightSynthesisContext } from './insightSynthesis/types.js';
import { formatSessionAnalysisContextForInsight } from './insightSynthesis/formatSessionContext.js';
import { getInsightModel, getInsightTemperature } from './insightSynthesis/insightModelConfig.js';
import { computePivotPatterns, renderPivotPatternsBlock } from './insightGenerator/pivotPatterns.js';
import { buildPatternDrivenFallback } from './insightGenerator/deterministicNarratives.js';
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

// keyInsight: grounded numbers + LLM interpretation (3–5 substantive sentences typical).
const KEY_INSIGHT_MAX_CHARS = 2200;

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
}): string {
  const { chartSpec, topX, topY, avgY, formatY } = args;
  const dim = resolveTopPerfDimension(chartSpec);
  // IUX2 · plain-English, no banned jargon. Was "p75 …, prioritize …, moving
  // weaker segments above …" — which contradicted the manager-friendly ban
  // list this work introduced. Still names the leader + its value so the
  // grounding contract (name the top category/value) holds.
  return `${dim} "${topX}" leads on ${chartSpec.y} at ${formatY(topY)}, clearly ahead of the typical ${formatY(avgY)} across the rest.`;
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

export async function generateChartInsights(
  chartSpec: ChartSpec,
  chartData: Record<string, any>[],
  summary: DataSummary,
  chatInsights?: Insight[],
  synthesisContext?: ChartInsightSynthesisContext
): Promise<{ keyInsight: string; businessCommentary?: string }> {
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
  const correlationContext = isCorrelationChart ? `
CRITICAL: This is a CORRELATION/IMPACT ANALYSIS chart.
- Y-axis (${chartSpec.y}) = TARGET VARIABLE we want to IMPROVE (${targetVariable})
- X-axis (${chartSpec.x}) = FACTOR VARIABLE we can CHANGE (${factorVariable})
- Suggestions MUST focus on: "How to change ${factorVariable} to improve ${targetVariable}"

X-AXIS STATISTICS (${factorVariable} - what we can change):
- Range: ${formatX(minX)} to ${formatX(maxX)}
- Average: ${formatX(avgX)}
- Median: ${formatX(xP50)}
- 25th percentile: ${formatX(xP25)}, 75th percentile: ${formatX(xP75)}, 90th percentile: ${formatX(xP90)}
${xRangeForTopY ? `- Optimal ${factorVariable} range for top Y performers: ${formatX(xRangeForTopY.min)}-${formatX(xRangeForTopY.max)} (avg: ${formatX(avgXForTopY)}, 25th-75th percentile range: ${formatX(xRangeForTopY.p25)}-${formatX(xRangeForTopY.p75)})` : ''}

SUGGESTION FORMAT:
- Must explain how to CHANGE ${factorVariable} (X-axis) to IMPROVE ${targetVariable} (Y-axis)
- Use specific X-axis values/ranges from statistics above
- NEVER use percentile labels like "P75", "P90", "P25", "P75 level", "P90 level", "P75 value", "P90 value" - ONLY use the numeric values themselves
- Example: "To improve ${targetVariable} to ${formatY(yP75)} or higher, adjust ${factorVariable} to ${formatX(xRangeForTopY?.p75 || xP75)}" (NOT "to P75 level (${formatY(yP75)})")
- Focus on actionable steps: "Adjust ${factorVariable} from current average of ${formatX(avgX)} to target range of ${formatX(xRangeForTopY?.p25 || xP25)}-${formatX(xRangeForTopY?.p75 || xP75)}"

` : '';

  const userQuestionBlock = synthesisContext?.userQuestion?.trim()
    ? `\n\nUSER QUESTION (prioritize an insight that answers this):\n${synthesisContext.userQuestion.trim().slice(0, 2000)}`
    : '';

  const sacBlock = formatSessionAnalysisContextForInsight(synthesisContext?.sessionAnalysisContext)
    ? `\n\nSESSION CONTEXT (dataset understanding; do not contradict):\n${formatSessionAnalysisContextForInsight(synthesisContext?.sessionAnalysisContext)}`
    : '';

  const permBlock = synthesisContext?.permanentContext?.trim()
    ? `\n\nUSER NOTES:\n${synthesisContext.permanentContext.trim().slice(0, 3000)}`
    : '';

  // W12 · feed FMCG/Marico domain context to chart insight generation. When
  // present, the model is asked to fill `businessCommentary` (1–2 sentences
  // framing the chart's metric against industry priors). Capped at 3000 chars
  // so the prompt stays under the existing budget; the full pack content is
  // already available to narrator/synthesizer via the W7 bundle.
  const domainBlock = synthesisContext?.domainContext?.trim()
    ? `\n\nFMCG / MARICO DOMAIN CONTEXT (background only — never numeric evidence; cite pack id when used):\n${synthesisContext.domainContext.trim().slice(0, 3000)}`
    : '';
  const wantsBusinessCommentary = Boolean(domainBlock);

  // Build chat insights context if available
  const chatInsightsContext = chatInsights && chatInsights.length > 0
    ? `\n\nRELEVANT CHAT-LEVEL INSIGHTS (optional cross-check; prefer DATA FACTS + user question):
${chatInsights.map((insight, idx) => `${idx + 1}. ${insight.text}`).join('\n')}

The keyInsight should connect this chart (${chartSpec.x}, ${chartSpec.y}${isDualAxis ? `, ${y2Label}` : ''}) to the analysis with 3–5 substantive sentences: the headline number, what it implies for segment / risk / opportunity, and one concrete next-check or next-action. ≤${KEY_INSIGHT_MAX_CHARS} characters total.`
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

  const scatterBlock = scatterNumericFactsBlock ? `\n${scatterNumericFactsBlock}\n` : '';

  const businessCommentaryRequest = wantsBusinessCommentary
    ? `,
  "businessCommentary": "1–2 sentences framing this chart's metric (${chartSpec.y}${isDualAxis ? `, ${y2Label}` : ''}) against the FMCG/Marico domain context above. Cite the pack id verbatim (e.g. \`marico-haircare-portfolio\`, \`kpi-and-metric-glossary\`) when you reference it. Treat domain content as orientation only — never invent industry figures. Omit (return null) when no pack is materially relevant."`
    : '';

  const prompt = `Return JSON with the listed fields.

TASK: Write 3–5 plain-English sentences (plain text, no markdown headings) that explain THIS chart to a busy manager who is NOT a statistician. Use the real numbers from DATA FACTS / PIVOT PATTERNS / blocks below, but translate them into everyday language—never invent metrics. PIVOT PATTERNS are internal analysis signals: read them to find the story, but NEVER echo their labels (no "quartile", "concentration", "HHI", "CV", "P75", "mass", "trough"). Cover, in this order, only the parts that genuinely apply:
  1. HEADLINE — the main comparison in plain words with the actual numbers, naming each group by its EXACT label from DATA FACTS (e.g. "Female passengers survived at 74% versus 19% for male passengers — nearly 4× higher").
  2. SHAPE — which specific segment / time bucket / mix drives the headline, named explicitly, and whether it is broad-based or down to just one or two groups — said in plain words.
  3. LIKELY REASON — a brief, plausible explanation for WHY this pattern probably exists, using the question and general real-world / business knowledge. Frame it as a likely reason, not a measured fact; reason qualitatively and never attach invented numbers. Omit if there is no credible reason.
  4. WHAT TO DO — one concrete, useful next step ONLY when the reader could actually act on it. If the pattern is a fixed historical or structural fact nobody can change from this chart, OMIT this entirely rather than forcing a generic action.

If ${chartSpec.y} is a rate, share, ratio or average, the categories do NOT add up to a meaningful total — compare them directly (e.g. "X is about 4× Y"), render any 0–1 value as a percentage (e.g. 0.742 → 74%, 0.189 → 19%) rather than a raw decimal, and never say "X% of the total".

Use general business sense where it does not contradict the numbers.${wantsBusinessCommentary ? '\n\nADDITIONALLY: produce `businessCommentary` (see schema) — 1–2 sentences framing the chart\'s metric against the FMCG/Marico domain context. Cite the pack id verbatim. Treat the domain context as orientation only; numeric evidence still comes only from this chart.' : ''}

CHART CONTEXT
- Type: ${chartSpec.type}
- Title: ${chartSpec.title}
- X: ${chartSpec.x}${isCorrelationChart ? ' (FACTOR)' : ''}
${seriesKeys ? `- Series: ${chartSpec.seriesColumn?.trim() || 'series'} (${seriesKeys.join(', ')})\n` : ''}- Y: ${chartSpec.y}${isCorrelationChart ? ' (TARGET)' : ''}${isDualAxis ? ` | Y2: ${y2Label}` : ''}
- Points: ${chartData.length}
- Y stats: ${formatY(minY)}–${formatY(maxY)} (avg ${formatY(avgY)}, 75th percentile: ${formatY(yP75)})${isDualAxis ? ` | Y2: ${formatY2(minY2)}–${formatY2(maxY2)} (avg ${formatY2(avgY2)})` : ''}

${dataFactsContext}${pivotPatternsSection}
${scatterBlock}${correlationContext}${userQuestionBlock}${sacBlock}${permBlock}${chatInsightsContext}${domainBlock}

OUTPUT JSON (exact keys only):
{
  "keyInsight": "Plain-English sentences (3–5), ≤${KEY_INSIGHT_MAX_CHARS} characters, no statistics jargon. Use the actual numbers from above (never labels like P75/P90). For categorical X, name the leading ${topPerfDimension} and its ${chartSpec.y} from DATA FACTS using the category's EXACT label text (not a synonym) so it ties back to the chart, explain in plain words what the pattern means, add a likely reason when there is a credible one, and a next step only if the reader can act on it."${businessCommentaryRequest}
}`;

  try {
    const response = await callLlm(
      {
        model: getInsightModel() as string,
        messages: [
          {
            role: 'system',
            content: `You are a senior analyst briefing a busy manager who is NOT a statistician. Output JSON with a single key "keyInsight": 3–5 plain-English sentences interpreting the chart using ONLY the provided numbers. Tell the story in this order, including only the parts that genuinely apply: the headline comparison (with real numbers), what drives it, a likely real-world reason for it, and — only when the reader can actually act on it — one concrete next step.

WRITE FOR A NON-MATH READER — translate the analysis, never parrot jargon:
- BANNED words (must never appear in the output): mass, quartile, upper-quartile, lower-quartile, bottom-quartile, percentile, P25, P75, P90, HHI, CV, coefficient of variation, concentration index, long-tail, dispersion, trough. PIVOT PATTERNS labels are internal signals only — read them, then say it plainly.
- Prefer plain phrasing: "nearly 4× higher", "about 3 in 4", "drives most of the total", "spread fairly evenly", "just one group does most of it", "the highest / lowest point" — not index or percentile language.

ANTI-PATTERNS — do NOT write any of these:
- "Increase {y} where {y} is low" / "improve underperformers" / "lift weaker segments" — generic, not a mechanism.
- "Focus on {top}" / "prioritize {leader}" without naming a *mechanism* (price, distribution, mix, segment, channel, cadence, season).
- Sentences that only restate which value is highest or lowest with no interpretation.
- Vague next-actions ("monitor", "investigate further", "look deeper"). If you give a next step, make it specific and clearly worth doing.
- A forced next step when nothing can be done: if the pattern is a fixed historical or structural fact the reader cannot change, OMIT the next step instead of inventing a generic one.

A "likely reason" is a plausible cause drawn from the question and general world / business knowledge (e.g. why one group leads, why a season spikes). Frame it as a likely explanation, not a measured fact, and never attach invented numbers to it.

NEVER META-HEDGE: do not describe your OWN reasoning or the evidence as uncertain/undefined/incomplete (banned: "HHI is undefined", "CV not informative", "cannot be stated from the supplied evidence", "the data may be mis-coded or not populated", "from this slice alone"). When a series is ALL ZERO (or every value is the same), do not analyze its (non-existent) spread — state the plain, likely DOMAIN reason for the flatness in one sentence (e.g. "Adherence is 0% for every planned type here because it is only recorded on Market-Working days — the other types are not measurement opportunities, not low performers."), then stop. A flat-zero metric is an expected structural fact, not a data-quality problem to speculate about.

Never use percentile shorthand like P75 or P90 — use numeric values. Always abbreviate magnitudes ≥1000 with K / M / B (e.g. 108547 → 109K, 15240 → 15.2K, 1500000 → 1.5M); never emit raw digit strings for thousands or millions. No markdown bold/headers in the string.`,
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

    const candidate = truncateInsight(modelKeyInsight);

    // W12 · parse the optional businessCommentary the model emits when domain
    // context was supplied. Cap to 500 chars to match the persisted schema;
    // null/empty/whitespace cleanly drops the field.
    let businessCommentary: string | undefined;
    if (wantsBusinessCommentary) {
      const raw = result.businessCommentary;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed && trimmed.toLowerCase() !== "null") {
          businessCommentary = trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 499)}…`;
        }
      }
    }

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
      // Wave 2 · prefer the pattern-driven fallback when patterns are usable
      // (it produces 4-claim narratives keyed off concentration / dispersion /
      // trend / relationship / diagnostic families instead of the formulaic
      // "prioritize the leader, lift the laggards" template).
      const usePatternFallback =
        pivotPatterns.topPerformers.length > 0 && pivotPatterns.rowCount >= 2;

      if (usePatternFallback) {
        const { text } = buildPatternDrivenFallback({
          patterns: pivotPatterns,
          chartSpec,
          dimensionLabel: topPerfDimension,
          formatY,
        });
        return {
          keyInsight: insertSentenceBreaks(truncateInsight(text)),
          ...(businessCommentary ? { businessCommentary } : {}),
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
      });

      return {
        keyInsight: insertSentenceBreaks(truncateInsight(fallback)),
        ...(businessCommentary ? { businessCommentary } : {}),
      };
    }

    return {
      keyInsight: insertSentenceBreaks(enforceInsightLimit(candidate)),
      ...(businessCommentary ? { businessCommentary } : {}),
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


