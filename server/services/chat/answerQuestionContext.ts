/**
 * Shared preparation for answerQuestion: column-aware loading, DuckDB sample path,
 * and permanentContext — used by both streaming and non-streaming chat.
 *
 * **Enriched working dataset:** Agent analysis must be seeded from the same persisted
 * table the session summary describes (see `loadLatestData` → `currentDataBlob` priority).
 * Avoid answering from a raw slice while `dataSummary.dateColumns` reflects enriched/Cleaned_* columns.
 */
import type { Message } from "../../shared/schema.js";
import type { ChatDocument } from "../../models/chat.model.js";
import type { ParsedQuery } from "../../shared/queryTypes.js";
import { loadLatestData, loadDataForColumns } from "../../utils/dataLoader.js";
import { extractRequiredColumns, extractColumnsFromHistory } from "../../lib/agents/utils/columnExtractor.js";
import { classifyIntent } from "../../lib/agents/intentClassifier.js";
import { parseUserQuery } from "../../lib/queryParser.js";
import { isInformationSeekingQuery, isAnalyticalQuery } from "../../lib/analyticalQueryEngine.js";
import { getSampleFromDuckDB } from "../../lib/duckdbPlanExecutor.js";
import { isAgenticLoopEnabled } from "../../lib/agents/runtime/types.js";
import { canonicalizeDateColumnValues } from "../../lib/fileParser.js";
import {
  applyTemporalFacetColumns,
  periodDimensionFromSummary,
} from "../../lib/temporalFacetColumns.js";
import { logger } from "../../lib/logger.js";

export interface AnswerQuestionDataLoadResult {
  latestData: Record<string, any>[];
  columnarStoragePathOpt?: boolean;
  loadFullDataOpt?: () => Promise<Record<string, any>[]>;
  permanentContext?: string;
  sessionAnalysisContext?: import("../../shared/schema.js").SessionAnalysisContext;
}

export async function resolveAnswerQuestionDataLoad(params: {
  chatDocument: ChatDocument;
  message: string;
  processingChatHistory: Message[];
  /** When set (e.g. from processStreamChat), skips duplicate classifyIntent / column extraction */
  precomputed?: {
    requiredColumns: string[];
    parsedQuery: Record<string, any> | null;
  };
}): Promise<AnswerQuestionDataLoadResult> {
  const { chatDocument, message, processingChatHistory, precomputed } = params;

  let requiredColumns: string[] = precomputed?.requiredColumns ?? [];
  let parsedQuery: Record<string, any> | null = precomputed?.parsedQuery ?? null;

  if (precomputed) {
    logger.log(
      `📊 [resolveAnswerQuestionDataLoad] using precomputed columns (${requiredColumns.length}) — skipping classifyIntent`
    );
  }

  if (!precomputed) {
    try {
      const intent = await classifyIntent(message, processingChatHistory || [], chatDocument.dataSummary);
      try {
        parsedQuery = await parseUserQuery(
          message,
          chatDocument.dataSummary,
          processingChatHistory || []
        );
      } catch {
        // optional
      }
      const historyColumns = extractColumnsFromHistory(processingChatHistory || [], chatDocument.dataSummary);
      requiredColumns = extractRequiredColumns(
        message,
        intent,
        parsedQuery as ParsedQuery | null,
        null,
        chatDocument.dataSummary
      );
      requiredColumns = Array.from(new Set([...requiredColumns, ...historyColumns]));
      logger.log(`📊 [resolveAnswerQuestionDataLoad] ${requiredColumns.length} required columns`);
    } catch (error) {
      logger.warn("⚠️ Failed to extract required columns, loading full/latest data:", error);
    }
  }

  // Agentic loop: always widen to the full schema so ctx.exec.data matches
  // ctx.exec.summary. The streaming path supplies `precomputed` to skip the
  // expensive classifyIntent calls above, but that must not prevent us from
  // loading every column — the agent's own tools pick what to query.
  if (
    isAgenticLoopEnabled() &&
    chatDocument.dataSummary?.columns?.length
  ) {
    const allNames = chatDocument.dataSummary.columns.map((c) => c.name);
    requiredColumns = Array.from(new Set([...requiredColumns, ...allNames]));
  }

  const queryFilters = parsedQuery
    ? {
        timeFilters: parsedQuery.timeFilters || undefined,
        valueFilters: parsedQuery.valueFilters || undefined,
        exclusionFilters: parsedQuery.exclusionFilters || undefined,
      }
    : undefined;

  const columnarStoragePath = !!(chatDocument as { columnarStoragePath?: string }).columnarStoragePath;
  const useDuckDBPlan =
    columnarStoragePath &&
    (isInformationSeekingQuery(message) || isAnalyticalQuery(message));

  let latestData: Record<string, any>[];
  // The agent's analytical tools (execute_query_plan → DuckDB) must know the
  // columnar surface exists whenever the session is materialized — NOT only
  // when the query-shape heuristic (useDuckDBPlan) matches. Imperative commands
  // like "give a pjp dashboard." match neither isInformationSeekingQuery nor
  // isAnalyticalQuery, so gating the flag on useDuckDBPlan left ctx.exec
  // .columnarStoragePath undefined and hard-failed every aggregation step with
  // "DuckDB execution surface is not available" — even though the data was
  // materialized. Derive the flag from materialization state directly.
  const columnarStoragePathOpt: boolean | undefined = columnarStoragePath
    ? true
    : undefined;
  let loadFullDataOpt: (() => Promise<Record<string, any>[]>) | undefined;

  if (useDuckDBPlan) {
    logger.log(
      "📊 Columnar session + analytical/info query: DuckDB sample path (shared loader)"
    );
    latestData = await getSampleFromDuckDB(chatDocument.sessionId, 5000, chatDocument);
    const dateCols = chatDocument.dataSummary?.dateColumns;
    if (latestData.length > 0 && dateCols && dateCols.length > 0) {
      canonicalizeDateColumnValues(latestData, dateCols);
      applyTemporalFacetColumns(latestData, dateCols, {
        periodDimension: periodDimensionFromSummary(chatDocument.dataSummary),
      });
    }
    loadFullDataOpt = () =>
      requiredColumns.length > 0
        ? loadDataForColumns(chatDocument, requiredColumns, queryFilters)
        : loadLatestData(chatDocument, undefined, queryFilters);
  } else {
    latestData =
      requiredColumns.length > 0
        ? await loadDataForColumns(chatDocument, requiredColumns, queryFilters)
        : await loadLatestData(chatDocument, undefined, queryFilters);
    logger.log(`✅ Loaded ${latestData.length} rows for analysis (shared loader)`);
  }

  return {
    latestData,
    columnarStoragePathOpt,
    loadFullDataOpt,
    permanentContext: chatDocument.permanentContext,
    sessionAnalysisContext: chatDocument.sessionAnalysisContext,
  };
}
