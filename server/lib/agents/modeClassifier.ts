/**
 * ============================================================================
 * modeClassifier.ts — the very first fork in the road: which of three big
 * "modes" should a question go to?
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This is the top-level traffic cop. Before we work out the fine-grained intent
 *   (intentClassifier.ts), we first ask the LLM (language model) one coarse
 *   question: is the user trying to ANALYSE the data (correlations, charts,
 *   stats — the default), do DATA OPS on it (add/remove/transform columns, view
 *   the raw data), or do MODELING (build/train a machine-learning model)? It
 *   returns one of those three labels plus a confidence score and optional
 *   reasoning. It leans heavily on conversation history so a bare "yes" or "do
 *   it" inherits the mode of whatever was being discussed.
 *
 * WHY IT MATTERS
 *   It sits above every other classifier and handler — pick the wrong mode and
 *   the whole request goes to the wrong subsystem. It also accepts optional
 *   "ambient context" (standing user notes, FMCG/Marico domain vocabulary, and
 *   the interpreted intent from earlier turns) so it can resolve ambiguity that
 *   plain regex on the question text would get wrong — e.g. recognising that
 *   "compute MAT" is analytical vocabulary, not a data transformation, or that a
 *   short follow-up in a long modeling chat should stay in modeling mode.
 *
 * KEY PIECES
 *   - modeClassificationSchema / ModeClassification — the result shape (mode,
 *     confidence, optional reasoning), validated by Zod.
 *   - ClassifyModeContext — the four OPTIONAL ambient-context blocks
 *     (permanentContext, domainContext, userIntentVerbatim,
 *     userIntentConstraints) callers can thread in to disambiguate.
 *   - classifyMode(question, chatHistory, summary, maxRetries, context) — the
 *     main call: builds a tightly-capped prompt, asks the LLM for JSON, validates
 *     with Zod, retries, and falls back to keyword + chat-history matching if the
 *     LLM never returns valid output.
 *   - removeNulls(obj) — strips nulls so Zod accepts the LLM's optional fields.
 *
 * HOW IT CONNECTS
 *   Calls the LLM via runtime/callLlm.js (purpose MODE_CLASSIFY from
 *   runtime/llmCallPurpose.js) on the cheap "intent"-tier model from models.js.
 *   Called by chatStream.service / chat.service near the start of a request; the
 *   chosen mode then decides whether to run analysis, runDataOpsFromAgent.ts, or
 *   the modeling flow. Types DataSummary + Message come from the shared schema.
 */
import { z } from 'zod';
import { callLlm } from './runtime/callLlm.js';
import { LLM_PURPOSE } from './runtime/llmCallPurpose.js';
import { getModelForTask } from './models.js';
import { DataSummary, Message } from '../../shared/schema.js';
import { logger } from "../logger.js";

/**
 * Mode Classification Schema
 */
