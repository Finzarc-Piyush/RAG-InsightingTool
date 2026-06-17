/**
 * Data Ops Orchestrator
 * Handles intent parsing, clarification flow, and coordinates data operations
 */
import { Message, DataSummary } from '../../shared/schema.js';
import { removeNulls, convertDataType } from './pythonService.js';
import type { SummaryResponse } from './pythonService.js';
import { saveModifiedData, persistAndPreview } from './dataPersistence.js';
import type { DataRow } from './dataOpsTypes.js';
import { updateChatDocument, ChatDocument } from '../../models/chat.model.js';
import { callLlm } from '../agents/runtime/callLlm.js';
import { LLM_PURPOSE } from '../agents/runtime/llmCallPurpose.js';
import {
  extractCustomValue,
  findMentionedColumn,
  findMatchingColumn,
  normalizeNumericValue,
} from "./dataOpsValueHelpers.js";
// ARCH-2 / CQ-2 · per-operation handlers extracted to sibling modules. Each is
// a behaviour-preserving move of one switch branch into a function taking a
// single typed args object; the orchestrator switch dispatches to them.
import { handleCountNulls } from "./handlers/countNulls.js";
import { handleDescribe } from "./handlers/describe.js";
import { handleSummary } from "./handlers/summary.js";
import { handleIdentifyOutliers } from "./handlers/identifyOutliers.js";
import { handleAggregate } from "./handlers/aggregate.js";
import { handlePivot } from "./handlers/pivot.js";
import { handleTrainModel } from "./handlers/trainModel.js";
import { handlePreview } from "./handlers/preview.js";
import { handleTreatOutliers } from "./handlers/treatOutliers.js";
import { handleCreateColumn } from "./handlers/createColumn.js";
import { handleCreateDerivedColumn } from "./handlers/createDerivedColumn.js";
import { handleRenameColumn } from "./handlers/renameColumn.js";
import { handleFilter } from "./handlers/filter.js";
import { handleRevert } from "./handlers/revert.js";
// ARCH-2 / CQ-2 · pure intent helpers extracted to `dataOps/intent/*`. These are
// side-effect-free predicates/translators over the message / intent shape with
// zero coupling to the orchestrator's locals or session state. Re-exported below
// so existing internal call sites (and the characterization test) keep working.
import { isCorrelationRequest } from "./intent/isCorrelationRequest.js";
import { userRequestedPreview } from "./intent/userRequestedPreview.js";
import { isDataModificationOperation } from "./intent/isDataModificationOperation.js";
import { translateLegacyFilterToActiveFilter } from "./intent/translateLegacyFilterToActiveFilter.js";
// ARCH-2 / CQ-2 · per-operation INTENT DETECTORS extracted from
// `parseDataOpsIntent`'s order-sensitive regex fallback chain. Each is a
// behaviour-preserving VERBATIM move of one regex block into a pure
// `detect<Op>(ctx): DataOpsIntent | null`; the parser composes them in the SAME
// order as the original blocks (FIRST-match-wins). See
// `docs/decisions/centralized-chart-builders.md` sibling: `dataOps/intent/*`.
import type { IntentDetectorContext } from "./intent/shared.js";
import { detectReplaceValue } from "./intent/detectReplaceValue.js";
import { detectRevert } from "./intent/detectRevert.js";
import { detectAggregate } from "./intent/detectAggregate.js";
import { detectPivot } from "./intent/detectPivot.js";
import { detectRemoveColumnHighConfidence } from "./intent/detectRemoveColumnHighConfidence.js";
import { detectRemoveRowsHighConfidence } from "./intent/detectRemoveRowsHighConfidence.js";
import { detectFillNulls } from "./intent/detectFillNulls.js";
import { detectRemoveNulls } from "./intent/detectRemoveNulls.js";
import { detectPreview } from "./intent/detectPreview.js";
import { detectCountNulls } from "./intent/detectCountNulls.js";
import { detectHowManyRowsCols } from "./intent/detectHowManyRowsCols.js";
import { detectSummary } from "./intent/detectSummary.js";
import { detectDescribe } from "./intent/detectDescribe.js";
import { detectCreateColumn } from "./intent/detectCreateColumn.js";
import { detectNormalizeColumn } from "./intent/detectNormalizeColumn.js";
import { detectRemoveRows } from "./intent/detectRemoveRows.js";
import { detectAddRow } from "./intent/detectAddRow.js";
import { detectModifyColumn } from "./intent/detectModifyColumn.js";
import { detectRenameColumn } from "./intent/detectRenameColumn.js";
import { detectRemoveColumn } from "./intent/detectRemoveColumn.js";
import { detectConvertType } from "./intent/detectConvertType.js";
import { detectTrainModel } from "./intent/detectTrainModel.js";

export {
  isCorrelationRequest,
  userRequestedPreview,
  isDataModificationOperation,
  translateLegacyFilterToActiveFilter,
};

export { isIdColumn, getCountNameForIdColumn } from "../columnIdHeuristics.js";
import { logger } from "../logger.js";
import { errorMessage } from "../../utils/errorMessage.js";

/**
 * Hermetic test seam for the AI intent detector (mirrors `__setFetchFnForTesting`
 * in `lib/dataOps/pythonService.ts`). `parseDataOpsIntent` runs AI detection first
 * and falls back to the ORDER-SENSITIVE regex chain only when the AI returns
 * `unknown`/`null` (or throws). A characterization test for that regex chain must
 * deterministically force the fallback regardless of whether OpenAI env vars are
 * set, so it injects a detector that returns `null` (→ fall through to regex).
 * Production MUST NOT call this (guarded under `NODE_ENV=production`). Pass `null`
 * to restore the real `detectDataOpsIntentWithAI`.
 */
type IntentAiDetector = (
  message: string,
  availableColumns: string[],
  chatHistory?: Message[],
  sessionDoc?: ChatDocument
) => Promise<DataOpsIntent | null>;

let intentAiDetectorOverride: IntentAiDetector | null = null;

export function __setIntentAiDetectorForTesting(
  fake: IntentAiDetector | null
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "__setIntentAiDetectorForTesting must not be called in production"
    );
  }
  intentAiDetectorOverride = fake;
}

// Streaming configuration for large datasets
const LARGE_DATASET_THRESHOLD = 50000; // 50k rows
const BATCH_SIZE = 10000; // Process 10k rows at a time

/**
 * Streaming helper: Process data in batches
 */
async function processInBatches<T>(
  data: DataRow[],
  batchSize: number,
  processor: (batch: DataRow[]) => Promise<T> | T
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const result = await processor(batch);
    results.push(result);
  }
  return results;
}

/**
 * Streaming version of removeNulls for large datasets
 * 
 * Note: For imputation methods (mean, median, mode), the Python service calculates
 * statistics from the full dataset, so we process in batches but the Python service
 * handles the imputation correctly. For delete operations, we can safely process in batches.
 */
async function removeNullsStreaming(
  data: DataRow[],
  column?: string,
  method: 'delete' | 'mean' | 'median' | 'mode' | 'custom' = 'delete',
  customValue?: any
): Promise<{ data: DataRow[]; nulls_removed: number; rows_before: number; rows_after: number }> {
  const rowsBefore = data.length;
  let totalNullsRemoved = 0;
  const processedBatches: DataRow[][] = [];
  
  // For imputation methods, the Python service needs the full dataset to calculate
  // accurate statistics (mean/median/mode). However, for very large datasets, we
  // can still process in batches and the Python service will handle it.
  // For delete operations, batch processing is straightforward.
  
  // Process in batches
  logger.log(`📊 Processing ${data.length} rows in batches of ${BATCH_SIZE}...`);
  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    const batchResult = await removeNulls(batch, column, method, customValue);
    processedBatches.push(batchResult.data);
    totalNullsRemoved += batchResult.nulls_removed;
    
    // Log progress every 5 batches
    if ((i + BATCH_SIZE) % (BATCH_SIZE * 5) === 0 || i + BATCH_SIZE >= data.length) {
      logger.log(`  Processed ${Math.min(i + BATCH_SIZE, data.length)} / ${data.length} rows...`);
    }
  }
  
  // Combine all batches
  const result = processedBatches.flat();
  
  logger.log(`✅ Streaming operation complete: ${totalNullsRemoved} nulls removed, ${rowsBefore} → ${result.length} rows`);
  
  return {
    data: result,
    nulls_removed: totalNullsRemoved,
    rows_before: rowsBefore,
    rows_after: result.length
  };
}

export interface DataOpsIntent {
  operation:
    | 'remove_nulls'
    | 'preview'
    | 'summary'
    | 'convert_type'
    | 'count_nulls'
    | 'describe'
    | 'create_derived_column'
    | 'create_column'
    | 'modify_column'
    | 'normalize_column'
    | 'remove_column'
    | 'rename_column'
    | 'remove_rows'
    | 'add_row'
    | 'aggregate'
    | 'pivot'
    | 'train_model'
    | 'replace_value'
    | 'identify_outliers'
    | 'treat_outliers'
    | 'filter'
    | 'revert'
    | 'unknown';
  column?: string;
  oldColumnName?: string; // For rename_column - the column to rename
  method?: 'delete' | 'mean' | 'median' | 'mode' | 'custom';
  customValue?: any;
  targetType?: 'numeric' | 'string' | 'date' | 'percentage' | 'boolean';
  limit?: number;
  previewMode?: 'first' | 'last' | 'specific' | 'range'; // For preview operations
  previewStartRow?: number; // For specific row or range start (1-based)
  previewEndRow?: number; // For range end (1-based)
  newColumnName?: string;
  expression?: string;
  defaultValue?: any; // For creating columns with static values
  transformType?: 'add' | 'subtract' | 'multiply' | 'divide';
  transformValue?: number;
  rowPosition?: 'first' | 'last' | 'keep_first';
  rowIndex?: number;
  rowCount?: number; // For removing multiple rows from start/end
  oldValue?: any; // For replace_value operation - the value to replace
  newValue?: any; // For replace_value operation - the value to replace with
  // Aggregation / pivot fields
  groupByColumn?: string; // For aggregate
  aggColumns?: string[];  // Optional explicit aggregation columns
  aggFunc?: 'sum' | 'avg' | 'mean' | 'min' | 'max' | 'count'; // Aggregation function (default: sum)
  aggFuncs?: Record<string, 'sum' | 'avg' | 'mean' | 'min' | 'max' | 'count'>; // Per-column aggregation functions
  orderByColumn?: string; // For sorting aggregated results
  orderByDirection?: 'asc' | 'desc'; // Sort direction (default: asc)
  pivotIndex?: string;    // For pivot - index column
  pivotValues?: string[]; // For pivot - value columns
  pivotFuncs?: Record<string, 'sum' | 'avg' | 'mean' | 'min' | 'max' | 'count'>; // Per-column aggregation functions for pivot
  requiresClarification: boolean;
  clarificationType?: 'column' | 'method' | 'target_type';
  clarificationMessage?: string;
  // ML model fields
  modelType?: 'linear' | 'log_log' | 'logistic' | 'ridge' | 'lasso' | 'random_forest' | 'decision_tree' | 'gradient_boosting' | 'elasticnet' | 'svm' | 'knn' | 'polynomial' | 'bayesian' | 'quantile' | 'poisson' | 'gamma' | 'tweedie' | 'extra_trees' | 'xgboost' | 'lightgbm' | 'catboost' | 'gaussian_process' | 'mlp' | 'multinomial_logistic' | 'naive_bayes_gaussian' | 'naive_bayes_multinomial' | 'naive_bayes_bernoulli' | 'lda' | 'qda';
  targetVariable?: string;
  features?: string[];
  // Outlier detection/treatment fields
  outlierMethod?: 'iqr' | 'zscore' | 'isolation_forest' | 'local_outlier_factor';
  outlierThreshold?: number; // For zscore (default: 3), for IQR multiplier (default: 1.5)
  treatmentMethod?: 'remove' | 'cap' | 'winsorize' | 'transform' | 'impute';
  treatmentValue?: 'mean' | 'median' | 'mode' | 'min' | 'max' | number; // For impute or cap methods
  // Filter operation fields
  filterConditions?: {
    column: string;
    operator: '>' | '>=' | '<' | '<=' | '=' | '!=' | 'contains' | 'startsWith' | 'endsWith' | 'between' | 'in';
    value?: any;
    value2?: any; // For 'between' operator
    values?: any[]; // For 'in' operator
  }[];
  logicalOperator?: 'AND' | 'OR'; // How to combine multiple filter conditions (default: 'AND')
}

