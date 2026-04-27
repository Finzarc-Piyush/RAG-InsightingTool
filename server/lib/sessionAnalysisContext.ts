/**
 * Rolling session context: structured JSON, created and updated only via LLM (completeJson).
 */
import { z } from "zod";
import type { AnalysisBrief, DataSummary, DatasetProfile } from "../shared/schema.js";
import {
  sessionAnalysisContextSchema,
  type SessionAnalysisContext,
} from "../shared/schema.js";
import { completeJson } from "./agents/runtime/llmJson.js";
import { LLM_PURPOSE } from "./agents/runtime/llmCallPurpose.js";
import type { AgentMidTurnSessionPayload } from "./agents/runtime/types.js";
import { withImmutableUserIntentFromPrevious } from "./sessionAnalysisContextGuards.js";

export { withImmutableUserIntentFromPrevious };

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

const NESTED_FIELD_TYPES = `
Nested field types (all required — do not deviate):
  columnRoles items  : { "name": "<string>", "role": "<string>", "notes": "<string|omit>" }
  facts items        : { "statement": "<string>", "source": "user"|"assistant"|"data", "confidence": "high"|"medium"|"low" }
  analysesDone items : plain strings, NOT objects
  interpretedConstraints items: plain strings, NOT objects
  lastUpdated.reason : exactly one of "seed" | "user_context" | "assistant_turn" | "mid_turn"`;

const SEED_SYSTEM = `You output only a JSON object matching the given schema (version 1).
Build the initial session analysis context from the provided dataset profile and numeric summary.
Populate dataset.* from the profile and column list. Leave userIntent mostly empty unless the input includes user notes.
Add suggestedFollowUps (short analytical questions) inferred from the data — do not copy a fixed template; base them on actual columns and description. Do NOT suggest questions about identifier/key columns (listed in datasetProfile.idColumns — they are row keys, not analysis dimensions). For date columns, ask how a numeric metric changes over time rather than asking the date column itself to "trend".
Set lastUpdated.reason to "seed" and lastUpdated.at to the current ISO-8601 timestamp.

Required top-level shape (all fields mandatory, no extras at the top level):
{
  "version": 1,
  "dataset": { "shortDescription": "...", "columnRoles": [], "caveats": [] },
  "userIntent": { "interpretedConstraints": [] },
  "sessionKnowledge": { "facts": [], "analysesDone": [] },
  "suggestedFollowUps": ["...", "..."],
  "lastUpdated": { "reason": "seed", "at": "<ISO-8601 timestamp>" }
}
${NESTED_FIELD_TYPES}`;

const MERGE_USER_SYSTEM = `You output only a JSON object matching the given schema (version 1).
You receive PREVIOUS_JSON and new USER_NOTES (verbatim). Merge USER_NOTES into userIntent and sessionKnowledge; refine interpretedConstraints and facts as appropriate.
Preserve dataset.* unless the user clearly corrects domain facts. Cap array lengths per schema.
Set lastUpdated.reason to "user_context" and lastUpdated.at to current ISO-8601.
${NESTED_FIELD_TYPES}`;

const MERGE_ASSISTANT_SYSTEM = `You output only a JSON object matching the given schema (version 1).
You receive PREVIOUS_JSON and ASSISTANT_MESSAGE (and optional TOOL_TRACE_SUMMARY). Update sessionKnowledge.facts and analysesDone with durable takeaways from the assistant reply. You may prune or merge duplicate/stale entries in sessionKnowledge and shorten suggestedFollowUps when the list is noisy; keep only high-value follow-ups.
Copy dataset.* forward unless the message clearly corrects domain facts. Do NOT modify userIntent in any way (it is merged only from user messages).
Set lastUpdated.reason to "assistant_turn" for full assistant replies, or "mid_turn" when ASSISTANT_MESSAGE starts with "[mid_turn]", and lastUpdated.at to current ISO-8601.
${NESTED_FIELD_TYPES}`;

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
    purpose: LLM_PURPOSE.SESSION_CONTEXT,
  });
  if (!out.ok) {
    console.warn("⚠️ seedSessionAnalysisContextLLM failed:", out.error);
    return emptySessionAnalysisContext();
  }
  return out.data;
}

