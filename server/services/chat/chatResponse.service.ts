/**
 * Chat Response Service
 * Handles response validation, enrichment, and formatting
 */
import { chatResponseSchema, ThinkingStep, SessionAnalysisContext } from "../../shared/schema.js";
import { resolveChartDataRowsForEnrichment } from "../../lib/chartEnrichmentRows.js";
import { generateChartInsights } from "../../lib/insightGenerator.js";
import { generatePivotEnvelope } from "../../lib/insightGenerator/pivotEnvelope.js";
import { formatCompactNumber } from "../../lib/formatCompactNumber.js";
import { ChatDocument } from "../../models/chat.model.js";
import { applyActiveFilter } from "../../lib/activeFilter/applyActiveFilter.js";
import { logger } from "../../lib/logger.js";

export type ChartEnrichmentContext = {
  userQuestion?: string;
  sessionAnalysisContext?: SessionAnalysisContext;
  permanentContext?: string;
  /**
   * W12 · composed FMCG/Marico domain context. When set, chart insight
   * generation gains a `businessCommentary` field framing the metric
   * against the domain pack glossary.
   */
  domainContext?: string;
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
    
    // Wave-FA5 · The chart enrichment fallback reaches into chatDocument.rawData
    // directly (i.e. bypassing loadLatestData). Apply the active-filter overlay
    // so chart insights derived here see the same slice as analytical tools.
    const filteredRawData = applyActiveFilter(
      chatDocument.rawData ?? [],
      chatDocument.activeFilter
    );

    for (const c of charts) {
      try {
        let dataForChart = resolveChartDataRowsForEnrichment(
          c,
          filteredRawData,
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
          logger.log(
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
              domainContext: enrichmentContext?.domainContext,
            })
          : null;

        // W12 · prefer existing businessCommentary on the chart, then the
        // newly-generated one, then leave undefined.
        const businessCommentary =
          (typeof c.businessCommentary === "string" && c.businessCommentary.trim().length > 0
            ? c.businessCommentary
            : insights?.businessCommentary) ?? undefined;

        enrichedCharts.push({
          ...c,
          data: dataForChart,
          keyInsight: hasUsableKeyInsight ? c.keyInsight : (insights?.keyInsight ?? c.keyInsight),
          ...(businessCommentary ? { businessCommentary } : {}),
        });
      } catch (chartError) {
        logger.error(`Error enriching chart "${c.title}":`, chartError);
        // Include chart without enrichment rather than failing completely
        enrichedCharts.push(c);
      }
    }
    
    return enrichedCharts;
  } catch (e) {
    logger.error('Final enrichment of chat charts failed:', e);
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
 * Derive the final concluding "Insights" card from the narrator's structured
 * answer envelope. The envelope already contains decision-grade content
 * (findings, implications, recommendations) — surfacing them here gives the
 * bottom InsightCard the same analytical depth as the intermediate body
 * bubble, without spending a fresh LLM call.
 *
 * Returns an empty array when the envelope has no usable structured content;
 * the caller falls back to `deriveInsightsFromCharts` in that case (legacy /
 * dataOps turns).
 */
export function deriveInsightsFromEnvelope(
  envelope: any
): { id: number; text: string }[] {
  if (!envelope || typeof envelope !== "object") return [];

  const items: string[] = [];
  const findings = Array.isArray(envelope.findings) ? envelope.findings : [];
  const implications = Array.isArray(envelope.implications) ? envelope.implications : [];
  const recommendations = Array.isArray(envelope.recommendations) ? envelope.recommendations : [];

  for (const f of findings) {
    const headline = typeof f?.headline === "string" ? f.headline.trim() : "";
    const evidence = typeof f?.evidence === "string" ? f.evidence.trim() : "";
    const magnitude = typeof f?.magnitude === "string" ? f.magnitude.trim() : "";
    if (!headline && !evidence) continue;
    const main = headline && evidence ? `**${headline}** — ${evidence}` : `**${headline || "Finding"}**${evidence ? ` ${evidence}` : ""}`;
    items.push(magnitude ? `${main} (${magnitude})` : main);
  }

  for (const impl of implications) {
    const statement = typeof impl?.statement === "string" ? impl.statement.trim() : "";
    const soWhat = typeof impl?.soWhat === "string" ? impl.soWhat.trim() : "";
    if (!statement && !soWhat) continue;
    items.push([statement, soWhat].filter(Boolean).join(" "));
  }

  for (const rec of recommendations) {
    const action = typeof rec?.action === "string" ? rec.action.trim() : "";
    const rationale = typeof rec?.rationale === "string" ? rec.rationale.trim() : "";
    if (!action && !rationale) continue;
    const body = action && rationale ? `${action} — ${rationale}` : action || rationale;
    items.push(`**Recommendation:** ${body}`);
  }

  const capped = items.slice(0, 6);
  return capped.map((text, idx) => ({ id: idx + 1, text }));
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
 * Render a small result set (e.g. a quick-lookup top-N result) as a GFM markdown
 * table for the answer prose. The chat MarkdownRenderer now folds GFM pipe-table
 * blocks into a real <table> (see client markdownTable.ts), so this surfaces the
 * rows as a table inline. Capped at `maxRows` × `maxCols` so the answer never
 * balloons; pipes in values are escaped.
 */
export function renderResultTableForAnswer(
  rows: Array<Record<string, unknown>>,
  opts?: { maxRows?: number; maxCols?: number },
): string {
  const maxRows = opts?.maxRows ?? 15;
  const maxCols = opts?.maxCols ?? 6;
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const cols = Object.keys(rows[0] ?? {}).slice(0, maxCols);
  if (cols.length === 0) return "";
  const cell = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "—") : String(v);
    return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
  };
  const headerRow = `| ${cols.map((c) => cell(c)).join(" | ")} |`;
  const separator = `| ${cols.map(() => "---").join(" | ")} |`;
  const bodyRows = rows
    .slice(0, maxRows)
    .map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`);
  const lines = [headerRow, separator, ...bodyRows];
  if (rows.length > maxRows) {
    lines.push("", `_…and ${rows.length - maxRows} more._`);
  }
  return lines.join("\n");
}

/**
 * Validate and enrich chat response
 */
export function validateAndEnrichResponse(result: any, chatDocument: ChatDocument, chatLevelInsights?: any[]): any {
  // Quick-lookup fast lane (quickAnswerPath.ts) returns a table-ONLY result by
  // design — `answer: ""` + a populated `table` ("the preview table IS the
  // answer; no narrator preamble"). That contract is incompatible with the
  // empty-answer guard below, so a successful simple lookup (e.g. "top 10 X by
  // Y") would otherwise throw "Empty answer from answerQuestion" and surface as
  // an error to the user even though the query returned rows. Honor the
  // contract: when the answer is empty but a non-empty table is present,
  // synthesize a concise one-line answer from the plan rationale (the restated
  // question the fast-lane already computed) so the response carries text +
  // table. This does NOT change quickAnswerPath's own (tested) `answer: ""`
  // contract — only how the shared response gate renders a table-only result.
  if (
    result &&
    (typeof result.answer !== "string" || result.answer.trim().length === 0) &&
    Array.isArray(result.table) &&
    result.table.length > 0
  ) {
    const restated =
      typeof result.agentTrace?.planRationale === "string"
        ? result.agentTrace.planRationale.trim()
        : "";
    const title = restated.length > 0 ? restated : "Here are the results.";
    // Surface the actual rows in the prose as a GFM markdown table (the chat
    // MarkdownRenderer now renders pipe-tables as real <table>s) so the user
    // always sees their data in the answer bubble, even if the interactive
    // pivot/preview doesn't auto-render.
    const table = renderResultTableForAnswer(result.table);
    result.answer = table ? `${title}\n\n${table}` : title;
  }

  // Validate response has answer
  if (!result || !result.answer || result.answer.trim().length === 0) {
    throw new Error('Empty answer from answerQuestion');
  }

  // Wave QL5 · `loopResult.pivotArtifacts` carries RAW pivot captures (with
  // `rows`) for the async materializer at
  // `chatStream.service.ts:342-373`, which turns them into the schema-shaped
  // form (`artifactId` / `rowCount` / `storage`) before patching the
  // past_analyses doc. The chat-response schema expects the materialized
  // form, so feeding raw artifacts into `chatResponseSchema.parse` crashes
  // the whole turn with a Zod error and the dashboard never builds. Strip
  // them out before validation; re-attach after so the downstream
  // materializer's `transformedResponse.pivotArtifacts` read still works.
  // Behaviour-neutral for legacy turns that don't carry pivotArtifacts.
  let rawPivotArtifacts: unknown = undefined;
  let inputForValidation: any = result;
  if (result && typeof result === "object" && "pivotArtifacts" in result) {
    rawPivotArtifacts = (result as { pivotArtifacts?: unknown }).pivotArtifacts;
    const { pivotArtifacts: _unused, ...rest } = result as Record<string, unknown>;
    void _unused;
    inputForValidation = rest;
  }

  // Validate response schema
  let validated = chatResponseSchema.parse(inputForValidation);

  if (rawPivotArtifacts !== undefined) {
    (validated as { pivotArtifacts?: unknown }).pivotArtifacts = rawPivotArtifacts;
  }

  // Ensure overall chat insights always present.
  // Preferred source (analytical turns): the narrator's structured answerEnvelope
  // — its findings + implications + recommendations give the final InsightCard
  // the same analytical depth as the intermediate body bubble. The envelope is
  // now part of `chatResponseSchema` (named `messageAnswerEnvelopeSchema`), so
  // `validated.answerEnvelope` is preserved through `parse`. We still read from
  // the raw `result` here so synthesizer fallbacks that ship an envelope-shaped
  // object outside the schema's surface (e.g. dataOps turns) keep working.
  // Fallback (legacy / dataOps turns without an envelope): derive numbered
  // bullets from each chart's `keyInsight` as before.
  let insightsFromEnvelope = false;
  if (!validated.insights || validated.insights.length === 0) {
    const envelope =
      (validated as { answerEnvelope?: unknown }).answerEnvelope ??
      (result as any)?.answerEnvelope;
    const fromEnvelope = deriveInsightsFromEnvelope(envelope);
    if (fromEnvelope.length > 0) {
      validated = { ...validated, insights: fromEnvelope } as any;
      insightsFromEnvelope = true;
    } else if (Array.isArray(validated.charts) && validated.charts.length > 0) {
      const derived = deriveInsightsFromCharts(validated.charts);
      if (derived.length > 0) {
        validated = { ...validated, insights: derived } as any;
      }
    }
  }

  // The alignment step copies a chat-level insight onto chart.keyInsight so
  // the zoom modal matches the InsightCard. When insights came from the
  // envelope, the chart-card keyInsight is intentionally chart-specific
  // (3–5 substantive sentences from generateChartInsights) and the
  // InsightCard carries finding/implication/recommendation prose — the two
  // surfaces should differ, so skip alignment in that path.
  return insightsFromEnvelope
    ? validated
    : alignChartKeyInsightsToChatInsights(validated);
}

/**
 * Wave 3 · when the response carries a pivot view but the answer envelope
 * lacked findings (dataOps / legacy turns), the pivot tab's "Key insight"
 * falls through to the chart's keyInsight — which can read shallow. This
 * runs a single narrator-style call against the pivot's primary chart and
 * replaces `validated.insights` with finding/implication/recommendation
 * bullets so the pivot view matches the chat-analysis InsightCard.
 *
 * No-op when:
 *   - `validated.pivotDefaults` is unset (no pivot rendered)
 *   - the original `result.answerEnvelope` already had findings
 *   - there is no chart data to ground the envelope on
 */
export async function enrichPivotInsightFromEnvelope(
  rawResult: any,
  validated: any,
  options?: {
    userQuestion?: string;
    domainContext?: string;
    intentEnvelope?: import("../../lib/agents/runtime/types.js").IntentEnvelope;
  }
): Promise<any> {
  if (!validated || !validated.pivotDefaults) return validated;

  const env = (rawResult as any)?.answerEnvelope;
  const envHasFindings = Array.isArray(env?.findings) && env.findings.length > 0;
  if (envHasFindings) return validated;

  const charts = Array.isArray(validated.charts) ? validated.charts : [];
  const pivotChart = charts.find((c: any) => Array.isArray(c?.data) && c.data.length > 0);
  if (!pivotChart) return validated;

  try {
    const pivotEnv = await generatePivotEnvelope({
      chartSpec: pivotChart,
      chartData: pivotChart.data,
      formatY: (n: number) => formatCompactNumber(n),
      userQuestion: options?.userQuestion,
      domainContext: options?.domainContext,
      intentEnvelope: options?.intentEnvelope,
    });

    const items: string[] = [];
    for (const f of pivotEnv.findings) {
      const main = f.headline && f.evidence ? `**${f.headline}** — ${f.evidence}` : `**${f.headline || "Finding"}**${f.evidence ? ` ${f.evidence}` : ""}`;
      items.push(f.magnitude ? `${main} (${f.magnitude})` : main);
    }
    for (const i of pivotEnv.implications) {
      items.push([i.statement, i.soWhat].filter(Boolean).join(" "));
    }
    for (const r of pivotEnv.recommendations) {
      const body = r.action && r.rationale ? `${r.action} — ${r.rationale}` : r.action || r.rationale;
      if (body) items.push(`**Recommendation:** ${body}`);
    }
    if (items.length === 0) return validated;

    const newInsights = items.slice(0, 6).map((text, idx) => ({ id: idx + 1, text }));
    return { ...validated, insights: newInsights };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Wave 3 · enrichPivotInsightFromEnvelope failed: ${msg}`);
    return validated;
  }
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

