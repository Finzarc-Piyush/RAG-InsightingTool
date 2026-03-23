/**
 * Rolling session context: structured JSON, created and updated only via LLM (completeJson).
 */
import type { DataSummary, DatasetProfile } from "../shared/schema.js";
import {
  sessionAnalysisContextSchema,
  type SessionAnalysisContext,
} from "../shared/schema.js";
import { completeJson } from "./agents/runtime/llmJson.js";

const ISO = () => new Date().toISOString();

export function emptySessionAnalysisContext(): SessionAnalysisContext {
  return {
    version: 1,
    dataset: {
      shortDescription: "",
      columnRoles: [],
      caveats: [],
    },
    userIntent: {
      interpretedConstraints: [],
    },
    sessionKnowledge: {
      facts: [],
      analysesDone: [],
    },
    suggestedFollowUps: [],
    lastUpdated: { reason: "seed", at: ISO() },
  };
}

const SEED_SYSTEM = `You output only a JSON object matching the given schema (version 1).
Build the initial session analysis context from the provided dataset profile and numeric summary.
Populate dataset.* from the profile and column list. Leave userIntent mostly empty unless the input includes user notes.
Add suggestedFollowUps (short questions) inferred from the data — do not copy a fixed template; base them on actual columns and description.
Set lastUpdated.reason to "seed" and lastUpdated.at to the current ISO-8601 timestamp.`;

const MERGE_USER_SYSTEM = `You output only a JSON object matching the given schema (version 1).
You receive PREVIOUS_JSON and new USER_NOTES (verbatim). Merge USER_NOTES into userIntent and sessionKnowledge; refine interpretedConstraints and facts as appropriate.
Preserve dataset.* unless the user clearly corrects domain facts. Cap array lengths per schema.
Set lastUpdated.reason to "user_context" and lastUpdated.at to current ISO-8601.`;

const MERGE_ASSISTANT_SYSTEM = `You output only a JSON object matching the given schema (version 1).
You receive PREVIOUS_JSON and ASSISTANT_MESSAGE (and optional TOOL_TRACE_SUMMARY). Update sessionKnowledge.facts and analysesDone with durable takeaways from the assistant reply; refresh suggestedFollowUps if appropriate.
Do not wipe prior userIntent or dataset unless the message explicitly overrides them.
Set lastUpdated.reason to "assistant_turn" and lastUpdated.at to current ISO-8601.`;

function compactSummaryForPrompt(summary: DataSummary) {
  return {
    rowCount: summary.rowCount,
    columnCount: summary.columnCount,
    numericColumns: summary.numericColumns,
    dateColumns: summary.dateColumns,
    columns: summary.columns.map((c) => ({ name: c.name, type: c.type })),
  };
}

export async function seedSessionAnalysisContextLLM(params: {
  datasetProfile: DatasetProfile;
  dataSummary: DataSummary;
}): Promise<SessionAnalysisContext> {
  const user = JSON.stringify({
    datasetProfile: params.datasetProfile,
    dataSummary: compactSummaryForPrompt(params.dataSummary),
  });
  const out = await completeJson(SEED_SYSTEM, user, sessionAnalysisContextSchema, {
    turnId: "session_ctx_seed",
    maxTokens: 4096,
    temperature: 0.2,
  });
  if (!out.ok) {
    console.warn("⚠️ seedSessionAnalysisContextLLM failed:", out.error);
    return emptySessionAnalysisContext();
  }
  return out.data;
}

export async function mergeSessionAnalysisContextUserLLM(params: {
  previous: SessionAnalysisContext | undefined;
  userText: string;
}): Promise<SessionAnalysisContext> {
  const prev = params.previous ?? emptySessionAnalysisContext();
  const user = JSON.stringify({
    PREVIOUS_JSON: prev,
    USER_NOTES: params.userText.slice(0, 8000),
  });
  const out = await completeJson(MERGE_USER_SYSTEM, user, sessionAnalysisContextSchema, {
    turnId: "session_ctx_user",
    maxTokens: 4096,
    temperature: 0.2,
  });
  if (!out.ok) {
    console.warn("⚠️ mergeSessionAnalysisContextUserLLM failed:", out.error);
    return prev;
  }
  return out.data;
}

export async function mergeSessionAnalysisContextAssistantLLM(params: {
  previous: SessionAnalysisContext | undefined;
  assistantMessage: string;
  agentTraceSummary?: string;
}): Promise<SessionAnalysisContext> {
  const prev = params.previous ?? emptySessionAnalysisContext();
  const user = JSON.stringify({
    PREVIOUS_JSON: prev,
    ASSISTANT_MESSAGE: params.assistantMessage.slice(0, 12000),
    TOOL_TRACE_SUMMARY: params.agentTraceSummary?.slice(0, 6000) ?? null,
  });
  const out = await completeJson(MERGE_ASSISTANT_SYSTEM, user, sessionAnalysisContextSchema, {
    turnId: "session_ctx_assistant",
    maxTokens: 4096,
    temperature: 0.2,
  });
  if (!out.ok) {
    console.warn("⚠️ mergeSessionAnalysisContextAssistantLLM failed:", out.error);
    return prev;
  }
  return out.data;
}

/** Initial assistant message body: stats from summary + LLM shortDescription only (no hardcoded prompts). */
export function buildInitialAssistantContentFromContext(
  summary: DataSummary,
  ctx: SessionAnalysisContext
): string {
  const lines = [
    `${summary.rowCount} rows · ${summary.columnCount} columns`,
    `${summary.numericColumns.length} numeric columns`,
    `${summary.dateColumns.length} date columns`,
  ];
  const desc = ctx.dataset.shortDescription?.trim();
  if (desc) {
    lines.push("", desc);
  }
  return lines.join("\n");
}

/** After saving an assistant message: merge reply into rolling JSON and persist. */
export async function persistMergeAssistantSessionContext(params: {
  sessionId: string;
  username: string;
  assistantMessage: string;
  agentTrace?: unknown;
}): Promise<void> {
  const { getChatBySessionIdForUser, updateChatDocument } = await import(
    "../models/chat.model.js"
  );
  const doc = await getChatBySessionIdForUser(params.sessionId, params.username);
  if (!doc) return;
  let agentTraceSummary: string | undefined;
  if (params.agentTrace != null) {
    try {
      const s = JSON.stringify(params.agentTrace);
      agentTraceSummary = s.length > 6000 ? s.slice(0, 6000) : s;
    } catch {
      /* ignore */
    }
  }
  const next = await mergeSessionAnalysisContextAssistantLLM({
    previous: doc.sessionAnalysisContext,
    assistantMessage: params.assistantMessage,
    agentTraceSummary,
  });
  doc.sessionAnalysisContext = next;
  await updateChatDocument(doc);
}