export interface DataOpsContext {
  pendingOperation?: {
    operation: string;
    column?: string;
    timestamp: number;
  };
  lastQuery?: string;
  lastCreatedColumn?: string; // Track the most recently created column name
  timestamp: number;
}

/**
 * Parse user intent for data operations
 */
export async function parseDataOpsIntent(
  message: string,
  chatHistory: Message[],
  dataSummary: DataSummary,
  sessionDoc?: ChatDocument
): Promise<DataOpsIntent> {
  const lowerMessage = message.toLowerCase().trim();
  const availableColumns = dataSummary.columns.map(c => c.name);
  
  // ---------------------------------------------------------------------------
  // STEP -1: Correlation requests are ANALYSIS, not data ops – never treat as aggregate
  // ---------------------------------------------------------------------------
  if (isCorrelationRequest(message)) {
    logger.log(`📊 Correlation request detected – returning unknown to route to analysis (not aggregate).`);
    return {
      operation: 'unknown',
      requiresClarification: false,
      clarificationMessage: undefined,
    };
  }
  
  // ---------------------------------------------------------------------------
  // STEP 0: Use AI as PRIMARY method for ALL operations
  // AI is more flexible and can handle natural language variations better than regex
  // ---------------------------------------------------------------------------
  
  // Resolve context references BEFORE AI detection
  const { resolveContextReferences, findLastCreatedColumn } = await import('../agents/contextResolver.js');
  let resolvedMessage = message;
  if (chatHistory && chatHistory.length > 0) {
    resolvedMessage = resolveContextReferences(message, chatHistory);
    if (resolvedMessage !== message) {
      logger.log(`🔄 Context resolved: "${message}" → "${resolvedMessage}"`);
    }
  }

  // Try AI detection first for ALL operations (using resolved message)
  try {
    logger.log(`🤖 Calling AI to detect intent for: "${resolvedMessage}"`);
    const aiIntent = await (intentAiDetectorOverride ?? detectDataOpsIntentWithAI)(resolvedMessage, availableColumns, chatHistory, sessionDoc);
    if (aiIntent) {
      logger.log(`🤖 AI returned intent:`, {
        operation: aiIntent.operation,
        groupByColumn: aiIntent.groupByColumn,
        aggColumns: aiIntent.aggColumns,
        aggFunc: aiIntent.aggFunc,
        requiresClarification: aiIntent.requiresClarification,
        clarificationMessage: aiIntent.clarificationMessage,
      });
      
      if (aiIntent.operation !== 'unknown') {
        logger.log(`✅ AI detected intent: ${aiIntent.operation}`);
        
        // If rename_column and no column specified, try to find from context
        if (aiIntent.operation === 'rename_column' && !aiIntent.column && !aiIntent.oldColumnName) {
          const lastColumn = findLastCreatedColumn(chatHistory || []);
          if (lastColumn) {
            aiIntent.oldColumnName = lastColumn;
            aiIntent.column = lastColumn;
            logger.log(`📋 Using context column for rename: "${lastColumn}"`);
          }
        }
        
        // Fallback pattern matching for outlier treatment - fix common AI parsing issues
        if (aiIntent.operation === 'treat_outliers') {
          const lowerResolved = resolvedMessage.toLowerCase();
          
          // Pattern: "impute outliers with mean" or "impute with mean"
          if ((lowerResolved.includes('impute') && lowerResolved.includes('mean')) ||
              (lowerResolved.includes('replace') && lowerResolved.includes('outlier') && lowerResolved.includes('mean'))) {
            if (!aiIntent.treatmentMethod || aiIntent.treatmentMethod === 'remove') {
              logger.log(`🔧 Fixing treatment method: detected "impute with mean" but AI returned "${aiIntent.treatmentMethod}", correcting to "impute"`);
              aiIntent.treatmentMethod = 'impute';
              aiIntent.treatmentValue = 'mean';
            }
          }
          // Pattern: "impute outliers with median"
          else if ((lowerResolved.includes('impute') && lowerResolved.includes('median')) ||
                   (lowerResolved.includes('replace') && lowerResolved.includes('outlier') && lowerResolved.includes('median'))) {
            if (!aiIntent.treatmentMethod || aiIntent.treatmentMethod === 'remove') {
              logger.log(`🔧 Fixing treatment method: detected "impute with median" but AI returned "${aiIntent.treatmentMethod}", correcting to "impute"`);
              aiIntent.treatmentMethod = 'impute';
              aiIntent.treatmentValue = 'median';
            }
          }
          // Pattern: "impute outliers with mode"
          else if ((lowerResolved.includes('impute') && lowerResolved.includes('mode')) ||
                   (lowerResolved.includes('replace') && lowerResolved.includes('outlier') && lowerResolved.includes('mode'))) {
            if (!aiIntent.treatmentMethod || aiIntent.treatmentMethod === 'remove') {
              logger.log(`🔧 Fixing treatment method: detected "impute with mode" but AI returned "${aiIntent.treatmentMethod}", correcting to "impute"`);
              aiIntent.treatmentMethod = 'impute';
              aiIntent.treatmentValue = 'mode';
            }
          }
          
          logger.log(`📊 Final outlier treatment config:`, {
            treatmentMethod: aiIntent.treatmentMethod,
            treatmentValue: aiIntent.treatmentValue,
            outlierMethod: aiIntent.outlierMethod
          });
        }
        
        return aiIntent;
      } else {
        logger.log(`⚠️ AI returned 'unknown' operation, will fall back to regex`);
      }
    } else {
      logger.log(`⚠️ AI returned null, will fall back to regex`);
    }
  } catch (error) {
    logger.error('⚠️ AI intent detection failed, falling back to regex patterns:', error);
    logger.error('⚠️ Error details:', error instanceof Error ? error.stack : String(error));
  }
  
  // ---------------------------------------------------------------------------
  // Fallback to regex patterns if AI didn't detect / returned unknown.
  // ARCH-2 / CQ-2 · the order-sensitive regex chain below was decomposed into
  // per-operation pure detectors in `dataOps/intent/detect<Op>.ts`. The chain is
  // FIRST-match-wins and the RELATIVE ORDER of detectors is load-bearing — it
  // MUST equal the original block order. `ctx` is the single message-derived bag
  // every detector reads (no session / Cosmos / python coupling on these paths).
  // ---------------------------------------------------------------------------
  const ctx: IntentDetectorContext = { message, lowerMessage, availableColumns };

  // Phase A — high-confidence detectors that run BEFORE clarification handling
  // (an explicit "remove the column X" / "remove the first row" must not be
  // mistaken for a clarification response to a prior nulls question). Order:
  // replace_value → revert → aggregate → pivot → remove_column(HC) → remove_rows(HC).
  const preClarification =
    detectReplaceValue(ctx) ??
    detectRevert(ctx) ??
    detectAggregate(ctx) ??
    detectPivot(ctx) ??
    detectRemoveColumnHighConfidence(ctx) ??
    detectRemoveRowsHighConfidence(ctx);
  if (preClarification) {
    return preClarification;
  }

  
  // ---------------------------------------------------------------------------
  // STEP 1: Handle clarification responses FIRST (highest priority)
  // This must come before AI detection to handle follow-up responses
  // ---------------------------------------------------------------------------
  const dataOpsContext = sessionDoc?.dataOpsContext as DataOpsContext | undefined;
  const pendingOp = dataOpsContext?.pendingOperation;
  
  if (pendingOp) {
    const age = Date.now() - pendingOp.timestamp;
    if (age < 5 * 60 * 1000) { // 5 minutes TTL
      // Detect if the user is clearly starting a NEW operation rather than
      // answering the previous clarification question.
      //
      // Example: After being asked how to handle nulls, the user says
      // "remove the column Maya TOM" – this should be treated as a
      // remove_column operation, not a clarification for remove_nulls.
      const mentionsColumn = lowerMessage.includes('column') || lowerMessage.includes('col ');
      const removalVerbs = lowerMessage.includes('remove') ||
        lowerMessage.includes('delete') ||
        lowerMessage.includes('drop');
      const mentionsNullLikeTerms =
        lowerMessage.includes('null') ||
        lowerMessage.includes('missing') ||
        lowerMessage.includes('nan');

      const looksLikeNewRemoveColumnRequest =
        pendingOp.operation === 'remove_nulls' &&
        mentionsColumn &&
        removalVerbs &&
        !mentionsNullLikeTerms;

      if (!looksLikeNewRemoveColumnRequest) {
      return handleClarificationResponse(message, pendingOp, availableColumns, dataSummary);
      }
      // If it looks like a new remove-column style request, we intentionally
      // skip clarification handling and let AI/regex logic below treat it
      // as a fresh intent.
    }
  }
  
  // ---------------------------------------------------------------------------
  // STEP 2: Fallback to regex patterns ONLY if AI failed or returned unknown
  // This is a safety net for cases where AI might fail or be unavailable
  // ---------------------------------------------------------------------------
  
  // Phase B — STEP-2 detectors, in original block order. FIRST-match-wins; the
  // first detector returning non-null wins, otherwise we fall through to unknown.
  // Order MUST equal the original block sequence (verified block-by-block).
  const postClarification =
    detectFillNulls(ctx) ??
    detectRemoveNulls(ctx) ??
    detectPreview(ctx) ??
    detectCountNulls(ctx) ??
    detectHowManyRowsCols(ctx) ??
    detectSummary(ctx) ??
    detectDescribe(ctx) ??
    detectCreateColumn(ctx) ??
    detectNormalizeColumn(ctx) ??
    detectRemoveRows(ctx) ??
    detectAddRow(ctx) ??
    detectModifyColumn(ctx) ??
    detectRenameColumn(ctx) ??
    detectRemoveColumn(ctx) ??
    detectConvertType(ctx) ??
    detectTrainModel(ctx);
  if (postClarification) {
    return postClarification;
  }

  // If no pattern matched, return unknown
  return {
    operation: 'unknown',
    requiresClarification: false
  };
}

