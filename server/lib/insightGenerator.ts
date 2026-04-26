import { ChartSpec, DataSummary, Insight } from '../shared/schema.js';
import { callLlm } from './agents/runtime/callLlm.js';
import { LLM_PURPOSE } from './agents/runtime/llmCallPurpose.js';
import type { ChartInsightSynthesisContext } from './insightSynthesis/types.js';
import { formatSessionAnalysisContextForInsight } from './insightSynthesis/formatSessionContext.js';
import { getInsightModel, getInsightTemperature } from './insightSynthesis/insightModelConfig.js';

// keyInsight: grounded numbers + LLM interpretation (1–3 tight sentences typical).
const KEY_INSIGHT_MAX_CHARS = 1400;

const normalizeInsightText = (value: string) => (value || '').replace(/\s+/g, ' ').trim();
const enforceInsightLimit = (value: string) => {
  if (value.length > KEY_INSIGHT_MAX_CHARS) {
    console.warn(`⚠️ keyInsight exceeded ${KEY_INSIGHT_MAX_CHARS} characters`, {
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
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  const roundSmart = (v: number): string => {
    if (!isFinite(v)) return String(v);
    const abs = Math.abs(v);
    if (abs >= 100) return v.toFixed(0);
    if (abs >= 10) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(2);
    return v.toFixed(3);
  };

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
      const dx = x[i] - mx;
      const dy = y[i] - my;
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
  const xValuesForTopY = topYIndices.map(idx => Number(String(chartData[idx][chartSpec.x]).replace(/[%,,]/g, ''))).filter(v => !isNaN(v));
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
    const topX = topPerformers.length > 0 ? topPerformers[0].x : undefined;
    const topY = topPerformers.length > 0 ? topPerformers[0].y : undefined;
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
        return { keyInsight: enforceInsightLimit(candidate) };
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

  // Build chat insights context if available
  const chatInsightsContext = chatInsights && chatInsights.length > 0
    ? `\n\nRELEVANT CHAT-LEVEL INSIGHTS (optional cross-check; prefer DATA FACTS + user question):
${chatInsights.map((insight, idx) => `${idx + 1}. ${insight.text}`).join('\n')}

The keyInsight should relate this chart (${chartSpec.x}, ${chartSpec.y}${isDualAxis ? `, ${y2Label}` : ''}) to the analysis; 1–3 tight sentences, ≤${KEY_INSIGHT_MAX_CHARS} characters total.`
    : '';

  const dataFactsContext = `
DATA FACTS (ground truth from the chart data; use these explicitly in the output):
- Top ${chartSpec.y} performer(s) by ${chartSpec.x}: ${topPerformerStr}
- Bottom ${chartSpec.y} performer(s) by ${chartSpec.x}: ${bottomPerformerStr}
${isDualAxis ? `- Top ${y2Label} performer(s): ${topPerformerStrY2}\n- Bottom ${y2Label} performer(s): ${bottomPerformerStrY2}` : ''}`.trim();

  const scatterBlock = scatterNumericFactsBlock ? `\n${scatterNumericFactsBlock}\n` : '';

  const prompt = `Return JSON with one field: keyInsight.

TASK: Write 1–3 short sentences (plain text, no markdown headings) that interpret THIS chart for someone making a business or operational decision. Ground every number in DATA FACTS / blocks below—do not invent metrics. Add "so what" (risk, opportunity, segment story, or next check) using only what the data plausibly supports; use general business sense where it does not contradict the numbers.

CHART CONTEXT
- Type: ${chartSpec.type}
- Title: ${chartSpec.title}
- X: ${chartSpec.x}${isCorrelationChart ? ' (FACTOR)' : ''}
- Y: ${chartSpec.y}${isCorrelationChart ? ' (TARGET)' : ''}${isDualAxis ? ` | Y2: ${y2Label}` : ''}
- Points: ${chartData.length}
- Y stats: ${formatY(minY)}–${formatY(maxY)} (avg ${formatY(avgY)}, 75th percentile: ${formatY(yP75)})${isDualAxis ? ` | Y2: ${formatY2(minY2)}–${formatY2(maxY2)} (avg ${formatY2(avgY2)})` : ''}

${dataFactsContext}
${scatterBlock}${correlationContext}${userQuestionBlock}${sacBlock}${permBlock}${chatInsightsContext}

OUTPUT JSON (exact keys only):
{
  "keyInsight": "Plain sentences, ≤${KEY_INSIGHT_MAX_CHARS} characters. Use numeric values from above; never output labels like P75/P90—use the actual numbers. For categorical X, name the leading ${chartSpec.x} and its ${chartSpec.y} from DATA FACTS."
}`;

  try {
    const response = await callLlm(
      {
        model: getInsightModel() as string,
        messages: [
          {
            role: 'system',
            content: `You are a senior analyst. Output JSON with a single key "keyInsight": 1–3 sentences interpreting the chart using ONLY provided numbers. Connect metrics to implications (segments, concentration, tradeoffs, what to test next) where justified. Never use percentile shorthand like P75 or P90—use numeric values. No markdown bold/headers in the string.`,
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: getInsightTemperature(),
        max_tokens: 900,
      },
      { purpose: LLM_PURPOSE.INSIGHT_GEN }
    );

    const content = response.choices[0].message.content || '{}';
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

    // Deterministic verification: ensure the output explicitly names the top category/value.
    const topX = topPerformers.length > 0 ? topPerformers[0].x : undefined;
    const topY = topPerformers.length > 0 ? topPerformers[0].y : undefined;
    const topXNorm = topX === undefined || topX === null ? '' : String(topX).toLowerCase().trim();
    const topYStr = typeof topY === 'number' && !isNaN(topY) ? formatY(topY) : '';

    const candidateLower = candidate.toLowerCase();
    let passes = true;
    const rVal = bothNumeric && !isCorrelationChart ? pearsonR(numericX, numericY) : NaN;
    const rStr = !isNaN(rVal) ? roundSmart(rVal).toLowerCase() : '';

    if (topYStr) {
      passes = passes && candidateLower.includes(topYStr.toLowerCase());
    }
    if (isCategoricalX && topXNorm) {
      passes = passes && candidateLower.includes(topXNorm);
    }
    // Numeric XY: allow grounding via Pearson r if top-Y string match failed (e.g. formatting).
    if (!isCategoricalX && bothNumeric && !isCorrelationChart && topYStr && !passes && rStr) {
      passes = candidateLower.includes(rStr);
    }

    if (!passes && topX !== undefined && typeof topY === 'number' && !isNaN(topY)) {
      const bottomThresholdStr =
        bottomPerformers.length > 0 && typeof bottomPerformers[0]?.y === 'number'
          ? formatY(bottomPerformers[0].y)
          : formatY(yP25);

      const fallback = `Top ${chartSpec.x} "${topX}" has the highest ${chartSpec.y} at ${formatY(topY)} (avg ${formatY(avgY)}, p75 ${formatY(yP75)}). To lift ${chartSpec.y}, prioritize ${chartSpec.x} "${topX}" and target moving weaker segments above ${bottomThresholdStr}.`;

      return { keyInsight: truncateInsight(fallback) };
    }

    return { keyInsight: enforceInsightLimit(candidate) };
  } catch (error) {
    console.error('Error generating chart insights:', error);
    return {
      keyInsight: `This ${chartSpec.type} chart shows ${chartData.length} data points with values ranging from ${minY.toFixed(2)} to ${maxY.toFixed(2)}`
    };
  }
}