const REGENERATE_STARTER_QUESTIONS_SYSTEM = `You output only a JSON object of the exact shape { "suggestedFollowUps": ["..."] }.
You will be given DATASET_PROFILE, DATA_SUMMARY, and USER_NOTES describing the analyst's goals/domain context.
Produce 5–8 short, concrete analytical questions that an analyst with these goals would actually want answered from this data. Tailor the questions to the user's stated intent.
Do NOT copy a fixed template. Do NOT ask about identifier/key columns (listed in datasetProfile.idColumns — they are row keys, not analysis dimensions). For date columns, ask how a numeric metric changes over time rather than asking the date column itself to "trend".
Questions must be answerable from the columns present in DATA_SUMMARY.`;

const starterQuestionsSchema = z.object({
  suggestedFollowUps: z.array(z.string()).max(12),
});

/**
 * Regenerate starter questions when the user adds context. Runs as a follow-up
 * pass — the initial welcome message is produced by the upload pipeline
 * without waiting for user input (see `seedSessionAnalysisContextLLM`).
 */
export async function regenerateStarterQuestionsLLM(params: {
  datasetProfile: DatasetProfile;
  dataSummary: DataSummary;
  permanentContext: string;
}): Promise<string[]> {
  const userText = params.permanentContext.trim();
  if (!userText) return [];
  const user = JSON.stringify({
    DATASET_PROFILE: params.datasetProfile,
    DATA_SUMMARY: compactSummaryForPrompt(params.dataSummary),
    USER_NOTES: userText.slice(0, 8000),
  });
  const out = await completeJson(
    REGENERATE_STARTER_QUESTIONS_SYSTEM,
    user,
    starterQuestionsSchema,
    {
      turnId: "starter_questions_regen",
      maxTokens: 1024,
      temperature: 0.3,
      purpose: LLM_PURPOSE.SUGGEST_FOLLOW_UPS,
    }
  );
  if (!out.ok) {
    console.warn("⚠️ regenerateStarterQuestionsLLM failed:", out.error);
    return [];
  }
  return out.data.suggestedFollowUps.filter((q) => q?.trim()).slice(0, 8);
}

export async function mergeSessionAnalysisContextUserLLM(params: {
  previous: SessionAnalysisContext | undefined;
  userText: string;
}): Promise<SessionAnalysisContext> {
  const prev = params.previous ?? emptySessionAnalysisContext();
  const nextUserText = params.userText.trim();
  if (!nextUserText) return prev;
  const existingNotes = prev.userIntent?.verbatimNotes?.trim();
  if (existingNotes && existingNotes.includes(nextUserText)) {
    return prev;
  }
  const user = JSON.stringify({
    PREVIOUS_JSON: prev,
    USER_NOTES: nextUserText.slice(0, 8000),
  });
  const out = await completeJson(MERGE_USER_SYSTEM, user, sessionAnalysisContextSchema, {
    turnId: "session_ctx_user",
    maxTokens: 4096,
    temperature: 0.2,
    purpose: LLM_PURPOSE.SESSION_CONTEXT,
  });
  if (!out.ok) {
    console.warn("⚠️ mergeSessionAnalysisContextUserLLM failed:", out.error);
    return prev;
  }
  return out.data;
}

/** Programmatic merge after a successful analysis brief (bounded; no extra LLM). */
export function applyAnalysisBriefDigestToSession(
  ctx: SessionAnalysisContext,
  brief: AnalysisBrief
): SessionAnalysisContext {
  const at = new Date().toISOString();
  const filterSummary = (brief.filters ?? [])
    .map((f) =>
      `${f.column}:${f.op}:${f.values
        .slice(0, 6)
        .join(",")}${f.values.length > 6 ? "…" : ""}`
    )
    .join("; ")
    .slice(0, 1500);
  const digest = {
    at,
    outcomeMetricColumn: brief.outcomeMetricColumn,
    filterSummary: filterSummary.trim() || undefined,
    comparisonBaseline: brief.comparisonBaseline,
    clarifyingQuestionCount: brief.clarifyingQuestions?.length,
    epistemicNotePreview: brief.epistemicNotes?.[0]?.slice(0, 500) || undefined,
  };
  return sessionAnalysisContextSchema.parse({
    ...ctx,
    analysisBriefDigest: digest,
    lastUpdated: { reason: "assistant_turn", at },
  });
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
    purpose: LLM_PURPOSE.SESSION_CONTEXT,
  });
  if (!out.ok) {
    console.warn("⚠️ mergeSessionAnalysisContextAssistantLLM failed:", out.error);
    return prev;
  }
  const merged = out.data;
  return withImmutableUserIntentFromPrevious(prev, merged);
}

