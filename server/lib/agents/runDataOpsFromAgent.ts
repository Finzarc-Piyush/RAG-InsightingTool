import { resolveContextReferences } from "./contextResolver.js";
import {
  type DataOpsIntent,
  parseDataOpsIntent,
  executeDataOperation,
} from "../dataOps/dataOpsOrchestrator.js";
import { getChatBySessionIdEfficient } from "../../models/chat.model.js";
import type { AgentExecutionContext } from "./runtime/types.js";
import type { ChartSpec, Insight } from "../../shared/schema.js";

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

  const dataset =
    Array.isArray(sessionDoc.rawData) && sessionDoc.rawData.length > 0
      ? sessionDoc.rawData
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
    return { answer: `I couldn't complete that data operation: ${message}` };
  }
}
