import { ChartSpec, Insight, DataSummary } from '../shared/schema.js';
import { calculateSmartDomainsForChart } from './axisScaling.js';
import { callLlm } from './agents/runtime/callLlm.js';
import { LLM_PURPOSE } from './agents/runtime/llmCallPurpose.js';
import { getBatchInsightTemperature, getInsightModel } from './insightSynthesis/insightModelConfig.js';
import { generateChartInsights } from './insightGenerator.js';
import { generateStreamingCorrelationChart } from './streamingCorrelationAnalyzer.js';
import {
  toNumber,
  type CorrelationResult,
  calculateCorrelations,
  calculateEtaSquared,
  calculateCategoricalCorrelations,
} from './correlationMath.js';

export { calculateCorrelations, calculateEtaSquared, calculateCategoricalCorrelations };

// Calculate linear regression (slope and intercept) for trend line
function linearRegression(xValues: number[], yValues: number[]): { slope: number; intercept: number } | null {
  const n = Math.min(xValues.length, yValues.length);
  if (n === 0) return null;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xValues[i];
    const y = yValues[i];
    if (isNaN(x) || isNaN(y)) continue;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return { slope, intercept };
}

export async function analyzeCorrelations(
  data: Record<string, any>[],
  targetVariable: string,
  numericColumns: string[],
  filter: 'all' | 'positive' | 'negative' = 'all',
  sortOrder?: 'ascending' | 'descending',
  chatInsights?: Insight[],
  maxResults?: number,
  onProgress?: (message: string, processed?: number, total?: number) => void,
  sessionId?: string,
  generateCharts: boolean = true,
  categoricalColumns?: string[],
  // W15 · optional synthesis context so per-chart insight generation can also
  // produce `businessCommentary` (FMCG/Marico framing). Backwards-compatible:
  // pre-W15 callers still work and produce keyInsight only.
  synthesisContext?: import("./insightSynthesis/types.js").ChartInsightSynthesisContext
): Promise<{ charts: ChartSpec[]; insights: Insight[] }> {
  console.log('=== CORRELATION ANALYSIS DEBUG ===');
  console.log('Target variable:', targetVariable);
  console.log('Numeric columns to analyze:', numericColumns);
  console.log('Categorical columns to analyze:', categoricalColumns ?? []);
  console.log('Data rows:', data.length);

  // Redis cache removed - proceed with calculation

  // Pearson correlations for numeric columns
  const numericCorrelations = calculateCorrelations(data, targetVariable, numericColumns);

  // Correlation ratio (η) for categorical columns
  const catCorrelations = categoricalColumns?.length
    ? calculateCategoricalCorrelations(data, targetVariable, categoricalColumns)
    : [];

  // Merge and sort by |correlation| descending
  const correlations = [...numericCorrelations, ...catCorrelations]
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const categoricalSet = new Set(categoricalColumns ?? []);

  console.log('Correlations calculated:', correlations);
  console.log('=== RAW CORRELATION VALUES DEBUG ===');
  correlations.forEach((corr, idx) => {
    console.log(`RAW ${idx + 1}. ${corr.variable}: ${corr.correlation} (${corr.correlation > 0 ? 'POSITIVE' : 'NEGATIVE'})`);
  });
  console.log('=== END RAW CORRELATION DEBUG ===');

  if (correlations.length === 0) {
    console.error('No correlations found!');
    return { charts: [], insights: [] };
  }

  // Apply filter if requested
  let filteredCorrelations = correlations;
  if (filter === 'positive') {
    filteredCorrelations = correlations.filter(c => c.correlation > 0);
    console.log(`Filtering: Showing only POSITIVE correlations (${filteredCorrelations.length} of ${correlations.length})`);
  } else if (filter === 'negative') {
    filteredCorrelations = correlations.filter(c => c.correlation < 0);
    console.log(`Filtering: Showing only NEGATIVE correlations (${filteredCorrelations.length} of ${correlations.length})`);
  }

  if (filteredCorrelations.length === 0) {
    const filterMessage = filter === 'positive' 
      ? 'No positive correlations found.' 
      : filter === 'negative' 
      ? 'No negative correlations found.' 
      : 'No correlations found.';
    console.warn(filterMessage);
    return { 
      charts: [], 
      insights: [{
        id: 1,
        text: `**No ${filter === 'positive' ? 'positive' : 'negative'} correlations found:** ${filterMessage} All correlations with ${targetVariable} are ${filter === 'positive' ? 'negative' : 'positive'}.`
      }] 
    };
  }

  // Get top correlations (by absolute value, then apply filter)
  const sortedCorrelations = filteredCorrelations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  
  // Apply limit if specified (e.g., "top 10"), otherwise show all
  const topCorrelations = maxResults 
    ? sortedCorrelations.slice(0, maxResults)
    : sortedCorrelations;
  
  if (maxResults) {
    console.log(`Limiting to top ${maxResults} correlations as requested`);
  }

  // Only generate charts if explicitly requested
  let scatterCharts: ChartSpec[] = [];
  let charts: ChartSpec[] = [];
  
  if (generateCharts) {
    // Generate scatter plots for top 3 correlations using streaming computation
    // IMPORTANT: For correlation/impact questions, target variable ALWAYS goes on Y-axis
    // X-axis = factor variable (what we can change), Y-axis = target variable (what we want to improve)
    // Only generate scatter plots for numeric (Pearson) correlations — categorical X can't scatter
    const numericTopCorrelations = topCorrelations.filter(c => !categoricalSet.has(c.variable));
    const scatterChartsPromises = numericTopCorrelations.slice(0, 3).map(async (corr, idx) => {
    // Helper function to convert Date objects to strings for schema validation
    const convertValueForSchema = (value: any): string | number | null => {
      if (value === null || value === undefined) return null;
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'number') return isNaN(value) || !isFinite(value) ? null : value;
      if (typeof value === 'string') return value;
      return String(value);
    };

    // Use streaming correlation computation for large datasets
    // This computes correlation on full dataset but only sends sampled points for visualization
    const chartTitle = `Generating correlation chart ${idx + 1}/3: ${corr.variable} vs ${targetVariable}`;
    if (onProgress) {
      onProgress(chartTitle, 0, data.length);
    }
    console.log(`📊 ${chartTitle}`);

    const chart = await generateStreamingCorrelationChart(
      data,
      targetVariable,
      corr.variable,
      (processed, total) => {
        if (onProgress) {
          const progressMessage = `Processing ${corr.variable} vs ${targetVariable}: ${processed.toLocaleString()}/${total.toLocaleString()} rows`;
          onProgress(progressMessage, processed, total);
        }
        if (idx === 0) { // Only log progress for first chart to avoid spam
          console.log(`   Progress: ${processed}/${total} rows processed`);
        }
      }
    );

    if (onProgress) {
      onProgress(`Completed correlation chart ${idx + 1}/3`, data.length, data.length);
    }

    // Override correlation with the one from topCorrelations (already computed)
    // This ensures consistency with the correlation ranking
    const metadata = (chart as any)._correlationMetadata || {};
    console.log(`Scatter chart ${idx}: ${corr.variable} vs ${targetVariable}, correlation: ${corr.correlation.toFixed(2)}, total pairs: ${corr.nPairs}, visualization points: ${chart.data?.length || 0}`);

    return {
      ...chart,
      title: `${corr.variable} vs ${targetVariable} (r=${corr.correlation.toFixed(2)})`,
      _correlationMetadata: {
        ...metadata,
        correlation: corr.correlation, // Use correlation from ranking
        nPairs: corr.nPairs || metadata.nPairs,
      },
    };
  });
  
    // Wait for all charts to be generated
    scatterCharts = await Promise.all(scatterChartsPromises);

    // Only add bar chart if we have multiple correlations
    charts = [...scatterCharts];
    
    if (topCorrelations.length > 1) {
    // IMPORTANT: Do NOT modify correlation signs - show actual positive/negative values
    console.log('=== BAR CHART CORRELATION VALUES DEBUG ===');
    topCorrelations.forEach((corr, idx) => {
      console.log(`${idx + 1}. ${corr.variable}: ${corr.correlation} (${corr.correlation > 0 ? 'POSITIVE' : 'NEGATIVE'})`);
    });
    console.log('=== END BAR CHART DEBUG ===');
    
    // Sort by correlation value only if user explicitly requested a sort order
    let sortedForBar: typeof topCorrelations;
    if (sortOrder === 'descending') {
      // Descending: highest to lowest (positive to negative)
      sortedForBar = [...topCorrelations].sort((a, b) => b.correlation - a.correlation);
    } else if (sortOrder === 'ascending') {
      // Ascending: lowest to highest (negative to positive)
      sortedForBar = [...topCorrelations].sort((a, b) => a.correlation - b.correlation);
    } else {
      // No explicit sort order requested - use default order (already sorted by absolute value)
      sortedForBar = topCorrelations;
    }
    
    const correlationBarChart: ChartSpec = {
      type: 'bar',
      title: `Correlation Between ${targetVariable} and Variables`,
      x: 'variable',
      y: 'correlation',
      xLabel: 'variable',
      yLabel: 'correlation',
      data: sortedForBar.map((corr) => ({
        variable: corr.variable,
        correlation: corr.correlation, // CRITICAL: Keep original sign (positive/negative)
      })),
    };
    
    console.log('=== FINAL BAR CHART DATA DEBUG ===');
    console.log('Bar chart data being sent to frontend:');
    const barData = (correlationBarChart.data || []) as Array<{ variable: string; correlation: number }>;
    barData.forEach((item, idx) => {
      const corrVal = Number(item.correlation);
      console.log(`FINAL ${idx + 1}. ${item.variable}: ${corrVal} (${corrVal > 0 ? 'POSITIVE' : 'NEGATIVE'})`);
    });
    console.log('=== END FINAL BAR CHART DEBUG ===');
    
      charts.push(correlationBarChart);
    }

    console.log('Total charts generated:', charts.length);
  } else {
    console.log('Charts generation skipped (user did not explicitly request charts)');
  }
  
  console.log('=== END CORRELATION DEBUG ===');

  // Enrich each chart with keyInsight and recommendation
  try {
    const summaryStub: DataSummary = {
      rowCount: data.length,
      columnCount: Object.keys(data[0] || {}).length,
      columns: Object.keys(data[0] || {}).map((name) => ({ name, type: typeof (data[0] || {})[name], sampleValues: [] as any })),
      numericColumns: numericColumns,
      dateColumns: [],
    } as unknown as DataSummary;

    const chartsWithInsights = await Promise.all(
      charts.map(async (c) => {
        const chartInsights = await generateChartInsights(
          c,
          c.data || [],
          summaryStub,
          chatInsights,
          synthesisContext
        );
        return {
          ...c,
          keyInsight: chartInsights.keyInsight,
          ...(chartInsights.businessCommentary
            ? { businessCommentary: chartInsights.businessCommentary }
            : {}),
        } as ChartSpec;
      })
    );
    charts.splice(0, charts.length, ...chartsWithInsights);
  } catch (e) {
    console.error('Failed to enrich correlation charts with insights:', e);
  }

  // Generate AI insights about correlations (use the same correlations shown in charts)
  // Pass data and summary for quantified recommendations
  const summaryStub: DataSummary = {
    rowCount: data.length,
    columnCount: Object.keys(data[0] || {}).length,
    columns: Object.keys(data[0] || {}).map((name) => ({ name, type: typeof (data[0] || {})[name], sampleValues: [] as any })),
    numericColumns: numericColumns,
    dateColumns: [],
  } as unknown as DataSummary;
  // Pass topCorrelations (same as used in charts) to ensure insights match what's displayed
  const insights = await generateCorrelationInsights(targetVariable, topCorrelations, data, summaryStub, filter, categoricalSet);

  const result = { charts, insights };

  // Redis cache removed

  return result;
}