/**
 * Use AI to detect data ops intent for conversational queries
 */
async function detectDataOpsIntentWithAI(
  message: string,
  availableColumns: string[],
  chatHistory?: Message[],
  sessionDoc?: ChatDocument
): Promise<DataOpsIntent | null> {
  try {
    // Include all columns for better matching (up to 50 to avoid token issues)
    const columnsList = availableColumns.slice(0, 50).join(', ');
    const columnsListForMatching = availableColumns.map((col, idx) => `${idx + 1}. "${col}"`).join('\n');

    // Build chat history context with more detail
    const historyText = chatHistory && chatHistory.length
      ? chatHistory
          .slice(-15) // Keep last ~15 messages for better context
          .map((m, idx) => {
            const role = m.role.toUpperCase();
            const content = m.content;
            const timestamp = m.timestamp ? new Date(m.timestamp).toISOString() : '';
            return `[${idx + 1}] ${role}${timestamp ? ` (${timestamp})` : ''}: ${content}`;
          })
          .join('\n')
      : 'No previous messages.';
    
    const prompt = `You are an expert data operations assistant. Your job is to accurately infer what data operation the USER wants to perform on their dataset.

CRITICAL: You must match column names EXACTLY as they appear in the available columns list below. Column names are case-sensitive and may contain spaces, underscores, or special characters.

=== CHAT HISTORY (most recent messages are last) ===
${historyText}

=== USER'S CURRENT MESSAGE ===
"${message}"

=== AVAILABLE COLUMNS IN THE DATASET ===
${columnsListForMatching}
${sessionDoc?.dataSummary?.temporalFacetColumns?.length
  ? `
=== CALENDAR BUCKET COLUMNS (hidden in the data table UI; exist on each row for grouping) ===
${sessionDoc.dataSummary.temporalFacetColumns
  .map(
    (t, i) =>
      `${i + 1}. "${t.name}" → ${t.grain} derived from date column "${t.sourceColumn}"`
  )
  .join('\n')}
When the user asks to aggregate **by year / quarter / month / week / day** over a **date** column, set **groupByColumn** to the matching row above (same sourceColumn, matching grain: year|quarter|month|week|date). Do not group by the raw date column for those requests.
`
  : ''}

=== COLUMN NAME MATCHING RULES ===
1. ALWAYS match column names EXACTLY as they appear in the list above (case-sensitive)
2. If the user mentions a partial column name (e.g., "status" when the column is "order_status"), find the BEST MATCH from the available columns
3. For aggregation operations, if user says "all the other columns" or "all columns", set aggColumns to null (not an empty array)
4. Column names may contain:
   - Spaces: "First Name", "Customer Since"
   - Underscores: "order_id", "qty_ordered"
   - Special characters: "E Mail", "Discount_Percent"
   - Mixed case: "Name Prefix", "SSN"
5. When extracting column names from the user's message:
   - Look for exact matches first
   - Then look for partial matches (e.g., "status" matches "order_status" or "status")
   - Consider word boundaries (e.g., "id" should match "order_id" or "item_id", not "valid")
   - For multi-word columns, match all words (e.g., "first name" matches "First Name")

=== CONTEXT UNDERSTANDING ===
1. Pay close attention to the chat history - the user may be referring to previous operations
2. If the user says "yes", "ok", "do it", etc., look at the most recent ASSISTANT message to understand what they're confirming
3. If the user says "that column", "the above column", "it", etc., find the column from recent context
4. For follow-up questions, use the full conversation context to understand intent

When deciding the operation:
- Always interpret the USER's last message in the context of the conversation above.
- CRITICAL – CORRELATION vs AGGREGATE (CHECK FIRST):
  • If the user asks for CORRELATION (e.g. "correlation of X with Y", "correlation between X and Y", "correlation of column X with all the other variables", "what affects X", "what impacts X", "correlate X with Y", "relationship between X and Y"), return operation: "unknown" and requiresClarification: false. Correlation is an ANALYSIS operation (measuring how variables move together), NOT a data operation. Do NOT interpret correlation requests as "aggregate". Aggregation = group by a column and sum/avg/count to create a summary table. Correlation = statistical relationship between variables – it must be handled by the Analysis flow, never as a data op.
- CRITICAL DEFAULT BEHAVIOR FOR OUTLIER OPERATIONS:
  • When user says "find outliers", "identify outliers", "detect outliers", "show outliers", or "what are the outliers" WITHOUT mentioning a specific column, set operation: "identify_outliers", column: null, requiresClarification: false
  • When user says "remove outliers", "treat outliers", "handle outliers", or "fix outliers" WITHOUT mentioning a specific column, set operation: "treat_outliers", column: null, requiresClarification: false
  • DO NOT ask for clarification - the system will automatically process ALL numeric columns by default
  • Only set requiresClarification: true if the user's intent is truly unclear or ambiguous
- The USER may reply with short confirmations like "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "sounds good", "do it", "go ahead", "please do", etc.
  • In that case, look at the most recent ASSISTANT message(s).
  • If the ASSISTANT just suggested a specific data operation (for example: "Should I rename column 'XYZ' to 'tuko' now?" or "Do you want me to create a new column Total = Price + Tax?" or "Just to clarify, are you asking to rename the column 'XYZ' to 'tuko'?"),
    then treat the USER's confirmation as a request to execute that suggested operation.
  • Infer the correct operation type and parameters (column names, new column name, expression, target variable, features, etc.) from the ASSISTANT's suggestion and the overall context.
  • For rename operations: If the ASSISTANT asked "are you asking to rename the column 'XYZ' to 'tuko'?", extract oldColumnName: "XYZ" and newColumnName: "tuko".
- If the USER's last message itself directly describes an operation (for example: "create a new column X = A/B", "remove nulls from column Y", "rename column Sales to Revenue"),
  extract the appropriate operation and parameters from that message, using the column list above to match column names.
- If you cannot confidently determine a specific operation and its parameters, return "operation": "unknown" and set "clarificationMessage" to a concise follow-up question asking the user what they want you to do (and which columns/values to use).

Determine the intent and return JSON with this structure:
{
  "operation": "remove_nulls" | "preview" | "summary" | "convert_type" | "count_nulls" | "describe" | "create_derived_column" | "create_column" | "modify_column" | "normalize_column" | "remove_column" | "rename_column" | "remove_rows" | "add_row" | "aggregate" | "pivot" | "train_model" | "replace_value" | "identify_outliers" | "treat_outliers" | "filter" | "revert" | "unknown",
  "column": "column_name" (if specific column mentioned for single-column operations, null otherwise),
  "oldColumnName": "OldColumnName" (if rename_column operation, the column to rename, null otherwise),
  "method": "delete" | "mean" | "median" | "mode" | "custom" (if operation is remove_nulls and method is specified, null otherwise),
  "customValue": any (if method is "custom", the value to use for imputation),
  "newColumnName": "NewColumnName" (if creating new column, null otherwise),
  "expression": "[Column1] + [Column2]" (if creating derived column, use [ColumnName] format, null otherwise),
  "defaultValue": any (if creating static column),
  "transformType": "add" | "subtract" | "multiply" | "divide" (if modifying existing column),
  "transformValue": number (if modifying existing column),
  "targetType": "numeric" | "string" | "date" | "percentage" | "boolean" (if convert_type operation, the target data type),
  "limit": number (if preview operation with first/last mode, the number of rows to show, e.g., "show first 10 rows" -> limit: 10, default: 50),
  "previewMode": "first" | "last" | "specific" | "range" (if preview operation, how to select rows),
  "previewStartRow": number (if previewMode is "specific" or "range", the starting row number, 1-based),
  "previewEndRow": number (if previewMode is "range", the ending row number, 1-based),
  "rowPosition": "first" | "last" | "keep_first" (if removing rows from start/end, or keeping only first N rows),
  "rowIndex": number (if removing specific row by index, 1-based),
  "rowCount": number (if removing multiple rows, e.g., "remove first 5 rows" or "remove last 3 rows"),
  "oldValue": any (if replace_value operation, the value to replace, null otherwise),
  "newValue": any (if replace_value operation, the value to replace with, null otherwise),
  "groupByColumn": "column_name" (if aggregate operation, the column to group by, null otherwise),
  "aggColumns": ["col1", "col2"] (if aggregate operation, columns to aggregate, null otherwise),
  "aggFunc": "sum" | "avg" | "mean" | "min" | "max" | "count" (if aggregate operation, default aggregation function, null otherwise),
  "aggFuncs": {"col1": "sum", "col2": "avg"} (if aggregate operation, per-column aggregation functions, null otherwise),
  "orderByColumn": "column_name" (if aggregate operation, column to sort results by, null otherwise),
  "orderByDirection": "asc" | "desc" (if aggregate operation, sort direction, null otherwise),
  "pivotIndex": "column_name" (if pivot operation, index column, null otherwise),
  "pivotValues": ["col1", "col2"] (if pivot operation, value columns, null otherwise),
  "pivotFuncs": {"col1": "sum", "col2": "avg"} (if pivot operation, per-column aggregation functions, null otherwise),
  "outlierMethod": "iqr" | "zscore" | "isolation_forest" | "local_outlier_factor" (if identify_outliers or treat_outliers operation, the detection method, default: "iqr"),
  "outlierThreshold": number (if identify_outliers or treat_outliers operation, threshold for detection - for zscore default: 3, for IQR default: 1.5, null otherwise),
  "treatmentMethod": "remove" | "cap" | "winsorize" | "transform" | "impute" (if treat_outliers operation, how to treat outliers, default: "remove"),
  "treatmentValue": "mean" | "median" | "mode" | "min" | "max" | number (if treatmentMethod is "impute" or "cap", the value to use, null otherwise),
  "filterConditions": [{"column": "string", "operator": "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "startsWith" | "endsWith" | "between" | "in", "value": any, "value2": any (for "between" only), "values": [any] (for "in" only)}] (if filter operation, array of filter conditions, null otherwise),
  "logicalOperator": "AND" | "OR" (if filter operation with multiple conditions, how to combine them, default: "AND", null otherwise),
  "requiresClarification": false,
  "clarificationMessage": null
}

Operations:
- "train_model": User wants to build/train/create a machine learning model (e.g., "build a linear model", "train a model", "create a model")
  * Extract modelType: "linear", "log_log", "logistic", "ridge", "lasso", "random_forest", "decision_tree", "gradient_boosting", "elasticnet", "svm", "knn", "polynomial", "bayesian", etc. (default: "linear")
  * Extract targetVariable: the target/dependent variable to predict
  * Extract features: array of independent variables/features
- "create_column": User wants to create new column with static/default value (e.g., "create column status with value active", "add column Notes", "create column Price with default 100")
  * Extract newColumnName: the name of the new column to create
  * Extract defaultValue: the static value to put in all rows (string, number, boolean, or null)
- "create_derived_column": User wants to create new column from expression (e.g., "create column XYZ = A + B", "add two columns X and Y", "create column XYZ with sum of PA and PAB", "create column xyz where if qty_ordered is more than the mean of qty_ordered then put it as 'outperform' otherwise 'notperforming'")
  * Extract newColumnName: the name of the new column to create
  * Extract expression: formula using [ColumnName] format (e.g., "[PA nGRP Adstocked] + [PAB nGRP Adstocked]")
  * For conditional logic (if/then/else), use np.where format: "np.where([Column] > [Column].mean(), 'value1', 'value2')"
  * If user says "sum of X and Y", expression should be "[X] + [Y]"
  * If user says "add X and Y", expression should be "[X] + [Y]"
  * If user says "if X > mean(X) then 'A' else 'B'", expression should be "np.where([X] > [X].mean(), 'A', 'B')"
- "modify_column": User wants to increase/decrease/multiply/divide an existing column
  * Extract column, transformType, transformValue
- "normalize_column": User wants to normalize or standardize an existing column
  * Extract column to normalize
- "remove_rows": User wants to remove first/last or a specific row(s), OR keep only first N rows
  * Examples: "remove last row", "delete row 5", "remove first 3 rows", "delete last 5 rows"
  * Special case: "keep only first N rows" or "keep first N rows" -> rowPosition: "keep_first", rowCount: N
  * Extract rowPosition (first/last/keep_first) if removing from start/end or keeping only first N
  * Extract rowIndex (1-based) if removing a specific row by index
  * Extract rowCount (number) if removing multiple rows (e.g., "remove first 5 rows" -> rowPosition: "first", rowCount: 5)
  * For "keep only first 100 rows" -> rowPosition: "keep_first", rowCount: 100
- "remove_column": User wants to remove/delete/drop a column (e.g., "remove column X", "delete the column Y", "drop column Z")
  * Extract column: the name of the column to remove
  * If column name is not specified, set requiresClarification to true
- "rename_column": User wants to rename/change the name of a column (e.g., "rename column X to Y", "change column name from X to Y", "rename the above column to Two", "change that column name to NewName")
  * Extract oldColumnName: the current name of the column to rename (can be from context like "above", "that", "it", "previous", or from assistant's clarification message)
  * Extract newColumnName: the new name for the column
  * If oldColumnName is not specified but user references "above", "that", "it", "previous", try to find from context
  * IMPORTANT: If the user replies "yes" to an assistant clarification like "are you asking to rename the column 'XYZ' to 'tuko'?", extract oldColumnName: "XYZ" and newColumnName: "tuko" from the assistant's message
  * Examples:
    - "rename column Sales to Revenue" → oldColumnName: "Sales", newColumnName: "Revenue"
    - "change the above column name to Two" → oldColumnName: (from context), newColumnName: "Two"
    - "rename that column to NewName" → oldColumnName: (from context), newColumnName: "NewName"
    - "change column name from OldName to NewName" → oldColumnName: "OldName", newColumnName: "NewName"
    - User says "yes" after assistant asks "are you asking to rename the column 'XYZ' to 'tuko'?" → oldColumnName: "XYZ", newColumnName: "tuko"
- "add_row": User wants to add/append a row (e.g., "add a new row", "append row at bottom")
- "count_nulls": User wants to count/null values (e.g., "how many nulls", "count missing values")
- "replace_value": User wants to replace a specific NON-NULL value with another. CRITICAL: 
  * DO NOT use this for null imputation - use "remove_nulls" instead
  * Only use for replacing specific values like "replace 0 with 1", "replace 'N/A' with 'Unknown'", etc.
  * If user mentions "null" in the context of filling/imputing, use "remove_nulls" NOT "replace_value"
  * Handle various phrasings:
  * "replace - with 0" or "replace '-' with 0"
  * "remove - and put 134.2 instead" or "remove - and replace with 134.2"
  * "change - to 0" or "convert - to 0"
  * "substitute - for 0" or "remove - and use 0"
  * "remove the value - and put 0" or "remove -, use 0"
  * Extract oldValue: the value to replace (e.g., "-", "N/A", "null", "empty")
  * Extract newValue: the value to replace with (e.g., 0, 134.2, null, "N/A")
  * Extract column: if a specific column is mentioned
- "describe": User wants general info about data (e.g., "how many rows", "describe the data", "what's in the dataset")
- "preview": User wants to see data WITHOUT modifying the dataset. Handle various modes:
  * "first" mode: "show first 10 rows", "show me only first 5 rows", "display top 20 rows" -> previewMode: "first", limit: 10/5/20
  * "last" mode: "show last 5 rows", "show me the last 10 rows" -> previewMode: "last", limit: 5/10
  * "specific" mode: "show row 12", "show the 12th row", "show row number 28" -> previewMode: "specific", previewStartRow: 12/28
  * "range" mode: "show rows 12 to 28", "show rows 12-28", "show rows 12 through 28", "show me row from range 3 to 10 rows", "rows from range 3 to 10", "range 3 to 10 rows", "show me rows from range 5 to 15", "display rows from range 1 to 20" -> previewMode: "range", previewStartRow: 12/3/5/1, previewEndRow: 28/10/15/20
  * IMPORTANT: When user says "show me row from range 3 to 10 rows", this means rows 3 through 10 (inclusive), so previewMode: "range", previewStartRow: 3, previewEndRow: 10
  * PREVIEW WITH CONDITIONS: "give me 50 rows where X is Y", "show me 100 rows where column = value", "display 20 rows where status is high" -> operation: "preview", limit: 50/100/20, filterConditions: [extracted conditions]
  * CRITICAL: Preview with conditions does NOT modify the dataset - it only shows a preview of matching rows
  * If no specific mode is mentioned, default to "first" mode with limit: 50
- "summary": User wants statistics summary
- "remove_nulls": User wants to remove/handle nulls. CRITICAL: This is the CORRECT operation for ANY request involving null values, including:
  * "fill null values with mean/median/mode" → operation: "remove_nulls", method: "mean"/"median"/"mode", requiresClarification: false
  * "fill all null values with the mean of their respective columns" → operation: "remove_nulls", method: "mean", column: null (all columns), requiresClarification: false
  * "impute null values" → operation: "remove_nulls", method: "mean" (default), requiresClarification: false
  * "replace null with mean" → operation: "remove_nulls", method: "mean", requiresClarification: false
  * DO NOT use "replace_value" for null imputation - ALWAYS use "remove_nulls" with method
  * If user says "remove null" or "delete null" without specifying fill/impute, default to asking for clarification.
- "convert_type": User wants to convert column type
- "aggregate": User wants to group data by a column and summarize other columns (sum/avg/count) to create a summary table
  * CRITICAL: Do NOT use for correlation requests. "Correlation of X with Y" or "correlation of column X with all variables" = ANALYSIS (return "unknown"), not aggregate. Only use "aggregate" when the user explicitly asks to aggregate/group/sum (e.g. "aggregate by X", "group by category").
  * CRITICAL: Match column names EXACTLY from the available columns list above (and from CALENDAR BUCKET COLUMNS when grouping by calendar year/month/quarter/week/day)
  * Patterns: "aggregate by X", "aggregate X by Y using sum", "aggregate X on Y", "aggregate X, group by Y", "aggregate by Month column", "aggregate by Brand", "aggregate over X", "aggregate all columns by X"
  * Extract groupByColumn: the column to group by - MUST match exactly from available columns (e.g., if available columns have "status", use "status", not "s" or "Status")
  * Extract aggColumns: 
    * If user specifies specific columns: array of column names (e.g., ["qty_ordered", "price"])
    * If user says "all the other columns", "all columns", "all data", "whole data": set to null (not empty array [])
    * If not specified: set to null (will auto-detect all numeric columns)
  * Extract aggFunc: default aggregation function ("sum", "avg", "mean", "min", "max", "count") - default is "sum"
  * Extract aggFuncs: per-column aggregation functions if user specifies different functions for different columns
  * Extract orderByColumn: optional column to sort results by (must match exactly from available columns)
  * Extract orderByDirection: "asc" or "desc" (default: "asc")
  * Examples with EXACT column matching:
    - User: "aggregate by Month" → groupByColumn: "Month" (if "Month" exists in columns), aggColumns: null
    - User: "aggregate qty_ordered by status using sum" → groupByColumn: "status", aggColumns: ["qty_ordered"], aggFunc: "sum"
      * MUST match "status" exactly (not "s", "Status", "STATUS")
      * MUST match "qty_ordered" exactly (not "qty", "quantity", "Qty Ordered")
    - User: "aggregate all the other columns by status using sum" → groupByColumn: "status", aggColumns: null, aggFunc: "sum"
      * "status" must match exactly from available columns
      * aggColumns: null (not [] or undefined) triggers auto-detection
    - User: "aggregate RISK_VOLUME on DEPOT" → groupByColumn: "DEPOT", aggColumns: ["RISK_VOLUME"]
    - User: "aggregate risk value, group by SKU Desc, order by risk value DESC" → groupByColumn: "SKU Desc", aggColumns: ["risk value"], orderByColumn: "risk value", orderByDirection: "desc"
    - User: "aggregate by Brand showing Total Sales (sum) and Avg Spend (avg)" → groupByColumn: "Brand", aggColumns: ["Sales", "Spend"], aggFuncs: {"Sales": "sum", "Spend": "avg"}
    - User: "aggregate the whole data over status" → groupByColumn: "status", aggColumns: null
    - User: "aggregate over status column" → groupByColumn: "status", aggColumns: null
    - User: "aggregate all data over status" → groupByColumn: "status", aggColumns: null
  * COMMON MISTAKES TO AVOID:
    - DO NOT extract partial column names (e.g., "s" instead of "status")
    - DO NOT use case variations (e.g., "Status" when column is "status")
    - DO NOT use empty array [] when user says "all columns" - use null instead
    - DO match column names EXACTLY as they appear in the available columns list
- "pivot": User wants to create a pivot table
  * Extract pivotIndex: the column to use as pivot index/rows (e.g., "Brand", "Month", "status")
  * Extract pivotValues: array of columns to show as metrics (e.g., ["Sales", "Spend", "ROI"]). If not specified or user says "over rest of the columns"/"over remaining columns", will default to all columns except the index column
  * Extract pivotFuncs: per-column aggregation functions if user specifies (e.g., {"Sales": "sum", "Spend": "sum", "ROI": "avg"})
  * Default aggregation function is "sum" if not specified
  * IMPORTANT: If user mentions "pivot" or "pivot table", this is ALWAYS a pivot operation, NOT a "create_column" operation, even if the message contains "create"
  * Examples: 
    - "create a pivot on Brand showing Sales, Spend, ROI"
    - "pivot on Month showing Total Sales (sum) and Avg Spend (avg)"
    - "pivot table for status" (extract pivotIndex: "status", pivotValues: [] - will use all columns)
    - "pivot for status" (extract pivotIndex: "status", pivotValues: [])
    - "create pivot table for status" (extract pivotIndex: "status", pivotValues: [])
    - "pivot by status" (extract pivotIndex: "status", pivotValues: [])
    - "create a pivot table for status over rest of the columns" (extract pivotIndex: "status", pivotValues: [] - use all other columns)
    - "pivot table for status over remaining columns" (extract pivotIndex: "status", pivotValues: [])
- "identify_outliers": User wants to find/identify/detect outliers in the data
  * CRITICAL: When user says "find outliers", "identify outliers", "detect outliers", "show outliers", or "what are the outliers" WITHOUT specifying a column, proceed immediately with analyzing ALL numeric columns (set column: null, requiresClarification: false)
  * DO NOT ask for clarification - the system will automatically analyze all numeric columns by default
  * Examples: "find outliers", "identify outliers", "detect outliers", "show outliers", "what are the outliers", "find outliers in column X", "detect outliers using IQR", "identify outliers with z-score"
  * Extract column: if a specific column is mentioned (null for all numeric columns - this is the DEFAULT and should be used when no column is specified)
  * Extract outlierMethod: "iqr" (default), "zscore", "isolation_forest", or "local_outlier_factor" based on user's preference
  * Extract outlierThreshold: if user specifies (e.g., "z-score > 2.5" -> threshold: 2.5, default: 3 for zscore, 1.5 for IQR)
  * IMPORTANT: Set requiresClarification: false for simple outlier identification requests like "find outliers" - proceed immediately
  * This operation only identifies and reports outliers, does not modify data
- "treat_outliers": User wants to remove/handle/fix/treat outliers in the data
  * CRITICAL: When user says "remove outliers", "treat outliers", "handle outliers", or "fix outliers" WITHOUT specifying a column, proceed immediately with treating outliers in ALL numeric columns (set column: null, requiresClarification: false)
  * DO NOT ask for clarification - the system will automatically treat outliers in all numeric columns by default
  * Examples: "remove outliers", "treat outliers", "handle outliers", "fix outliers", "remove outliers from column X", "cap outliers", "winsorize outliers", "replace outliers with mean"
  * Extract column: if a specific column is mentioned (null for all numeric columns - this is the DEFAULT and should be used when no column is specified)
  * Extract outlierMethod: "iqr" (default), "zscore", "isolation_forest", or "local_outlier_factor" based on user's preference
  * Extract outlierThreshold: if user specifies (default: 3 for zscore, 1.5 for IQR)
  * Extract treatmentMethod: "remove" (default), "cap", "winsorize", "transform", or "impute" based on user's request
  * Extract treatmentValue: if treatmentMethod is "impute" or "cap", extract "mean", "median", "mode", "min", "max", or a specific number
  * IMPORTANT: Set requiresClarification: false for simple outlier treatment requests like "remove outliers" - proceed immediately
  * Examples:
    - "remove outliers" -> treatmentMethod: "remove", outlierMethod: "iqr", column: null, requiresClarification: false
    - "cap outliers at 95th percentile" -> treatmentMethod: "cap", treatmentValue: 95 (or calculate percentile)
    - "replace outliers with median" -> treatmentMethod: "impute", treatmentValue: "median"
    - "impute outliers with mean" -> treatmentMethod: "impute", treatmentValue: "mean", outlierMethod: "iqr", column: null, requiresClarification: false
    - "impute outliers with median" -> treatmentMethod: "impute", treatmentValue: "median", outlierMethod: "iqr", column: null, requiresClarification: false
    - "impute outliers with mode" -> treatmentMethod: "impute", treatmentValue: "mode", outlierMethod: "iqr", column: null, requiresClarification: false
    - "winsorize outliers" -> treatmentMethod: "winsorize"
    - "remove outliers using z-score > 3" -> treatmentMethod: "remove", outlierMethod: "zscore", outlierThreshold: 3
- "filter": User wants to filter/keep only rows that match certain conditions AND PERMANENTLY MODIFY THE DATASET
  * CRITICAL: This is a DATA MODIFICATION operation that changes the working dataset
  * After filtering, the filtered dataset becomes the new working dataset for all subsequent queries
  * CRITICAL DISTINCTION: Only use "filter" operation when user EXPLICITLY says "filter" or "filter data" or "filter dataset"
  * DO NOT use "filter" for "give me/show me N rows where X is Y" - that should be "preview" with filterConditions
  * Examples of FILTER operation (permanently modifies dataset):
    - "filter data where category is men's fashion"
    - "filter by category = X"
    - "filter rows where date is between 2020 and 2021"
    - "filter data where category equals men's fashion"
    - "filter dataset where status is high"
  * Examples that should be PREVIEW (not filter):
    - "give me 50 rows where NewStatus is high" -> operation: "preview", limit: 50, filterConditions: [...]
    - "show me 100 rows where category is X" -> operation: "preview", limit: 100, filterConditions: [...]
    - "display 20 rows where status is high" -> operation: "preview", limit: 20, filterConditions: [...]
  * Extract filterConditions: array of filter conditions, each with:
    - column: the column to filter on (MUST match exactly from available columns)
    - operator: "=", "!=", ">", ">=", "<", "<=", "contains", "startsWith", "endsWith", "between", "in"
    - value: the value to compare against (for single value operators)
    - value2: second value for "between" operator (e.g., "between 2020 and 2021" -> value: 2020, value2: 2021)
    - values: array of values for "in" operator (e.g., "in [A, B, C]" -> values: ["A", "B", "C"])
  * Extract logicalOperator: "AND" (default) or "OR" - how to combine multiple conditions
  * IMPORTANT: Set requiresClarification: false if filter conditions can be extracted
  * This operation MODIFIES the dataset - filtered data becomes the new working dataset
  * Examples:
    - "filter data where category is men's fashion" -> filterConditions: [{"column": "category", "operator": "=", "value": "men's fashion"}], logicalOperator: "AND"
    - "show only rows where revenue > 1000000" -> filterConditions: [{"column": "revenue", "operator": ">", "value": 1000000}], logicalOperator: "AND"
    - "filter rows where date is between 2020 and 2021" -> filterConditions: [{"column": "date", "operator": "between", "value": 2020, "value2": 2021}], logicalOperator: "AND"
    - "filter data where category is in [A, B, C]" -> filterConditions: [{"column": "category", "operator": "in", "values": ["A", "B", "C"]}], logicalOperator: "AND"
- "revert": User wants to restore the data to its original form (e.g., "revert to original", "restore original data", "revert table", "go back to original")
  * This will load the original uploaded file and restore it, undoing all data operations
  * Examples: "revert to original", "restore original data", "revert table", "go back to original", "revert to original form"
- "unknown": Cannot determine intent OR the question is a general data analysis question (not a data operation)

=== GENERAL DATA ANALYSIS QUESTIONS (ONLY IF NOT A DATA OPERATION) ===
CRITICAL PRIORITY: Check ALL data operations above FIRST. Only proceed to this section if the question does NOT match any data operation patterns.

If the user's question is a general data analysis question (not a data manipulation operation), return operation: "unknown" with requiresClarification: false to route it to the general analysis handler.

General analysis questions are questions that:
- Ask "which", "what", "how many", "show me" that require filtering, aggregating, and analyzing data WITHOUT modifying the dataset
- Have complex filters and conditions that need to be executed as queries (e.g., "Which categories generated more than ₹5 crore in total revenue in 2020, considering only SKUs that sold at least 1,000 units each?")
- Ask for insights, comparisons, or analysis results (not data transformations)
- Require querying/filtering the data but don't modify the dataset structure
- Are statistical queries that need aggregation with multiple conditions
- Ask "which X has Y" or "what is the Z for X" where X and Y involve filtering and aggregation

Examples of general analysis questions (return operation: "unknown", requiresClarification: false):
- "Which categories generated more than ₹5 crore in total revenue in 2020, considering only SKUs that sold at least 1,000 units each?"
- "What is the total revenue for each category in 2020?"
- "Show me the top 10 products by sales"
- "Which month had the highest revenue?"
- "How many orders were placed in 2020?"
- "What is the average order value by category?"
- "Which categories had the highest ROI in 2020?"
- "What is the average price of SKUs sold in 2020?"

These questions will be handled by the general analysis handler which can:
- Parse complex filters and conditions
- Perform aggregations with multiple criteria
- Generate charts and visualizations
- Provide detailed analysis results

IMPORTANT PRIORITY RULES:
1. FIRST: Check if the question matches ANY data operation pattern above (create column, aggregate, pivot, remove rows, rename, etc.)
2. If it matches a data operation → return that operation immediately
3. ONLY if it doesn't match any data operation → check if it's a general analysis question
4. If it's a general analysis question → return operation: "unknown", requiresClarification: false
5. If it's neither → return operation: "unknown", requiresClarification: true with a clarification message

Return ONLY valid JSON, no other text.`;

    // OBS-3: the message is confidential user content — verbatim text is debug-only.
    logger.log(`🤖 Sending AI prompt for intent detection (message ${message.length} chars)`);
    logger.debug(`🤖 intent-detection message: "${message}"`);
    logger.log(`📋 Available columns (${availableColumns.length}): ${availableColumns.slice(0, 10).join(', ')}${availableColumns.length > 10 ? '...' : ''}`);
    
    const response = await callLlm(
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert data operations assistant. You must return ONLY valid JSON. Match column names EXACTLY as they appear in the available columns list. Never truncate your response - always return complete JSON.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2, // Lower temperature for more consistent, accurate responses
        max_tokens: 600, // Increased from 200 to prevent truncation
        response_format: { type: 'json_object' }, // Force JSON output format
      },
      { purpose: LLM_PURPOSE.DATAOPS_INTENT }
    );
    
    logger.log(`🤖 AI response received, parsing...`);

    const content = response.choices[0]?.message?.content?.trim();
    const finishReason = response.choices[0]?.finish_reason;
    
    logger.log(`🤖 AI raw response (first 300 chars):`, content?.substring(0, 300));
    logger.log(`🤖 Finish reason: ${finishReason}`);
    
    if (!content) {
      logger.log(`⚠️ AI returned empty content`);
      return null;
    }

    // Check if response was truncated
    if (finishReason === 'length') {
      logger.warn(`⚠️ AI response was truncated (finish_reason: length). Response length: ${content.length}`);
      // Try to extract JSON anyway, but log warning
    }

    // Extract JSON from response (handle markdown code blocks and plain JSON)
    let jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Try to find JSON object even if wrapped in text
      jsonMatch = content.match(/\{[\s\S]*?\}/);
    }
    
    if (!jsonMatch) {
      logger.log(`⚠️ No JSON found in AI response. Full response:`, content);
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
      logger.log(`✅ Successfully parsed AI intent JSON`);
    } catch (parseError) {
      logger.error(`❌ Failed to parse AI JSON response:`, parseError);
      logger.error(`❌ JSON string:`, jsonMatch[0].substring(0, 500));
      return null;
    }
    
    logger.log(`🤖 Parsed AI intent:`, {
      operation: parsed.operation,
      groupByColumn: parsed.groupByColumn,
      aggColumns: parsed.aggColumns,
      aggFunc: parsed.aggFunc,
      column: parsed.column,
      oldColumnName: parsed.oldColumnName,
    });
    
    // Enhanced column name matching with better logging
    if (parsed.column) {
      const originalColumn = parsed.column;
      const matchedColumn = findMatchingColumn(parsed.column, availableColumns);
      if (matchedColumn && matchedColumn !== originalColumn) {
        logger.log(`🔍 Column matched: "${originalColumn}" → "${matchedColumn}"`);
      } else if (!matchedColumn) {
        logger.warn(`⚠️ Column "${originalColumn}" not found in available columns`);
      }
      parsed.column = matchedColumn || parsed.column;
    }
    
    // Map oldColumnName for rename operations
    if (parsed.oldColumnName) {
      const originalColumn = parsed.oldColumnName;
      const matchedColumn = findMatchingColumn(parsed.oldColumnName, availableColumns);
      if (matchedColumn && matchedColumn !== originalColumn) {
        logger.log(`🔍 OldColumnName matched: "${originalColumn}" → "${matchedColumn}"`);
      }
      parsed.oldColumnName = matchedColumn || parsed.oldColumnName;
    }
    
    // Map groupByColumn for aggregation operations
    if (parsed.groupByColumn) {
      const originalColumn = parsed.groupByColumn;
      const matchedColumn = findMatchingColumn(parsed.groupByColumn, availableColumns);
      if (matchedColumn && matchedColumn !== originalColumn) {
        logger.log(`🔍 groupByColumn matched: "${originalColumn}" → "${matchedColumn}"`);
      } else if (!matchedColumn) {
        logger.warn(`⚠️ groupByColumn "${originalColumn}" not found in available columns. Available: ${availableColumns.slice(0, 5).join(', ')}...`);
      }
      parsed.groupByColumn = matchedColumn || parsed.groupByColumn;
    }
    
    // Map aggColumns array for aggregation operations
    if (parsed.aggColumns && Array.isArray(parsed.aggColumns)) {
      parsed.aggColumns = parsed.aggColumns.map((col: string) => {
        const matched = findMatchingColumn(col, availableColumns);
        if (matched && matched !== col) {
          logger.log(`🔍 aggColumn matched: "${col}" → "${matched}"`);
        }
        return matched || col;
      });
    }

    // Extract method for remove_nulls operation if not explicitly provided
    let method: 'delete' | 'mean' | 'median' | 'mode' | 'custom' | undefined;
    let customValue: any;
    
    if (parsed.operation === 'remove_nulls') {
      const lowerMsg = message.toLowerCase();
      if (lowerMsg.includes('fill') || lowerMsg.includes('impute') || lowerMsg.includes('replace')) {
        // This is an imputation request, not deletion
        if (lowerMsg.includes('mean') || lowerMsg.includes('average')) {
          method = 'mean';
        } else if (lowerMsg.includes('median')) {
          method = 'median';
        } else if (lowerMsg.includes('mode') || lowerMsg.includes('most frequent')) {
          method = 'mode';
        } else {
          // Check for custom value (number or string)
          const customValueResult = extractCustomValue(message);
          if (customValueResult.found) {
            method = 'custom';
            customValue = customValueResult.value;
          } else if (lowerMsg.includes('custom')) {
            // User mentioned "custom" but didn't specify value
            method = 'custom';
            customValue = undefined;
          }
        }
      } else if (lowerMsg.includes('delete') || lowerMsg.includes('remove')) {
        method = 'delete';
      }
    }

    // Build the intent object with all mapped columns
    const intent: DataOpsIntent = {
      operation: parsed.operation || 'unknown',
      column: parsed.column,
      method: method || parsed.method,
      customValue: customValue !== undefined ? customValue : parsed.customValue,
      newColumnName: parsed.newColumnName,
      expression: parsed.expression,
      defaultValue: parsed.defaultValue,
      transformType: parsed.transformType,
      transformValue: parsed.transformValue,
      targetType: parsed.targetType,
      limit: parsed.limit,
      previewMode: parsed.previewMode,
      previewStartRow: parsed.previewStartRow,
      previewEndRow: parsed.previewEndRow,
      rowPosition: parsed.rowPosition,
      rowIndex: parsed.rowIndex,
      rowCount: parsed.rowCount,
      oldValue: parsed.oldValue,
      newValue: parsed.newValue,
      oldColumnName: parsed.oldColumnName,
      modelType: parsed.modelType,
      targetVariable: parsed.targetVariable,
      features: parsed.features,
      requiresClarification: method ? false : (parsed.requiresClarification || false),
      clarificationType: parsed.clarificationType,
      clarificationMessage: parsed.clarificationMessage,
    };
    
    // Add aggregation-specific fields with mapped columns
    if (parsed.groupByColumn) {
      intent.groupByColumn = parsed.groupByColumn;
    }
    if (parsed.aggColumns !== undefined) {
      intent.aggColumns = parsed.aggColumns; // Already mapped above
    }
    if (parsed.aggFunc) {
      intent.aggFunc = parsed.aggFunc;
    }
    if (parsed.aggFuncs) {
      intent.aggFuncs = parsed.aggFuncs;
    }
    if (parsed.orderByColumn) {
      const matchedOrderBy = findMatchingColumn(parsed.orderByColumn, availableColumns);
      intent.orderByColumn = matchedOrderBy || parsed.orderByColumn;
    }
    if (parsed.orderByDirection) {
      intent.orderByDirection = parsed.orderByDirection;
    }
    
    // Add pivot-specific fields
    if (parsed.pivotIndex) {
      const matchedPivotIndex = findMatchingColumn(parsed.pivotIndex, availableColumns);
      intent.pivotIndex = matchedPivotIndex || parsed.pivotIndex;
    }
    if (parsed.pivotValues) {
      intent.pivotValues = parsed.pivotValues.map((col: string) => {
        const matched = findMatchingColumn(col, availableColumns);
        return matched || col;
      });
    }
    if (parsed.pivotFuncs) {
      intent.pivotFuncs = parsed.pivotFuncs;
    }
    
    // Add filter-specific fields
    if (parsed.filterConditions) {
      // Map column names in filter conditions
      intent.filterConditions = parsed.filterConditions.map(
        (condition: NonNullable<DataOpsIntent['filterConditions']>[number]) => {
          const matchedColumn = findMatchingColumn(condition.column, availableColumns);
          return {
            ...condition,
            column: matchedColumn || condition.column,
          };
        }
      );
    }
    if (parsed.logicalOperator) {
      intent.logicalOperator = parsed.logicalOperator;
    }
    
    logger.log(`✅ Final mapped intent:`, {
      operation: intent.operation,
      groupByColumn: intent.groupByColumn,
      aggColumns: intent.aggColumns,
      column: intent.column,
      filterConditions: intent.filterConditions,
      logicalOperator: intent.logicalOperator,
    });
    
    return intent;
  } catch (error) {
    logger.error('Error in AI intent detection:', error);
    return null;
  }
}