export const modeClassificationSchema = z.object({
  mode: z.enum(['analysis', 'dataOps', 'modeling']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});

export type ModeClassification = z.infer<typeof modeClassificationSchema>;

/**
 * Recursively remove ALL null values (Zod doesn't accept null for optional fields)
 */
function removeNulls(obj: any): any {
  if (obj === null || obj === undefined) {
    return undefined;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(removeNulls).filter(item => item !== undefined);
  }
  
  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanedValue = removeNulls(value);
      if (cleanedValue !== undefined) {
        cleaned[key] = cleanedValue;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  
  return obj;
}

/**
 * Optional ambient context the classifier can use to resolve ambiguity that
 * surface-form regex on the question would get wrong. With these blocks threaded
 * in, the classifier can: (a) honour user-stated intent in permanentContext,
 * (b) resolve FMCG/Marico vocabulary in domainContext (e.g. "compute MAT" →
 * analysis, not dataOps), (c) read the rolling SAC's
 * userIntent.interpretedConstraints so a multi-turn modeling conversation stays
 * in modeling mode even when the user's wording drifts.
 *
 * All four blocks are OPTIONAL. The current callers (chatStream.service,
 * chat.service) pass them when available; tests don't need to.
 */
export interface ClassifyModeContext {
  permanentContext?: string;
  domainContext?: string;
  userIntentVerbatim?: string;
  userIntentConstraints?: string[];
}

/**
 * Classify the top-level mode for a user query
 * This determines whether the query should route to analysis, dataOps, or modeling
 */
export async function classifyMode(
  question: string,
  chatHistory: Message[],
  summary: DataSummary,
  maxRetries: number = 2,
  context?: ClassifyModeContext
): Promise<ModeClassification> {
  // Build context from chat history
  const recentHistory = chatHistory
    .slice(-5) // Use fewer messages for mode classification (faster)
    .filter(msg => msg.content && msg.content.length < 500)
    .map((msg) => `${msg.role}: ${msg.content}`)
    .join('\n');

  const historyContext = recentHistory ? `\n\nCONVERSATION HISTORY:\n${recentHistory}` : '';

  // Build available columns context
  const allColumns = summary.columns.map(c => c.name).join(', ');

  // Optional user-intent + domain blocks. User-provided context (notes, stated
  // intent, interpreted constraints) is surfaced VERBATIM — never capped — so the
  // user's added context is honoured in full even on this MINI-tier routing call.
  const userNotes = (context?.permanentContext ?? '').trim();
  const userNotesBlock = userNotes
    ? `\n\nUSER NOTES (standing context the user set on this session — apply when relevant to the routing decision):\n${userNotes}`
    : '';
  const userIntent = context?.userIntentVerbatim?.trim();
  const interpretedConstraints = (context?.userIntentConstraints ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const userIntentBlock =
    userIntent || interpretedConstraints.length
      ? `\n\nUSER INTENT (interpreted from earlier turns; should bias short follow-ups toward the matching mode):${
          userIntent ? `\n- stated: ${userIntent}` : ''
        }${
          interpretedConstraints.length
            ? `\n- constraints:\n  - ${interpretedConstraints.join('\n  - ')}`
            : ''
        }`
      : '';
  const domain = (context?.domainContext ?? '').trim();
  const domainBlock = domain
    ? `\n\nDOMAIN VOCABULARY (FMCG / Marico — background only; if the user's question uses a metric/term from this block, that's not a "dataOps" cue, it's the user reaching for known analytical vocabulary):\n${domain.slice(0, 1500)}`
    : '';

  const prompt = `You are a mode classifier for a data analysis AI assistant. Your job is to determine which top-level mode a user query should route to.

CURRENT QUESTION: ${question}
${historyContext}${userNotesBlock}${userIntentBlock}${domainBlock}

AVAILABLE DATA:
- Total rows: ${summary.rowCount}
- Total columns: ${summary.columnCount}
- Columns: ${allColumns}

CRITICAL: CONTEXT-AWARE CLASSIFICATION
The conversation history is EXTREMELY important. Short responses like "yes", "ok", "sure", "do it", "proceed", "go ahead", "that one", "the first one", "try it" are FOLLOW-UP responses that should be routed based on the PREVIOUS conversation context.

CONTEXT RULES:
- If the previous messages discuss MODELING (models, predictions, training, linear/logistic/random forest, polynomial regression), route to "modeling"
- If the previous messages discuss DATA OPERATIONS (adding columns, filtering, cleaning), route to "dataOps"  
- If the previous messages discuss ANALYSIS (correlations, charts, statistics, insights), route to "analysis"
- Short affirmative responses (yes, ok, sure, proceed, go ahead) should ALWAYS use the context from previous messages
- Responses like "create it for all variables", "use all variables", "all variables", "no create it for all variables" after a modeling question → route to "modeling"

CLASSIFICATION RULES:

0. CRITICAL – CORRELATION is always "analysis", never "dataOps":
   * If the user asks for CORRELATION (e.g. "correlation of X with Y", "correlation between X and Y", "correlation of column X with all the other variables", "what affects X", "what impacts X", "correlate X with Y"), ALWAYS route to "analysis". Correlation is statistical analysis, NOT a data transformation. Do NOT route correlation requests to "dataOps".

1. "dataOps" - User wants to manipulate, transform, or modify the dataset itself, OR view/explore the data structure
   * Do NOT use for correlation requests – correlation is analysis (see rule 0).
   * HIGH PRIORITY: Questions about adding, removing, or modifying columns/rows, OR viewing data structure/preview
   * Patterns: "add column", "remove column", "delete column", "filter rows", "remove rows", 
     "transform", "clean data", "merge", "join", "split", "rename column", "change column type",
     "replace values", "fill missing", "drop duplicates", "sort data", "group by", "aggregate",
     "aggregate by", "aggregate X on Y", "pivot", "create pivot", "revert", "revert to original",
     "restore original", "data preview", "data summary", "show me data", "display data", "view data", "see data",
     "show columns", "list columns", "data structure", "data overview", "preview data",
     "show rows", "display rows", "data sample", "sample data"
   * Set confidence to 0.9+ for clear data operation requests

2. "modeling" - User wants to build, train, or create a machine learning model
   * HIGH PRIORITY: Questions about building/training ML models
   * Patterns: "build a model", "train a model", "create a model", "predict", "machine learning",
     "linear model", "logistic model", "random forest", "decision tree", "regression", "classification",
     "which model", "best model", "compare models", "evaluate model", "model performance"
   * ALSO applies to follow-up questions in a modeling conversation:
     - "yes", "ok", "sure", "do it", "proceed" (after model training question)
     - "create it for all variables", "use all variables", "all variables", "all features", "for all", "no create it for all variables" (after model training question)
   * Set confidence to 0.9+ for clear modeling requests or follow-ups in modeling context

3. "analysis" - Everything else (default mode)
   * This includes: correlation analysis, statistical queries, chart requests, comparisons,
     trend analysis, insights, exploratory data analysis, "what affects", "show me", etc.
   * This is the default mode when the query doesn't clearly fit dataOps or modeling

IMPORTANT: For short/ambiguous queries, ALWAYS check the conversation history to determine the correct mode.

Examples with context:
- Previous: "Build a linear model" → Current: "yes" → Route to "modeling" (continuing modeling conversation)
- Previous: "Train a polynomial regression model for PA TOM" → Current: "no create it for all variables" → Route to "modeling" (user wants to proceed with all variables as features)
- Previous: "Train a model for X" → Current: "create it for all variables" → Route to "modeling" (user wants to use all variables as features)
- Previous: "What's the correlation?" → Current: "show me a chart" → Route to "analysis"
- Previous: "Add a column X" → Current: "ok do it" → Route to "dataOps"
- Previous: "Which model is best?" → Current: "try the random forest" → Route to "modeling"
- Previous Assistant: "Would you like me to create a chart to visualize these relationships?" → Current: "yes" → Route to "analysis" (user confirming chart suggestion, NOT modeling)
- Previous Assistant: "I can create a chart to visualize..." → Current: "yes" → Route to "analysis" (chart suggestion confirmation)
- Previous: "Does discount_amount impact total?" → Assistant: "Would you like me to create a chart?" → Current: "yes" → Route to "analysis" (confirming chart, NOT modeling)

OUTPUT FORMAT (JSON only, no markdown):
{
  "mode": "analysis" | "dataOps" | "modeling",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation including context consideration" (optional)
}`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const model = getModelForTask('intent');
      
      const response = await callLlm(
        {
          model,
          messages: [
            {
              role: 'system',
              content: 'You are a mode classifier. Output only valid JSON. Be precise in determining the correct mode.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2, // Lower temperature for more consistent classification
          max_tokens: 200,
        },
        { purpose: LLM_PURPOSE.MODE_CLASSIFY }
      );

      const content = response.choices[0]?.message.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      // Parse JSON
      let parsed: any;
      try {
        parsed = JSON.parse(content);
      } catch (parseError) {
        // Try to extract JSON from markdown code blocks
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1]!);
        } else {
          throw parseError;
        }
      }

      // Recursively remove ALL null values
      const cleaned = removeNulls(parsed);
      
      // Validate with Zod schema
      if (!cleaned || typeof cleaned !== 'object') {
        throw new Error('Cleaned parsed result is invalid');
      }
      
      // Ensure required fields exist
      if (!cleaned.mode || typeof cleaned.confidence !== 'number') {
        throw new Error('Missing required fields: mode or confidence');
      }
      
      const validated = modeClassificationSchema.parse(cleaned);
      
      logger.log(`✅ Mode classified: ${validated.mode} (confidence: ${validated.confidence.toFixed(2)})${validated.reasoning ? ` - ${validated.reasoning}` : ''}`);
      
      return validated;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(`⚠️ Mode classification attempt ${attempt + 1} failed:`, lastError.message);
      
      if (attempt < maxRetries - 1) {
        logger.log(`🔄 Retrying mode classification...`);
      }
    }
  }

  // If all retries failed, use fallback logic
  logger.error('❌ Mode classification failed after retries, using fallback');
  
  const questionLower = question.toLowerCase();
  let fallbackMode: 'analysis' | 'dataOps' | 'modeling' = 'analysis';
  let fallbackConfidence = 0.3;
  
  // Check if this is a short follow-up response
  const isShortResponse = question.trim().length < 20 && 
    /^(yes|no|ok|okay|sure|do it|proceed|go ahead|try it|that one|the first|the second|sounds good|perfect|great)\b/i.test(questionLower);
  
  // If short response, check chat history for context
  if (isShortResponse && chatHistory.length > 0) {
    // Look at recent messages for context
    const recentContent = chatHistory.slice(-4).map(m => m.content.toLowerCase()).join(' ');
    
    if (recentContent.match(/\b(model|train|predict|linear|logistic|random forest|decision tree|regression|classification|machine learning|modeling|best model|which model)\b/)) {
      fallbackMode = 'modeling';
      fallbackConfidence = 0.8;
      logger.log('📌 Fallback detected modeling context from chat history');
    } else if (recentContent.match(/\b(add column|remove column|filter|transform|clean|data preview|data summary|show data|display data)\b/)) {
      fallbackMode = 'dataOps';
      fallbackConfidence = 0.8;
      logger.log('📌 Fallback detected dataOps context from chat history');
    }
  } else {
    // Simple pattern matching for fallback
    if (questionLower.match(/\b(add|remove|delete|filter|transform|clean|merge|join|split|rename|replace|fill|drop|sort|group|pivot)\s+(column|row|data|dataset|values?)\b/) ||
        questionLower.match(/\b(data\s+preview|data\s+summary|show\s+me\s+data|display\s+data|view\s+data|see\s+data|show\s+columns|list\s+columns|data\s+structure|data\s+overview|preview\s+data|show\s+rows|display\s+rows|data\s+sample|sample\s+data|give\s+me\s+data)\b/)) {
      fallbackMode = 'dataOps';
      fallbackConfidence = 0.7;
    } else if (questionLower.match(/\b(build|train|create|predict|machine learning|linear model|logistic|random forest|decision tree|regression|classification|which model|best model|compare model)\b/)) {
      fallbackMode = 'modeling';
      fallbackConfidence = 0.6;
    }
  }

  return {
    mode: fallbackMode,
    confidence: fallbackConfidence,
    reasoning: isShortResponse ? 'Fallback classification based on chat history context' : 'Fallback classification based on keyword matching',
  };
}