/** Lightweight rolling merge during the agent turn (throttled by caller). */
export async function persistMidTurnAssistantSessionContext(params: {
  sessionId: string;
  username: string;
  summary: string;
  tool?: string;
  ok?: boolean;
  phase?: AgentMidTurnSessionPayload["phase"];
}): Promise<void> {
  const phase = params.phase ?? (params.tool != null ? "tool" : "plan");
  const head =
    params.tool != null
      ? `[mid_turn] phase=${phase} tool=${params.tool} ok=${params.ok ?? true}`
      : `[mid_turn] phase=${phase}`;
  const body = `${head}\n${params.summary.slice(0, 4000)}`;
  await persistMergeAssistantSessionContext({
    sessionId: params.sessionId,
    username: params.username,
    assistantMessage: body,
    agentTrace: undefined,
  });
}

/**
 * Initial assistant message shown after enrichment.
 * Includes everything the LLM understood about the dataset so the user can
 * verify the context before asking questions.
 *
 * Robustness: the LLM-derived `columnRoles` / `caveats` are populated by a
 * fire-and-forget `seedSessionAnalysisContextLLM` after upload, so the
 * initial message often runs against a sparse heuristic context. In that
 * case we synthesize a "Columns at a glance" section directly from
 * `summary` so the message always has substance — never just one stat
 * line. See feedback memory: non-blocking startup must produce visible
 * artifacts from automatic understanding alone.
 */
export function buildInitialAssistantContentFromContext(
  summary: DataSummary,
  ctx: SessionAnalysisContext
): string {
  const lines: string[] = [];

  // ── Dataset overview ──────────────────────────────────────────────────────
  lines.push(`**${summary.rowCount.toLocaleString()} rows · ${summary.columnCount} columns** (${summary.numericColumns.length} numeric, ${summary.dateColumns.length} date)`);

  const desc = ctx.dataset.shortDescription?.trim();
  if (desc) lines.push("", desc);

  if (ctx.dataset.grainGuess) lines.push("", `**Row grain:** ${ctx.dataset.grainGuess}`);

  // ── Column roles ─────────────────────────────────────────────────────────
  // When the LLM seed has landed we render the structured column roles. When
  // it hasn't (heuristic-only state on a fresh upload) we fall back to a
  // deterministic columns-at-a-glance breakdown derived from `summary` so the
  // user still sees what we understood about the dataset.
  if (ctx.dataset.columnRoles.length > 0) {
    lines.push("", "**Column roles understood:**");
    for (const col of ctx.dataset.columnRoles) {
      const note = col.notes ? ` — ${col.notes}` : "";
      lines.push(`• ${col.name} *(${col.role})*${note}`);
    }
  } else {
    const numericNames = summary.numericColumns;
    const dateNames = summary.dateColumns;
    const dateNameSet = new Set(dateNames);
    const numericNameSet = new Set(numericNames);
    const otherNames = summary.columns
      .map((c) => c.name)
      .filter((n) => !numericNameSet.has(n) && !dateNameSet.has(n));

    // Date columns gain calendar grains via hidden __tf_* facet columns; surface
    // those as a capability hint per source date column ("order_date — year,
    // quarter, month") rather than exposing the internal column names.
    // Source: summary.temporalFacetColumns metadata + agent prompt at
    // server/lib/dataOps/dataOpsOrchestrator.ts:1755-1764 which tells the agent
    // to group by these for "by year/quarter/month" requests.
    const grainsBySource = new Map<string, string[]>();
    for (const tf of summary.temporalFacetColumns ?? []) {
      const list = grainsBySource.get(tf.sourceColumn) ?? [];
      if (!list.includes(tf.grain)) list.push(tf.grain);
      grainsBySource.set(tf.sourceColumn, list);
    }
    const formatDateName = (name: string): string => {
      const grains = grainsBySource.get(name);
      if (!grains?.length) return name;
      return `${name} *(can group by ${grains.join(", ")})*`;
    };

    const sections: Array<{ label: string; names: string[]; format?: (n: string) => string }> = [];
    if (numericNames.length > 0) sections.push({ label: "Numeric", names: numericNames });
    if (dateNames.length > 0) sections.push({ label: "Date", names: dateNames, format: formatDateName });
    if (otherNames.length > 0) sections.push({ label: "Categorical", names: otherNames });

    if (sections.length > 0) {
      lines.push("", "**Columns at a glance:**");
      for (const s of sections) {
        const formatter = s.format ?? ((n: string) => n);
        const shown = s.names.slice(0, 6).map(formatter).join(", ");
        const more = s.names.length > 6 ? ` *(+${s.names.length - 6} more)*` : "";
        lines.push(`• ${s.label}: ${shown}${more}`);
      }
    }
  }

  // ── Caveats ───────────────────────────────────────────────────────────────
  if (ctx.dataset.caveats.length > 0) {
    lines.push("", "**Data caveats:**");
    for (const c of ctx.dataset.caveats) lines.push(`• ${c}`);
  }

  // Suggested questions are rendered as clickable pills in the UI (see
  // MessageBubble.tsx), so we intentionally omit them from the markdown body.

  return lines.join("\n");
}

