import type { AnalysisIntent } from "./intentClassifier.js";
import { resolveContextReferences } from "./contextResolver.js";
import { DataOpsHandler } from "./handlers/dataOpsHandler.js";
import type { HandlerContext } from "./handlers/baseHandler.js";
import { askClarifyingQuestion } from "./utils/clarification.js";
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

function buildPermanentContext(exec: AgentExecutionContext): string | undefined {
  const parts: string[] = [];
  if (exec.permanentContext?.trim()) parts.push(exec.permanentContext.trim());
  if (exec.sessionAnalysisContext) {
    parts.push(
      `SessionAnalysisContextJSON:\n${JSON.stringify(exec.sessionAnalysisContext).slice(0, 8000)}`
    );
  }
  return parts.length ? parts.join("\n\n---\n\n") : undefined;
}

const dataOpsHandlerSingleton = new DataOpsHandler();

/**
 * Run the same DataOpsHandler path as orchestrator data-ops mode (no AgentOrchestrator.processQuery).
 */
export async function runDataOpsFromAgentContext(exec: AgentExecutionContext): Promise<{
  answer: string;
  charts?: ChartSpec[];
  insights?: Insight[];
  table?: any;
  operationResult?: any;
}> {
  const enrichedQuestion = resolveContextReferences(exec.question, exec.chatHistory);
  if (isCorrelationStyleQuestion(enrichedQuestion)) {
    return {
      answer:
        "Correlation and driver questions belong in analysis mode. Switch to analysis or ask for a data transformation (e.g. add column, filter).",
    };
  }

  const intent: AnalysisIntent = {
    type: "custom",
    confidence: 1.0,
    customRequest: enrichedQuestion,
    requiresClarification: false,
  };

  const handlerContext: HandlerContext = {
    data: exec.data,
    summary: exec.summary,
    context: {
      dataChunks: [],
      pastQueries: [],
      mentionedColumns: [],
    },
    chatHistory: exec.chatHistory,
    sessionId: exec.sessionId,
    chatInsights: exec.chatInsights,
    permanentContext: buildPermanentContext(exec),
  };

  const intentWithQuestion = { ...intent, originalQuestion: enrichedQuestion };
  const response = await dataOpsHandlerSingleton.handle(intentWithQuestion, handlerContext);

  if (
    (response as { shouldTryNextHandler?: boolean }).shouldTryNextHandler ||
    (response.answer === "" && !response.error && !response.requiresClarification)
  ) {
    return {
      answer:
        "That reads like an analysis question, not a data transformation. Switch to analysis mode or rephrase as a concrete data operation (e.g. add column, filter rows).",
    };
  }

  if (response.error) {
    return {
      answer: response.answer || `Error: ${response.error}`,
      table: response.table,
      operationResult: response.operationResult,
    };
  }

  if (response.requiresClarification) {
    const q = await askClarifyingQuestion(intent, exec.summary);
    return { answer: q.answer };
  }

  return {
    answer: response.answer,
    charts: response.charts,
    insights: response.insights,
    table: response.table,
    operationResult: response.operationResult,
  };
}