async function generateCorrelationInsights(
  targetVariable: string,
  correlations: CorrelationResult[],
  data?: Record<string, any>[],
  summary?: DataSummary,
  filter: 'all' | 'positive' | 'negative' = 'all',
  categoricalSet?: Set<string>
): Promise<Insight[]> {
  // Ensure filter is defined (defensive check)
  const correlationFilter: 'all' | 'positive' | 'negative' = filter || 'all';
  
  // Calculate quantified statistics for correlations if data is available
  // Include statistics for all correlations (or top 10 if there are many) to help AI generate better insights
  let quantifiedStats = '';
  if (data && data.length > 0 && summary) {
    const correlationsForStats = correlations.slice(0, Math.min(correlations.length, 10));
    quantifiedStats = '\n\nQUANTIFIED STATISTICS FOR FACTORS:\n';
    
    for (const corr of correlationsForStats) {
      const factorValues = data
        .map(row => Number(String(row[corr.variable]).replace(/[%,,]/g, '')))
        .filter(v => !isNaN(v));
      const targetValues = data
        .map(row => Number(String(row[targetVariable]).replace(/[%,,]/g, '')))
        .filter(v => !isNaN(v));
      
      // Categorical variable: compute group means for the target
      if (factorValues.length === 0 && categoricalSet?.has(corr.variable)) {
        const groupMeans = new Map<string, { sum: number; count: number }>();
        for (const row of data) {
          const g = row[corr.variable];
          const v = toNumber(row[targetVariable]);
          if (g != null && !isNaN(v)) {
            const key = String(g);
            if (!groupMeans.has(key)) groupMeans.set(key, { sum: 0, count: 0 });
            const entry = groupMeans.get(key)!;
            entry.sum += v;
            entry.count += 1;
          }
        }
        if (groupMeans.size > 0) {
          const sorted = Array.from(groupMeans.entries())
            .map(([g, { sum, count }]) => ({ group: g, mean: sum / count }))
            .sort((a, b) => b.mean - a.mean);
          const top3 = sorted.slice(0, 3).map(x => `${x.group}: ${x.mean.toFixed(0)}`).join(', ');
          const bot3 = sorted.slice(-3).reverse().map(x => `${x.group}: ${x.mean.toFixed(0)}`).join(', ');
          quantifiedStats += `\n${corr.variable} (η=${corr.correlation.toFixed(3)}, categorical):\n`;
          quantifiedStats += `- Avg ${targetVariable} by group (top): ${top3}\n`;
          if (sorted.length > 3) quantifiedStats += `- Avg ${targetVariable} by group (bottom): ${bot3}\n`;
          quantifiedStats += `- Groups: ${sorted.length}\n`;
        }
        continue;
      }

      if (factorValues.length > 0 && targetValues.length > 0) {
        const factorAvg = factorValues.reduce((a, b) => a + b, 0) / factorValues.length;
        // Calculate min/max without spread operator to avoid stack overflow
        let factorMin = factorValues[0];
        let factorMax = factorValues[0];
        for (let i = 1; i < factorValues.length; i++) {
          if (factorValues[i] < factorMin) factorMin = factorValues[i];
          if (factorValues[i] > factorMax) factorMax = factorValues[i];
        }
        // Sort once and reuse for percentiles
        const sortedFactorValues = [...factorValues].sort((a, b) => a - b);
        const factorP25 = sortedFactorValues[Math.floor(sortedFactorValues.length * 0.25)];
        const factorP75 = sortedFactorValues[Math.floor(sortedFactorValues.length * 0.75)];
        
        const targetAvg = targetValues.reduce((a, b) => a + b, 0) / targetValues.length;
        // Calculate min/max without spread operator to avoid stack overflow
        let targetMin = targetValues[0];
        let targetMax = targetValues[0];
        for (let i = 1; i < targetValues.length; i++) {
          if (targetValues[i] < targetMin) targetMin = targetValues[i];
          if (targetValues[i] > targetMax) targetMax = targetValues[i];
        }
        // Sort once and reuse for percentiles
        const sortedTargetValues = [...targetValues].sort((a, b) => a - b);
        const targetP75 = sortedTargetValues[Math.floor(sortedTargetValues.length * 0.75)];
        const targetP90 = sortedTargetValues[Math.floor(sortedTargetValues.length * 0.9)];
        
        // Find factor values for top target performers
        const pairs = data
          .map(row => ({
            factor: Number(String(row[corr.variable]).replace(/[%,,]/g, '')),
            target: Number(String(row[targetVariable]).replace(/[%,,]/g, ''))
          }))
          .filter(p => !isNaN(p.factor) && !isNaN(p.target));
        
        const topTargetPairs = pairs
          .sort((a, b) => b.target - a.target)
          .slice(0, Math.min(10, Math.floor(pairs.length * 0.2)));
        
        const optimalFactorRange = topTargetPairs.length > 0 ? {
          min: (() => {
            const factors = topTargetPairs.map(p => p.factor);
            let min = factors[0];
            for (let i = 1; i < factors.length; i++) {
              if (factors[i] < min) min = factors[i];
            }
            return min;
          })(),
          max: (() => {
            const factors = topTargetPairs.map(p => p.factor);
            let max = factors[0];
            for (let i = 1; i < factors.length; i++) {
              if (factors[i] > max) max = factors[i];
            }
            return max;
          })(),
          avg: topTargetPairs.reduce((sum, p) => sum + p.factor, 0) / topTargetPairs.length
        } : null;
        
        const formatValue = (val: number, isPercent: boolean = false): string => {
          if (!isFinite(val)) return 'N/A';
          const abs = Math.abs(val);
          const fmt = abs >= 100 ? val.toFixed(0) : abs >= 10 ? val.toFixed(1) : abs >= 1 ? val.toFixed(2) : val.toFixed(3);
          return isPercent ? `${fmt}%` : fmt;
        };
        
        const factorIsPercent = data.some(row => typeof row[corr.variable] === 'string' && row[corr.variable].includes('%'));
        const targetIsPercent = data.some(row => typeof row[targetVariable] === 'string' && row[targetVariable].includes('%'));
        
        quantifiedStats += `\n${corr.variable} (r=${corr.correlation.toFixed(2)}):
- Factor range: ${formatValue(factorMin, factorIsPercent)} to ${formatValue(factorMax, factorIsPercent)} (avg: ${formatValue(factorAvg, factorIsPercent)}, 25th-75th percentile range: ${formatValue(factorP25, factorIsPercent)}-${formatValue(factorP75, factorIsPercent)})
- Target range: ${formatValue(targetMin, targetIsPercent)} to ${formatValue(targetMax, targetIsPercent)} (avg: ${formatValue(targetAvg, targetIsPercent)}, 75th percentile: ${formatValue(targetP75, targetIsPercent)}, 90th percentile: ${formatValue(targetP90, targetIsPercent)})
${optimalFactorRange ? `- Optimal ${corr.variable} range for top ${targetVariable} performers: ${formatValue(optimalFactorRange.min, factorIsPercent)}-${formatValue(optimalFactorRange.max, factorIsPercent)} (avg: ${formatValue(optimalFactorRange.avg, factorIsPercent)})` : ''}
`;
      }
    }
  }
  
  // Determine dynamic insight limit based on number of correlations
  // Generate insights for all correlations shown (matching what's in charts)
  const insightCount = correlations.length;
  
  const filterContext = correlationFilter === 'positive' 
    ? '\nIMPORTANT: The user specifically requested ONLY POSITIVE correlations. All correlations shown are positive. Focus your insights on these positive relationships only.'
    : correlationFilter === 'negative'
    ? '\nIMPORTANT: The user specifically requested ONLY NEGATIVE correlations. All correlations shown are negative. Focus your insights on these negative relationships only.'
    : '';

  const hasCategorical = categoricalSet && categoricalSet.size > 0 &&
    correlations.some(c => categoricalSet.has(c.variable));

  const prompt = `Analyze these correlations with ${targetVariable}.${filterContext}
${hasCategorical ? '\nNOTE: Variables marked (η) are categorical. Their coefficient is the correlation ratio η = √(SS_between/SS_total), range 0–1. It measures how much of the variance in ' + targetVariable + ' is explained by that category grouping. It is NOT Pearson r and cannot be negative.\n' : ''}
DATA HANDLING RULES (must follow exactly):
- Pearson correlation using pairwise deletion: if either value is NA on a row, exclude that row; do not impute.
- Use the EXACT signed correlation values provided; never change the sign.
- Cover ALL variables at least once in the insights (do not omit any listed below).
${correlationFilter === 'positive' ? '- All correlations shown are POSITIVE (user filtered out negative ones).' : ''}
${correlationFilter === 'negative' ? '- All correlations shown are NEGATIVE (user filtered out positive ones).' : ''}

VALUES (variable: coefficient, nPairs):
${correlations.map((c) => {
  const isCat = categoricalSet?.has(c.variable);
  const label = isCat ? `${c.variable} (η)` : c.variable;
  return `- ${label}: ${c.correlation.toFixed(3)}, n=${c.nPairs ?? 'NA'}`;
}).join('\n')}
${quantifiedStats}

CONTEXT:
- ${targetVariable} is the outcome (Y). Listed variables are factors (X).
- For numeric variables (Pearson r): explain sign and strength in plain language.
- For categorical variables (η): explain what proportion of variance is explained and which groups drive the differences.
- Tie in numbers from QUANTIFIED STATISTICS when present, and give a practical “what to try next” or “what to validate” that respects that correlation ≠ causation.
- Vary prose structure across insights; avoid repeating the same bullet template every time.

Write exactly ${insightCount} insights (one per variable, strongest correlation first). End each insight with a short line: “Reminder: Correlation does not imply causation.”

Return JSON only: {“insights”:[{“text”:”...”}, ...]} with exactly ${insightCount} items.`;

  const response = await callLlm(
    {
      model: getInsightModel(),
      messages: [
        {
          role: 'system',
          content: `You are a senior data analyst. Return valid JSON: {"insights":[{"text":"..."}]}. Each text must include r and n, interpretation grounded in the provided stats, and end with "Reminder: Correlation does not imply causation." Do not use P75/P90 shorthand—use numeric values from the prompt.`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: getBatchInsightTemperature(),
      max_tokens: Math.min(2000 + Math.max(0, (insightCount - 7) * 200), 10000),
    },
    { purpose: LLM_PURPOSE.CORRELATION_INSIGHT }
  );

  const content = response.choices[0].message.content || '{}';
  console.log('📝 Raw AI response for correlation insights (first 1000 chars):', content.substring(0, 1000));
  console.log('📊 Expected insight count:', insightCount);
  console.log('📋 Variables to analyze:', correlations.map(c => c.variable).join(', '));

  try {
    const parsed = JSON.parse(content);
    console.log('✅ Parsed JSON successfully');
    
    // Validate that insights is an array
    if (!parsed.insights || !Array.isArray(parsed.insights)) {
      console.error('❌ Invalid response format: insights is not an array', parsed);
      // Try to recover - check if there's a different structure
      if (parsed.insight && Array.isArray(parsed.insight)) {
        console.log('⚠️ Found "insight" instead of "insights", using that');
        parsed.insights = parsed.insight;
      } else {
        console.error('❌ No valid insights array found in response');
        return [];
      }
    }
    
    const insightArray = parsed.insights || [];
    console.log(`📊 Found ${insightArray.length} insights in response (expected ${insightCount})`);
    
    // Validate and clean insights
    const validInsights = insightArray
      .slice(0, insightCount)
      .map((item: any, index: number) => {
        // Handle different response formats
        if (typeof item === 'string') {
          // If item is a string, use it directly
          return {
            id: index + 1,
            text: item,
          };
        } else if (typeof item === 'object' && item !== null) {
          // If item is an object, extract text field
          const text = item.text || item.insight || item.content || item.description || '';
          if (!text || text.trim().length === 0) {
            console.warn(`⚠️ Insight ${index + 1} has no text field, skipping`);
            return null;
          }
          return {
            id: index + 1,
            text: text.trim(),
          };
        } else {
          // Skip invalid items (booleans, numbers, null, etc.)
          console.warn(`⚠️ Insight ${index + 1} is invalid type (${typeof item}), skipping`);
          return null;
        }
      })
      .filter((insight): insight is { id: number; text: string } => insight !== null);
    
    console.log(`✅ Returning ${validInsights.length} valid insights`);
    
    // If we got fewer insights than expected, log a warning
    if (validInsights.length < insightCount) {
      console.warn(`⚠️ Generated ${validInsights.length} insights but expected ${insightCount}`);
    }
    
    return validInsights;
  } catch (error) {
    console.error('❌ Error parsing correlation insights:', error);
    console.error('Raw content that failed to parse:', content.substring(0, 1000));
    return [];
  }
}