/** After saving an assistant message: merge reply into rolling JSON and persist. */
export async function persistMergeAssistantSessionContext(params: {
  sessionId: string;
  username: string;
  assistantMessage: string;
  agentTrace?: unknown;
  analysisBrief?: AnalysisBrief;
  /**
   * W21 · question + InvestigationSummary for the turn that just shipped.
   * When provided AND the digest has any meaningful content, we append a
   * `PriorInvestigation` entry to `sessionKnowledge.priorInvestigations`
   * so the next turn's planner can chain hypotheses across turns.
   */
  question?: string;
  investigationSummary?: import("../shared/schema.js").InvestigationSummary;
}): Promise<import("../shared/schema.js").SessionAnalysisContext | undefined> {
  // W31 · returns the new SessionAnalysisContext (or undefined when the
  // chat doc is missing) so the streaming caller can emit it via SSE for
  // real-time UI refresh of the W26 PriorInvestigationsBanner. Existing
  // void-using callers ignore the return value — forward-compatible.
  const { getChatBySessionIdForUser, updateChatDocument } = await import(
    "../models/chat.model.js"
  );
  const doc = await getChatBySessionIdForUser(params.sessionId, params.username);
  if (!doc) return undefined;
  let agentTraceSummary: string | undefined;
  if (params.agentTrace != null) {
    try {
      const s = JSON.stringify(params.agentTrace);
      agentTraceSummary = s.length > 6000 ? s.slice(0, 6000) : s;
    } catch {
      /* ignore */
    }
  }
  let next = await mergeSessionAnalysisContextAssistantLLM({
    previous: doc.sessionAnalysisContext,
    assistantMessage: params.assistantMessage,
    agentTraceSummary,
  });
  if (params.analysisBrief) {
    next = applyAnalysisBriefDigestToSession(next, params.analysisBrief);
  }
  // W21 · push a prior-investigation digest onto sessionKnowledge so the
  // next turn's planner sees what was confirmed / refuted / left open.
  // Skipped silently when the question or summary is empty.
  if (params.question && params.investigationSummary) {
    const { appendPriorInvestigation, buildPriorInvestigationDigest } =
      await import("./agents/runtime/priorInvestigations.js");
    const digest = buildPriorInvestigationDigest(
      params.question,
      params.investigationSummary
    );
    if (digest) next = appendPriorInvestigation(next, digest);
  }
  doc.sessionAnalysisContext = next;
  await updateChatDocument(doc);
  return next;
}
