/**
 * generateInsightForCharts — the ONE reusable per-chart insight seam.
 *
 * Extracted from `enrichCharts` (services/chat/chatResponse.service.ts) so that
 * EVERY server path that produces a chart can guarantee an auto-generated
 * insight, not just the chat answer pipeline. Before this, only `enrichCharts`
 * auto-generated insights; dashboard sheets, budget-optimiser charts, feature
 * sweep tiles, etc. relied on a late best-effort pass (or hardcoded jargon) and
 * frequently shipped with empty insight footers.
 *
 * Engine: `generateChartInsights` (lib/insightGenerator.ts) — owns the IUX2
 * grounding gate (accepts 0–1 rates rendered as percent) + rate-awareness.
 *
 * IDEMPOTENT (load-bearing): a chart that already carries a non-empty
 * `keyInsight` is passed through untouched. This makes a second pass a no-op,
 * so the chat safety-net pass and any in-tool generation never double-generate
 * or overwrite a hand-seeded insight. It also makes "reuse-by-signature first,
 * generate only the gaps" trivial — copy insights onto charts, then call this;
 * only the still-bare charts hit the LLM.
 *
 * NO depthBudget / queryIntent gate lives here (invariant #12): the decision of
 * whether to PRODUCE an extra chart stays upstream in visualPlanner / the agent
 * loop. Any chart that exists gets an insight, unconditionally.
 */
import { ChartSpec, DataSummary, Insight, SessionAnalysisContext } from '../shared/schema.js';
import { resolveChartDataRowsForEnrichment } from './chartEnrichmentRows.js';
import { capChartDataPoints } from './chartDownsampling.js';
import { generateChartInsights } from './insightGenerator.js';
import { logger } from './logger.js';

/** Default cap to prevent memory issues on general charts. */
export const MAX_CHART_DATA_POINTS = 50000;
/** Higher cap for correlation scatter charts so users can see more points. */
export const MAX_CORRELATION_POINTS = 300000;

/**
 * Synthesis context forwarded to `generateChartInsights`. Mirrors the prior
 * inline shape in `enrichCharts`; the `sessionAnalysisContext` fallback to the
 * chat document is applied by the caller before it reaches here.
 */
export type ChartEnrichmentContext = {
  userQuestion?: string;
  sessionAnalysisContext?: SessionAnalysisContext;
  permanentContext?: string;
  /**
   * W12 · composed FMCG/Marico domain context. When set, chart insight
   * generation gains a `businessCommentary` field framing the metric against
   * the domain pack glossary.
   */
  domainContext?: string;
};

export interface InsightEnrichmentDeps {
  /** Rows to ground insights on — the active-filtered slice analytical tools see. */
  filteredRawData: Record<string, unknown>[];
  /** Dataset summary (date columns + rowCount for the correlation cap). */
  dataSummary?: DataSummary;
  /** Chat-level insights the engine may reuse when there is no active question. */
  chatLevelInsights?: Insight[];
  /** Rows for charts flagged `_useAnalyticalDataOnly` (data stripped upstream). */
  analyticalFallbackRows?: Record<string, unknown>[];
  /** Synthesis context (question / SAC / notes / domain). */
  context?: ChartEnrichmentContext;
  /**
   * When `false`, the resolved rows are used to COMPUTE the insight but are NOT
   * spread back onto the chart as `data`. Dashboard charts carry frozen inline
   * data and only want the insight; the chat pipeline wants both (default).
   */
  attachData?: boolean;
}

/**
 * Enrich a single chart with `keyInsight` (+ optional `businessCommentary`).
 * Idempotent: a chart with a usable `keyInsight` is returned unchanged (no LLM
 * call), aside from the optional `data` attachment.
 */
export async function enrichChartWithInsight(
  c: any,
  deps: InsightEnrichmentDeps,
): Promise<any> {
  const { filteredRawData, dataSummary, chatLevelInsights, analyticalFallbackRows, context } = deps;
  const attachData = deps.attachData !== false;

  let dataForChart = resolveChartDataRowsForEnrichment(
    c,
    filteredRawData as Record<string, any>[],
    dataSummary?.dateColumns,
    analyticalFallbackRows,
  );

  // Cap data size for memory efficiency. Correlation scatter charts
  // (`_isCorrelationChart`) get a much higher cap so users see more points.
  const isCorrelationChart = Boolean((c as any)._isCollisionChart || (c as any)._isCorrelationChart);
  const effectiveMax =
    isCorrelationChart && dataSummary?.rowCount
      ? Math.max(MAX_CHART_DATA_POINTS, Math.min(MAX_CORRELATION_POINTS, dataSummary.rowCount))
      : MAX_CHART_DATA_POINTS;

  if (dataForChart.length > effectiveMax) {
    logger.log(
      `⚠️ Chart "${c.title}" has ${dataForChart.length} data points, limiting to ${effectiveMax}`,
    );
    dataForChart = capChartDataPoints(dataForChart, c.type, effectiveMax);
  }

  // Idempotency gate: skip generation when a usable insight already exists.
  const hasUsableKeyInsight =
    typeof c.keyInsight === 'string' && c.keyInsight.trim().length > 0;
  const insights = !hasUsableKeyInsight
    ? await generateChartInsights(
        c as ChartSpec,
        dataForChart,
        dataSummary as DataSummary,
        chatLevelInsights,
        {
          userQuestion: context?.userQuestion,
          sessionAnalysisContext: context?.sessionAnalysisContext,
          permanentContext: context?.permanentContext,
          domainContext: context?.domainContext,
        },
      )
    : null;

  // W12 · prefer existing businessCommentary on the chart, then the newly
  // generated one, then leave undefined.
  const businessCommentary =
    (typeof c.businessCommentary === 'string' && c.businessCommentary.trim().length > 0
      ? c.businessCommentary
      : insights?.businessCommentary) ?? undefined;

  return {
    ...c,
    ...(attachData ? { data: dataForChart } : {}),
    keyInsight: hasUsableKeyInsight ? c.keyInsight : (insights?.keyInsight ?? c.keyInsight),
    ...(businessCommentary ? { businessCommentary } : {}),
  };
}

/**
 * Enrich a batch of charts with insights, sequentially (avoids memory spikes
 * from parallel data resolution on large datasets). A per-chart failure falls
 * back to the un-enriched chart rather than failing the whole batch.
 */
export async function generateInsightForCharts(
  charts: any[],
  deps: InsightEnrichmentDeps,
): Promise<any[]> {
  if (!charts || !Array.isArray(charts)) {
    return [];
  }
  const enrichedCharts: any[] = [];
  for (const c of charts) {
    try {
      enrichedCharts.push(await enrichChartWithInsight(c, deps));
    } catch (chartError) {
      logger.error(`Error enriching chart "${c?.title}":`, chartError);
      // Include chart without enrichment rather than failing completely.
      enrichedCharts.push(c);
    }
  }
  return enrichedCharts;
}