/**
 * Handle clarification response
 */
function handleClarificationResponse(
  message: string,
  pendingOp: { operation: string; column?: string },
  availableColumns: string[],
  dataSummary: DataSummary
): DataOpsIntent {
  const lowerMessage = message.toLowerCase().trim();
  
  if (pendingOp.operation === 'remove_rows') {
    const lower = message.toLowerCase();
    if (lower.includes('first') || lower.includes('top')) {
      return {
        operation: 'remove_rows',
        rowPosition: 'first',
        requiresClarification: false,
      };
    }
    if (lower.includes('last') || lower.includes('bottom')) {
      return {
        operation: 'remove_rows',
        rowPosition: 'last',
        requiresClarification: false,
      };
    }
    const indexMatch = lower.match(/row\s*(\d+)/);
    if (indexMatch) {
      return {
        operation: 'remove_rows',
        rowIndex: parseInt(indexMatch[1]!, 10),
        requiresClarification: false,
      };
    }
  }

  if (pendingOp.operation === 'remove_nulls') {
    // Check if this is a column specification
    if (!pendingOp.column) {
      // Check if user is specifying a method (for entire dataset)
      // This handles the case where user said "entire dataset" and now responds with method
      if (lowerMessage.includes('delete') || lowerMessage.includes('remove') || lowerMessage.includes('option a')) {
        return {
          operation: 'remove_nulls',
          method: 'delete',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('mean') || lowerMessage.includes('average') || lowerMessage.includes('impute with mean')) {
        return {
          operation: 'remove_nulls',
          method: 'mean',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('median') || lowerMessage.includes('impute with median')) {
        return {
          operation: 'remove_nulls',
          method: 'median',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('mode') || lowerMessage.includes('most frequent') || lowerMessage.includes('impute with mode')) {
        return {
          operation: 'remove_nulls',
          method: 'mode',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('custom')) {
        // Check if custom value is specified
        const customValueResult = extractCustomValue(message);
        if (customValueResult.found) {
          return {
            operation: 'remove_nulls',
            method: 'custom',
            customValue: customValueResult.value,
            requiresClarification: false
          };
        } else {
          // User said "custom" but didn't specify value
          return {
            operation: 'remove_nulls',
            method: 'custom',
            requiresClarification: true,
            clarificationType: 'method',
            clarificationMessage: 'What value would you like to use to fill null values? (e.g., 0, "N/A", "Unknown", etc.)'
          };
        }
      }
      
      // User is specifying column
      const mentionedColumn = findMentionedColumn(message, availableColumns);
      if (mentionedColumn) {
        return {
          operation: 'remove_nulls',
          column: mentionedColumn,
          requiresClarification: true,
          clarificationType: 'method',
          clarificationMessage: `How do you want to deal with null values in "${mentionedColumn}"?\n\nOption A: Delete Row\nOption B: Impute with mean/median/mode/custom value`
        };
      } else if (lowerMessage.includes('entire') || lowerMessage.includes('all') || lowerMessage.includes('whole')) {
        return {
          operation: 'remove_nulls',
          requiresClarification: true,
          clarificationType: 'method',
          clarificationMessage: 'How do you want to deal with null values?\n\nOption A: Delete Row\nOption B: Impute with mean/median/mode/custom value'
        };
      }
    } else {
      // User is specifying method for a specific column
      if (lowerMessage.includes('delete') || lowerMessage.includes('remove') || lowerMessage.includes('option a')) {
        return {
          operation: 'remove_nulls',
          column: pendingOp.column,
          method: 'delete',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('mean') || lowerMessage.includes('average') || lowerMessage.includes('impute with mean')) {
        return {
          operation: 'remove_nulls',
          column: pendingOp.column,
          method: 'mean',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('median') || lowerMessage.includes('impute with median')) {
        return {
          operation: 'remove_nulls',
          column: pendingOp.column,
          method: 'median',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('mode') || lowerMessage.includes('most frequent') || lowerMessage.includes('impute with mode')) {
        return {
          operation: 'remove_nulls',
          column: pendingOp.column,
          method: 'mode',
          requiresClarification: false
        };
      } else if (lowerMessage.includes('custom')) {
        // Check if custom value is specified
        const customValueResult = extractCustomValue(message);
        if (customValueResult.found) {
        return {
          operation: 'remove_nulls',
          column: pendingOp.column,
          method: 'custom',
            customValue: customValueResult.value,
          requiresClarification: false
        };
        } else {
          // User said "custom" but didn't specify value
          return {
            operation: 'remove_nulls',
            column: pendingOp.column,
            method: 'custom',
            requiresClarification: true,
            clarificationType: 'method',
            clarificationMessage: `What value would you like to use to fill null values in "${pendingOp.column}"? (e.g., 0, "N/A", "Unknown", etc.)`
          };
        }
      }
    }
  }
  
  // Check if user is providing a custom value (for when method was already set to 'custom' in a previous clarification)
  // This handles cases where user said "custom" and we asked "what value?", and now they're providing the value
  if (pendingOp.operation === 'remove_nulls') {
    const customValueResult = extractCustomValue(message);
    // Only treat as custom value if:
    // 1. We found a value in the message, AND
    // 2. The message doesn't look like they're choosing a different method (mean/median/mode/delete)
    const looksLikeMethodChoice = lowerMessage.includes('mean') || lowerMessage.includes('median') || 
                                   lowerMessage.includes('mode') || lowerMessage.includes('delete') ||
                                   lowerMessage.includes('remove') || lowerMessage.includes('option');
    
    if (customValueResult.found && !looksLikeMethodChoice) {
      return {
        operation: 'remove_nulls',
        column: pendingOp.column,
        method: 'custom',
        customValue: customValueResult.value,
        requiresClarification: false
      };
    }
  }
  
  // Default: still need clarification
  return {
    operation: 'remove_nulls',
    column: pendingOp.column,
    requiresClarification: true,
    clarificationType: 'method',
    clarificationMessage: 'Please specify: Delete Row or Impute with mean/median/mode/custom value'
  };
}

// Wave R31 · Value / column-matching helpers extracted to a sibling module.
// Imported here for internal callers and re-exported below so any existing
// `from ".../dataOpsOrchestrator.js"` import path keeps resolving unchanged.
export {
  extractCustomValue,
  findMentionedColumn,
  findMatchingColumn,
  normalizeNumericValue,
} from "./dataOpsValueHelpers.js";

// ARCH-2 / CQ-2 · per-operation handlers extracted to `handlers/*`. Re-exported
// from this path so any future caller (or test) can import them from either the
// handler module or the orchestrator without breaking the existing seam.
export { handleCountNulls } from "./handlers/countNulls.js";
export { handleDescribe } from "./handlers/describe.js";
export { handleSummary } from "./handlers/summary.js";
export { handleIdentifyOutliers } from "./handlers/identifyOutliers.js";
export { handleAggregate } from "./handlers/aggregate.js";
export { handlePivot } from "./handlers/pivot.js";
export { handleTrainModel } from "./handlers/trainModel.js";
export { handlePreview } from "./handlers/preview.js";
export { handleTreatOutliers } from "./handlers/treatOutliers.js";
export { handleCreateColumn } from "./handlers/createColumn.js";
export { handleCreateDerivedColumn } from "./handlers/createDerivedColumn.js";
export { handleRenameColumn } from "./handlers/renameColumn.js";
export { handleFilter } from "./handlers/filter.js";
export { handleRevert } from "./handlers/revert.js";

// NB: the `create_column` / `create_derived_column` AI parameter-extraction
// helpers (`extractColumnDetails`, `extractDerivedColumnDetails`) moved VERBATIM
// into their respective handler modules (used only by those branches).

/**
 * Execute data operation based on intent
 */
export async function executeDataOperation(
  intent: DataOpsIntent,
  data: DataRow[],
  sessionId: string,
  sessionDoc?: ChatDocument,
  originalMessage?: string,
  chatHistory?: Message[]
): Promise<{
  answer: string;
  data?: DataRow[];
  preview?: DataRow[];
  summary?: SummaryResponse['summary'];
  saved?: boolean;
  // For operations like aggregate/pivot that only return a table,
  // the table will be included in "data" and "saved" will be false.
}> {
  logger.log(`🔍 executeDataOperation called with intent:`, {
    operation: intent.operation,
    groupByColumn: intent.groupByColumn,
    aggColumns: intent.aggColumns,
    aggFunc: intent.aggFunc,
    requiresClarification: intent.requiresClarification,
    clarificationMessage: intent.clarificationMessage,
  });
  
  // Check if user explicitly requested preview OR if this is a data modification operation
  // Data modification operations (add/remove columns/rows, etc.) should always show preview
  const shouldShowPreview = 
    intent.operation === 'preview' || 
    userRequestedPreview(originalMessage) ||
    isDataModificationOperation(intent.operation);
  
  // Detect large dataset
  const isLargeDataset = data.length > LARGE_DATASET_THRESHOLD;
  if (isLargeDataset) {
    logger.log(`📊 Large dataset detected (${data.length} rows). Using streaming mode for operations.`);
  }
  
  if (intent.requiresClarification) {
    logger.log(`⚠️ Intent requires clarification: ${intent.clarificationMessage}`);
    // Save pending operation to context
    if (sessionDoc) {
      const context: DataOpsContext = {
        pendingOperation: {
          operation: intent.operation,
          column: intent.column,
          timestamp: Date.now()
        },
        lastQuery: intent.operation,
        timestamp: Date.now()
      };
      sessionDoc.dataOpsContext = context as any;
      // Persist updated Data Ops context using shared chat model helper
      await updateChatDocument(sessionDoc);
    }
    
    return {
      answer: intent.clarificationMessage || 'Please provide more information.'
    };
  }
  
  logger.log(`✅ Executing operation: ${intent.operation}`);
  
  switch (intent.operation) {
    case 'remove_nulls': {
      // Validate input data
      if (!data || data.length === 0) {
        return {
          answer: '❌ No data available to process. Please ensure your dataset has been loaded correctly.',
        };
      }
      
      // Use streaming for large datasets
      const result = isLargeDataset
        ? await removeNullsStreaming(
            data,
            intent.column,
            intent.method || 'delete',
            intent.customValue
          )
        : await removeNulls(
            data,
            intent.column,
            intent.method || 'delete',
            intent.customValue
          );
      
      // Validate result data
      if (!result.data || result.data.length === 0) {
        return {
          answer: '⚠️ The operation resulted in an empty dataset. This can happen if all rows were deleted. Please try a different approach, such as imputing values instead of deleting rows.',
        };
      }
      
      // Determine if this is imputation or deletion
      const isImputation = intent.method && intent.method !== 'delete';
      const actionVerb = isImputation ? 'Imputed' : 'Removed';
      const actionVerbLower = isImputation ? 'imputed' : 'removed';
      
      let answerText = `✅ ${actionVerb} ${result.nulls_removed} null value(s)${isImputation ? ` with ${intent.method}` : ''}. Rows: ${result.rows_before} → ${result.rows_after}.`;
      if (shouldShowPreview) {
        answerText += ` Here's a preview of the updated data:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData: result.data,
        op: 'remove_nulls',
        description: `${actionVerb} nulls from ${intent.column || 'all columns'} using ${intent.method || 'delete'}`,
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'preview': {
      // ARCH-2 / CQ-2 · delegated to handlers/preview.ts (behaviour-preserving)
      return await handlePreview({
        intent,
        data,
      });
    }

    case 'count_nulls': {
      // ARCH-2 · delegated to handlers/countNulls.ts (pure, behaviour-preserving)
      return handleCountNulls({ data, column: intent.column });
    }

    case 'describe': {
      // ARCH-2 · delegated to handlers/describe.ts (pure, behaviour-preserving)
      return handleDescribe({ data });
    }

    case 'summary': {
      // ARCH-2 · delegated to handlers/summary.ts (behaviour-preserving)
      return await handleSummary({ data, column: intent.column });
    }
    
    case 'create_column': {
      // ARCH-2 / CQ-2 · delegated to handlers/createColumn.ts (behaviour-preserving)
      return await handleCreateColumn({
        intent,
        data,
        sessionId,
        sessionDoc,
        originalMessage,
        shouldShowPreview,
      });
    }

    case 'create_derived_column': {
      // ARCH-2 / CQ-2 · delegated to handlers/createDerivedColumn.ts (behaviour-preserving)
      return await handleCreateDerivedColumn({
        intent,
        data,
        sessionId,
        sessionDoc,
        originalMessage,
        shouldShowPreview,
      });
    }

    case 'normalize_column': {
      if (!intent.column) {
        return {
          answer: 'Please specify which column you want to normalize.'
        };
      }

      if (data.length > 0 && !(intent.column in data[0]!)) {
        return {
          answer: `Column "${intent.column}" was not found. Available columns: ${Object.keys(data[0] || {}).join(', ')}`
        };
      }

      const numericValues = data
        .map(row => normalizeNumericValue(row[intent.column!]))
        .filter((value): value is number => value !== null);

      if (numericValues.length === 0) {
        return {
          answer: `Column "${intent.column}" does not contain numeric data to normalize.`
        };
      }

      // Calculate min/max without spread operator to avoid stack overflow on large arrays
      let min = numericValues[0]!;
      let max = numericValues[0]!;
      for (let i = 1; i < numericValues.length; i++) {
        if (numericValues[i]! < min) min = numericValues[i]!;
        if (numericValues[i]! > max) max = numericValues[i]!;
      }
      const range = max - min;

      const modifiedData = data.map(row => {
        const newRow = { ...row };
        const currentValue = normalizeNumericValue(row[intent.column!]);
        if (currentValue === null) {
          newRow[intent.column!] = null;
        } else if (range === 0) {
          newRow[intent.column!] = 0;
        } else {
          // Round to 2 decimal places
          const normalizedValue = (currentValue - min) / range;
          newRow[intent.column!] = Math.round(normalizedValue * 100) / 100;
        }
        return newRow;
      });

      let answerText = `✅ Normalized column "${intent.column}" using min-max scaling (0-1).`;
      if (shouldShowPreview) {
        answerText += ` Here's a preview:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData,
        op: 'normalize_column',
        description: `Normalized column "${intent.column}" using min-max scaling`,
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'modify_column': {
      if (!intent.column || !intent.transformType || intent.transformValue === undefined) {
        return {
          answer: 'Please specify which column to adjust and by how much (e.g., "Reduce column XYZ by 100").'
        };
      }

      if (data.length > 0 && !(intent.column in data[0]!)) {
        return {
          answer: `Column "${intent.column}" was not found. Available columns: ${Object.keys(data[0] || {}).join(', ')}`
        };
      }

      const modifiedData = data.map(row => {
        const newRow = { ...row };
        const currentValue = normalizeNumericValue(row[intent.column!]);
        if (currentValue === null) {
          return newRow;
        }

        let updatedValue = currentValue;
        switch (intent.transformType) {
          case 'add':
            updatedValue = currentValue + intent.transformValue!;
            break;
          case 'subtract':
            updatedValue = currentValue - intent.transformValue!;
            break;
          case 'multiply':
            updatedValue = currentValue * intent.transformValue!;
            break;
          case 'divide':
            if (intent.transformValue === 0) {
              return newRow;
            }
            updatedValue = currentValue / intent.transformValue!;
            break;
          default:
            break;
        }

        // Round to 2 decimal places
        newRow[intent.column!] = Math.round(updatedValue * 100) / 100;
        return newRow;
      });

      let answerText = `✅ Updated column "${intent.column}" by ${intent.transformType === 'add' ? 'adding' : intent.transformType === 'subtract' ? 'subtracting' : intent.transformType === 'multiply' ? 'multiplying by' : 'dividing by'} ${intent.transformValue}.`;
      if (shouldShowPreview) {
        answerText += ` Here's a preview of the updated data:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData,
        op: 'modify_column',
        description: `Adjusted column "${intent.column}" by ${intent.transformType} ${intent.transformValue}`,
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'aggregate': {
      // ARCH-2 / CQ-2 · delegated to handlers/aggregate.ts (behaviour-preserving)
      return await handleAggregate({
        intent,
        data,
        sessionDoc,
        originalMessage,
      });
    }

    case 'pivot': {
      // ARCH-2 / CQ-2 · delegated to handlers/pivot.ts (behaviour-preserving)
      return await handlePivot({
        intent,
        data,
        originalMessage,
      });
    }

    case 'remove_rows': {
      if (data.length === 0) {
        return { answer: 'There are no rows to remove.' };
      }

      // Determine which row(s) to remove
      const indicesToRemove = new Set<number>();
      const rowCount = intent.rowCount && intent.rowCount > 0 ? intent.rowCount : 1;

      if (intent.rowIndex && intent.rowIndex > 0 && intent.rowIndex <= data.length) {
        // Remove a specific row index (1-based)
        indicesToRemove.add(intent.rowIndex - 1);
      } else if (intent.rowPosition === 'keep_first') {
        // Special case: "keep only first N rows" means "remove all rows after row N"
        // Keep first N rows, remove the rest
        const keepCount = Math.min(rowCount, data.length);
        for (let i = keepCount; i < data.length; i++) {
          indicesToRemove.add(i);
        }
      } else if (intent.rowPosition === 'first') {
        const count = Math.min(rowCount, data.length);
        for (let i = 0; i < count; i++) {
          indicesToRemove.add(i);
        }
      } else if (intent.rowPosition === 'last') {
        const count = Math.min(rowCount, data.length);
        for (let i = 0; i < count; i++) {
          indicesToRemove.add(data.length - 1 - i);
        }
      }

      if (indicesToRemove.size === 0) {
        return { answer: 'Please specify which row to remove (first, last, or row number).' };
      }

      const modifiedData = data.filter((_, idx) => !indicesToRemove.has(idx));

      // Build a human-readable description
      const isKeepFirst = intent.rowPosition === 'keep_first';
      const sortedIndices = Array.from(indicesToRemove).sort((a, b) => a - b);
      const removedCount = sortedIndices.length;
      const keptCount = modifiedData.length;
      
      let description: string;
      let answerText: string;
      
      if (isKeepFirst) {
        // For "keep only first N rows", provide a clearer message
        description = `all rows except the first ${keptCount}`;
        answerText = `✅ Kept only the first ${keptCount} rows and removed ${removedCount} row${removedCount === 1 ? '' : 's'}. Dataset now has ${keptCount} row${keptCount === 1 ? '' : 's'}.`;
      } else if (removedCount === 1) {
        description = `row ${sortedIndices[0]! + 1}`;
        answerText = `✅ Removed ${description}.`;
      } else if (removedCount > 1 && sortedIndices[sortedIndices.length - 1]! - sortedIndices[0]! + 1 === removedCount) {
        // Consecutive range
        description = `rows ${sortedIndices[0]! + 1}-${sortedIndices[sortedIndices.length - 1]! + 1}`;
        answerText = `✅ Removed ${description}.`;
      } else {
        description = `rows ${sortedIndices.map(i => i + 1).join(', ')}`;
        answerText = `✅ Removed ${description}.`;
      }

      if (shouldShowPreview) {
        answerText += ` Here's a preview of the updated data:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData,
        op: 'remove_rows',
        description: isKeepFirst ? `Kept first ${keptCount} rows, removed ${removedCount} rows` : `Removed ${description}`,
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'add_row': {
      const template = data[0] || {};
      const newRow: DataRow = {};
      for (const key of Object.keys(template)) {
        newRow[key] = null;
      }

      const modifiedData = [...data, newRow];

      let answerText = `✅ Added a new empty row at the bottom.`;
      if (shouldShowPreview) {
        answerText += ` Here's a preview:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData,
        op: 'add_row',
        description: 'Added a new empty row at the end of the dataset',
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'replace_value': {
      if (intent.oldValue === undefined) {
        return {
          answer: 'Please specify which value you want to replace. For example: "replace - with 0" or "remove the value -"'
        };
      }
      
      if (intent.newValue === undefined) {
        return {
          answer: 'Please specify what value to replace it with. For example: "replace - with 0" or "replace - with null"'
        };
      }
      
      // Replace values in the dataset
      let replacedCount = 0;
      const modifiedData = data.map(row => {
        const newRow = { ...row };
        const columnsToProcess = intent.column ? [intent.column] : Object.keys(row);
        
        for (const col of columnsToProcess) {
          if (col in row) {
            const currentValue = row[col];
            // Compare values (handle null, strings, numbers)
            let shouldReplace = false;
            
            if (intent.oldValue === null || intent.oldValue === 'null') {
              shouldReplace = (currentValue === null || currentValue === undefined || currentValue === '');
            } else if (intent.oldValue === '-') {
              // Handle dash/placeholder values (including variations with spaces)
              const currentStr = String(currentValue).trim();
              shouldReplace = (currentStr === '-' || currentStr === ' - ' || currentStr === '—' || currentStr === '–');
            } else {
              // String or number comparison
              shouldReplace = (String(currentValue).trim() === String(intent.oldValue).trim());
            }
            
            if (shouldReplace) {
              // Round numeric newValue to 2 decimal places
              if (typeof intent.newValue === 'number') {
                newRow[col] = Math.round(intent.newValue * 100) / 100;
              } else if (intent.newValue === null || intent.newValue === 'null') {
                newRow[col] = null;
              } else {
                newRow[col] = intent.newValue;
              }
              replacedCount++;
            }
          }
        }
        return newRow;
      });
      
      let answerText = `✅ Replaced ${replacedCount} occurrence(s) of "${intent.oldValue}" with "${intent.newValue}"${intent.column ? ` in column "${intent.column}"` : ' across all columns'}.`;
      if (shouldShowPreview) {
        answerText += ` Here's a preview of the updated data:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData,
        op: 'replace_value',
        description: `Replaced ${replacedCount} occurrence(s) of "${intent.oldValue}" with "${intent.newValue}"${intent.column ? ` in column "${intent.column}"` : ' across all columns'}`,
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'remove_column': {
      if (!intent.column) {
        return {
          answer: 'Please specify which column you want to remove. For example: "Remove column PAB nGRP Adstocked"'
        };
      }
      
      // Check if column exists
      if (data.length > 0 && !(intent.column in data[0]!)) {
        return {
          answer: `Column "${intent.column}" not found. Available columns: ${Object.keys(data[0] || {}).join(', ')}`
        };
      }
      
      // Remove the column
      const modifiedData = data.map(row => {
        const newRow = { ...row };
        delete newRow[intent.column!];
        return newRow;
      });
      
      let answerText = `✅ Successfully removed column "${intent.column}".`;
      if (shouldShowPreview) {
        answerText += ` Here's a preview of the updated data:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData,
        op: 'remove_column',
        description: `Removed column "${intent.column}"`,
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'rename_column': {
      // ARCH-2 / CQ-2 · delegated to handlers/renameColumn.ts (behaviour-preserving)
      return await handleRenameColumn({
        intent,
        data,
        sessionId,
        sessionDoc,
        chatHistory,
        shouldShowPreview,
      });
    }

    case 'convert_type': {
      if (!intent.column || !intent.targetType) {
        return {
          answer: 'Please specify both column and target type.'
        };
      }
      
      const result = await convertDataType(data, intent.column, intent.targetType);
      
      const errorMsg = result.conversion_info.errors.length > 0
        ? ` Note: ${result.conversion_info.errors.join(', ')}`
        : '';
      let answerText = `✅ Converted "${intent.column}" to ${intent.targetType}.${errorMsg}`;
      if (shouldShowPreview) {
        answerText += ` Here's a preview:`;
      }

      return persistAndPreview({
        sessionId,
        sessionDoc,
        modifiedData: result.data,
        op: 'convert_type',
        description: `Converted ${intent.column} to ${intent.targetType}`,
        shouldShowPreview,
        answer: answerText,
      });
    }

    case 'train_model': {
      // ARCH-2 / CQ-2 · delegated to handlers/trainModel.ts (behaviour-preserving)
      return await handleTrainModel({
        intent,
        data,
        sessionDoc,
        originalMessage,
        chatHistory,
      });
    }

    case 'identify_outliers': {
      // ARCH-2 · delegated to handlers/identifyOutliers.ts (behaviour-preserving)
      return await handleIdentifyOutliers({
        data,
        column: intent.column,
        outlierMethod: intent.outlierMethod,
        outlierThreshold: intent.outlierThreshold,
      });
    }

    case 'treat_outliers': {
      // ARCH-2 / CQ-2 · delegated to handlers/treatOutliers.ts (behaviour-preserving)
      return await handleTreatOutliers({
        intent,
        data,
        sessionId,
        sessionDoc,
      });
    }

    case 'filter': {
      // ARCH-2 / CQ-2 · delegated to handlers/filter.ts (behaviour-preserving)
      return await handleFilter({
        intent,
        data,
        sessionId,
        sessionDoc,
      });
    }

    case 'revert': {
      // ARCH-2 / CQ-2 · delegated to handlers/revert.ts (behaviour-preserving)
      return await handleRevert({
        sessionId,
        sessionDoc,
      });
    }

    default:
      // For unknown operations, try to provide a helpful response
      logger.error(`❌ Unknown operation: "${intent.operation}". Intent details:`, {
        operation: intent.operation,
        groupByColumn: intent.groupByColumn,
        aggColumns: intent.aggColumns,
        requiresClarification: intent.requiresClarification,
        clarificationMessage: intent.clarificationMessage,
      });
      return {
        answer: 'I can help you with data operations like:\n\n' +
          '• **Revert data**: "Revert to original" or "Restore original data"\n' +
          '• **Aggregate data**: "Aggregate by Month" or "Aggregate RISK_VOLUME on DEPOT"\n' +
          '• **Create pivot tables**: "Create a pivot on Brand showing Sales, Spend, ROI"\n' +
          '• **Remove columns**: "Remove column X" or "Delete column Y"\n' +
          '• **Rename columns**: "Rename column X to Y" or "Change the above column name to Two"\n' +
          '• **Create columns**: "Create column XYZ = A + B" or "Add column Status with value Active"\n' +
          '• **Adjust column values**: "Increase column X by 50" or "Reduce column Y by 100"\n' +
          '• **Normalize columns**: "Normalize column Sales" or "Standardize metric Z"\n' +
          '• **Add/Remove rows**: "Add a new row" or "Remove last row"\n' +
          '• **Count null values**: "How many null values are there?" or "Count nulls in columnX"\n' +
          '• **View data**: "Show me the data" or "Show top 100 rows"\n' +
          '• **Data summary**: "Give me a data summary" or "Show statistics"\n' +
          '• **Remove nulls**: "Remove null values" or "Delete nulls in columnX"\n' +
          '• **Convert types**: "Convert columnX to numeric/date/percentage"\n' +
          '• **Describe data**: "How many rows/columns?" or "Describe the dataset"\n\n' +
          'What would you like to do with your data?'
      };
  }
}

