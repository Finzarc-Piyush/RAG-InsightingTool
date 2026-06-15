/**
 * ============================================================================
 * runDataOpsFromAgent.ts — the bridge that lets the agent actually edit the
 * dataset (add columns, filter rows, pivot, etc.).
 * ============================================================================
 * WHAT THIS FILE DOES
 *   "Data ops" means changing the data itself rather than just analysing it —
 *   adding a derived column, filtering rows, renaming, aggregating, pivoting,
 *   reverting to the original, and so on. This file is the single entry point the
 *   agentic runtime calls when a request has been routed to dataOps mode. It
 *   cleans up the question (resolving "that column" etc.), guards against
 *   questions that are really analysis in disguise, loads the session's dataset
 *   (applying any active filter), figures out the precise operation, runs it, and
 *   hands back a friendly answer plus a small preview table.
 *
 * WHY IT MATTERS
 *   It is the modern, fully-agentic replacement for the old DataOpsHandler /
 *   AgentOrchestrator classes — there is deliberately no dependency on that
 *   legacy path. Without it the agent could talk about the data but never modify
 *   it. The correlation-style guard is important: correlation/driver questions
 *   must go to analysis mode, so this refuses them with a helpful nudge rather
 *   than mangling them into a transformation.
 *
 * KEY PIECES
 *   - runDataOpsFromAgentContext(exec) — the only export. Takes the agent's
 *     execution context, returns { answer, charts?, insights?, table?,
 *     operationResult? }. Handles the empty-question, clarification-needed, and
 *     "unknown operation" cases with plain-English messages.
 *   - isCorrelationStyleQuestion(text) — regex guard mirroring the orchestrator's
 *     routing: anything that smells like correlation/driver analysis is bounced
 *     back to analysis mode.
 *
 * HOW IT CONNECTS
 *   Uses resolveContextReferences (contextResolver.js) to expand follow-ups;
 *   parseDataOpsIntent + executeDataOperation (dataOps/dataOpsOrchestrator.js) to
 *   understand and run the operation; getChatBySessionIdEfficient (chat.model.js)
 *   to load the session document; applyActiveFilter (activeFilter/) to respect
 *   the user's current filter. AgentExecutionContext + ChartSpec/Insight types
 *   come from the runtime types and shared schema.
 */
import { resolveContextReferences } from "./contextResolver.js";
import {
  type DataOpsIntent,
  parseDataOpsIntent,
  executeDataOperation,
} from "../dataOps/dataOpsOrchestrator.js";
import { getChatBySessionIdEfficient } from "../../models/chat.model.js";
import type { AgentExecutionContext } from "./runtime/types.js";
import type { ChartSpec, Insight } from "../../shared/schema.js";
import { applyActiveFilter } from "../activeFilter/applyActiveFilter.js";
import { errorMessage } from "../../utils/errorMessage.js";

/** Same routing as orchestrator: correlation-style questions are analysis, not data ops. */
function isCorrelationStyleQuestion(text: string): boolean {
  return (
    /\bcorrelation\s+(of|between|with|for)\b/i.test(text) ||
    /\bcorrelate\s+/i.test(text) ||
    /\b(what\s+)(affects?|impacts?|influences?)\s+/i.test(text) ||
    /\brelationship\s+(between|of)\s+/i.test(text)
  );
}

/**
 * Run the data-ops pipeline as an agentic tool. Pure agentic — no
 * dependency on the legacy `AgentOrchestrator` or `DataOpsHandler` class.
 */
export async function runDataOpsFromAgentContext(exec: AgentExecutionContext): Promise<{
  answer: string;
  charts?: ChartSpec[];
  insights?: Insight[];
  table?: any;
  operationResult?: any;
}> {
  const requestText = resolveContextReferences(exec.question, exec.chatHistory);
  if (isCorrelationStyleQuestion(requestText)) {
    return {
      answer:
        "Correlation and driver questions belong in analysis mode. Switch to analysis or ask for a data transformation (e.g. add column, filter).",
    };
  }
  if (!requestText.trim()) {
    return {
      answer: "Please let me know what data operation you would like me to perform.",
    };
  }

  const sessionDoc = await getChatBySessionIdEfficient(exec.sessionId);
  if (!sessionDoc) {
    return {
      answer: "I could not find this session. Please re-upload your dataset and try again.",
    };
  }

  // Apply active filter to whichever source we choose. `exec.data` already came
  // through `loadLatestData` so it's filtered, but `rawData` is a direct field
  // read and must be filtered explicitly here.
  const dataset =
    Array.isArray(sessionDoc.rawData) && sessionDoc.rawData.length > 0
      ? applyActiveFilter(sessionDoc.rawData, sessionDoc.activeFilter)
      : exec.data;

  let dataOpsIntent: DataOpsIntent;
  try {
    dataOpsIntent = await parseDataOpsIntent(
      requestText,
      exec.chatHistory,
      exec.summary,
      sessionDoc
    );
  } catch (error) {
    const message = errorMessage(error);
    return { answer: `I couldn't understand that data operation: ${message}` };
  }

  if (dataOpsIntent.requiresClarification) {
    return {
      answer:
        dataOpsIntent.clarificationMessage ||
        "Could you clarify which part of the data to work with?",
    };
  }

  // "unknown" + no clarification = general analysis question; tell the agent to switch modes.
  if (dataOpsIntent.operation === "unknown") {
    return {
      answer:
        "That reads like an analysis question, not a data transformation. Switch to analysis mode or rephrase as a concrete data operation (e.g. add column, filter rows).",
    };
  }

  try {
    const chatHistory = exec.chatHistory || sessionDoc.messages || [];
    const result = await executeDataOperation(
      dataOpsIntent,
      dataset,
      exec.sessionId,
      sessionDoc,
      requestText,
      chatHistory
    );
    return {
      answer: result.answer,
      table: result.preview || result.data?.slice(0, 50) || [],
      operationResult: {
        summary: result.summary,
        saved: result.saved,
      },
    };
  } catch (error) {
    const message = errorMessage(error);
    return { answer: `I couldn't complete that data operation: ${message}` };
  }
}
