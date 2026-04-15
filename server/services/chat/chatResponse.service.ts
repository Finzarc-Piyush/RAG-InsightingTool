/**
 * Chat Response Service
 * Handles response validation, enrichment, and formatting
 */
import { chatResponseSchema, ThinkingStep, SessionAnalysisContext } from "../../shared/schema.js";
import { resolveChartDataRowsForEnrichment } from "../../lib/chartEnrichmentRows.js";
import { generateChartInsights } from "../../lib/insightGenerator.js";
import { ChatDocument } from "../../models/chat.model.js";

export type ChartEnrichmentContext = {
  userQuestion?: string;
  sessionAnalysisContext?: SessionAnalysisContext;
  permanentContext?: string;
};

/**
 * Enrich charts with data and insights
 * Memory-optimized for large datasets
 */
export async function enrichCharts(
  charts: any[],
  chatDocument: ChatDocument,
  chatLevelInsights?: any[],
  analyticalFallbackRows?: Record<string, unknown>[],
  enrichmentContext?: ChartEnrichmentContext
): Promise<any[]> {
  if (!charts || !Array.isArray(charts)) {
    return [];
  }

  const MAX_CHART_DATA_POINTS = 50000; // Default limit to prevent memory issues
  const MAX_CORRELATION_POINTS = 300000; // Higher limit for correlation scatter charts

  try {
    // Process charts sequentially to avoid memory spikes from parallel processing
    const enrichedCharts: any[] = [];
    
    for (const c of charts) {
      try {
        let dataForChart = resolveChartDataRowsForEnrichment(
          c,
          chatDocument.rawData,
          chatDocument.dataSummary?.dateColumns,
          analyticalFallbackRows
        );

        // Limit data size for memory efficiency.
        // For general charts, cap at MAX_CHART_DATA_POINTS.
        // For correlation scatter charts (marked with _isCorrelationChart),
        // allow a much higher cap so users can see more points.
        const isCorrelationChart = Boolean((c as any)._isCollisionChart || (c as any)._isCorrelationChart);
        const effectiveMax =
          isCorrelationChart && chatDocument?.dataSummary?.rowCount
            ? Math.max(MAX_CHART_DATA_POINTS, Math.min(MAX_CORRELATION_POINTS, chatDocument.dataSummary.rowCount))
            : MAX_CHART_DATA_POINTS;

        if (dataForChart.length > effectiveMax) {
          console.log(
            `⚠️ Chart "${c.title}" has ${dataForChart.length} data points, limiting to ${effectiveMax}`
          );
          if (c.type === "line" || c.type === "area") {
            const step = Math.ceil(dataForChart.length / effectiveMax);
            dataForChart = dataForChart.filter((_: any, idx: number) => idx % step === 0).slice(0, effectiveMax);
          } else {
            dataForChart = dataForChart.slice(0, effectiveMax);
          }
        }
        
        const hasUsableKeyInsight =
          typeof c.keyInsight === "string" && c.keyInsight.trim().length > 0;
        const insights = !hasUsableKeyInsight
          ? await generateChartInsights(c, dataForChart, chatDocument.dataSummary, chatLevelInsights, {
              userQuestion: enrichmentContext?.userQuestion,
              sessionAnalysisContext:
                enrichmentContext?.sessionAnalysisContext ?? chatDocument.sessionAnalysisContext,
              permanentContext: enrichmentContext?.permanentContext,
            })
          : null;

        enrichedCharts.push({
          ...c,
          data: dataForChart,
          keyInsight: hasUsableKeyInsight ? c.keyInsight : (insights?.keyInsight ?? c.keyInsight),
        });
      } catch (chartError) {
        console.error(`Error enriching chart "${c.title}":`, chartError);
        // Include chart without enrichment rather than failing completely
        enrichedCharts.push(c);
      }
    }
    
    return enrichedCharts;
  } catch (e) {
    console.error('Final enrichment of chat charts failed:', e);
    return charts;
  }
}

/**
 * Derive insights from charts if missing
 */
export function deriveInsightsFromCharts(charts: any[]): { id: number; text: string }[] {
  if (!charts || !Array.isArray(charts) || charts.length === 0) {
    return [];
  }

  try {
    const derived = charts
      .map((c: any, idx: number) => {
        const text = c?.keyInsight || (c?.title ? `Insight: ${c.title}` : null);
        return text ? { id: idx + 1, text } : null;
      })
      .filter(Boolean) as { id: number; text: string }[];
    return derived;
  } catch {
    return [];
  }
}

/**
 * After response insights are final, copy chat-level insight text onto chart.keyInsight so the
 * zoom modal matches InsightCard (single chart → first insight; N charts + N insights → by index).
 */
export function alignChartKeyInsightsToChatInsights(validated: any): any {
  const charts = validated?.charts;
  const insights = validated?.insights;
  if (!Array.isArray(charts) || charts.length === 0) return validated;
  if (!Array.isArray(insights) || insights.length === 0) return validated;

  if (charts.length === 1) {
    const t = insights[0]?.text;
    if (typeof t === "string" && t.trim().length > 0) {
      return {
        ...validated,
        charts: [{ ...charts[0], keyInsight: t }],
      };
    }
    return validated;
  }

  if (charts.length === insights.length) {
    return {
      ...validated,
      charts: charts.map((c: any, i: number) => {
        const t = insights[i]?.text;
        if (typeof t === "string" && t.trim().length > 0) {
          return { ...c, keyInsight: t };
        }
        return c;
      }),
    };
  }

  return validated;
}

/**
 * Validate and enrich chat response
 */
export function validateAndEnrichResponse(result: any, chatDocument: ChatDocument, chatLevelInsights?: any[]): any {
  // Validate response has answer
  if (!result || !result.answer || result.answer.trim().length === 0) {
    throw new Error('Empty answer from answerQuestion');
  }

  // Validate response schema
  let validated = chatResponseSchema.parse(result);

  // Ensure overall chat insights always present: derive from charts if missing
  if ((!validated.insights || validated.insights.length === 0) && Array.isArray(validated.charts) && validated.charts.length > 0) {
    const derived = deriveInsightsFromCharts(validated.charts);
    if (derived.length > 0) {
      validated = { ...validated, insights: derived } as any;
    }
  }

  return alignChartKeyInsightsToChatInsights(validated);
}

/**
 * Create error response
 */
export function createErrorResponse(error: Error | string): any {
  const errorMessage = error instanceof Error ? error.message : error;
  return {
    error: errorMessage,
    answer: `I'm sorry, I encountered an error: ${errorMessage}. Please try again or rephrase your question.`,
    charts: [],
    insights: [],
  };
}

