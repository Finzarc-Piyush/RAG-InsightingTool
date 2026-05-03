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
import { buildDeterministicScopeFacts } from "./datasetScopeFacts.js";

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
  dimensionHierarchies items: { "column": "<existing column name>", "rollupValue": "<value in that column that is a category total>", "itemValues": ["<child value>", ...]|omit, "source": "user", "description": "<short explanation>"|omit }
  lastUpdated.reason : exactly one of "seed" | "user_context" | "assistant_turn" | "mid_turn"`;

const SEED_SYSTEM = `You output only a JSON object matching the given schema (version 1).
Build the initial session analysis context from the provided dataset profile and numeric summary.
Populate dataset.* from the profile and column list. Leave userIntent mostly empty unless the input includes user notes.
Add suggestedFollowUps (short analytical questions) inferred from the data — do not copy a fixed template; base them on actual columns and description. Do NOT suggest questions about identifier/key columns (listed in datasetProfile.idColumns — they are row keys, not analysis dimensions). For date columns, ask how a numeric metric changes over time rather than asking the date column itself to "trend".
Set lastUpdated.reason to "seed" and lastUpdated.at to the current ISO-8601 timestamp.

Required top-level shape (all fields mandatory, no extras at the top level):
{
  "version": 1,
  "dataset": { "shortDescription": "...", "columnRoles": [], "caveats": [], "keyHighlights": ["...", "..."], "whatYouCanAnalyze": ["...", "..."] },
  "userIntent": { "interpretedConstraints": [] },
  "sessionKnowledge": { "facts": [], "analysesDone": [] },
  "suggestedFollowUps": ["...", "..."],
  "lastUpdated": { "reason": "seed", "at": "<ISO-8601 timestamp>" }
}
${NESTED_FIELD_TYPES}

Audience for the welcome card is a manager / business owner — NOT a data engineer. Two of the dataset.* fields are written for that reader:

  dataset.keyHighlights — 3–5 short scope bullets (each ≤200 chars). They answer "what's actually in this data". Include, where you can ground them in DATA_SUMMARY:
    • the time span ("Apr 2023 → Mar 2024", "4 years of weekly data")
    • the breadth in business terms ("4 regions · 17 product categories", "23 brands across 6 markets")
    • a headline magnitude ONLY if obvious from a single primary metric ("$2.3M total sales across 9.8K orders"). Skip when ambiguous — silence beats a wrong number.
    Use business nouns. NEVER use the words "numeric", "categorical", "column", or "dimension" in this field.

  dataset.whatYouCanAnalyze — 3–4 themes (each ≤80 chars) phrased as actions a manager would actually want. Examples:
    • "Compare regional sales performance"
    • "Track shipping efficiency by mode"
    • "Profile high-value customer segments"
    Each theme must be answerable from the columns present. Avoid vague ones like "explore the data".

If the data genuinely doesn't support one of these (e.g. no date column → no time-span bullet), omit that bullet rather than fabricating one. Empty arrays are acceptable.`;

const MERGE_USER_SYSTEM = `You output only a JSON object matching the given schema (version 1).
You receive PREVIOUS_JSON and new USER_NOTES (verbatim). Merge USER_NOTES into userIntent and sessionKnowledge; refine interpretedConstraints and facts as appropriate.
Preserve dataset.* unless the user clearly corrects domain facts. Cap array lengths per schema.

DIMENSION HIERARCHIES — when the user declares that one value in a column is a "category", "total", "rollup", "parent", "all", or "overall" of the other values in the same column, record it as an entry in dataset.dimensionHierarchies with source="user". Examples that should produce a hierarchy entry:
  • "FEMALE SHOWER GEL is the entire category. Marico, Purite, Oliv, Lashe are products within it." → { "column": "Products", "rollupValue": "FEMALE SHOWER GEL", "itemValues": ["MARICO", "PURITE", "OLIV", "LASHE"], "source": "user", "description": "FEMALE SHOWER GEL is the category total." }
  • "ALL REGIONS in the Region column is the total — the others are individual regions." → { "column": "Region", "rollupValue": "ALL REGIONS", "source": "user" }
The "column" must match a real column name (use exact casing from PREVIOUS_JSON.dataset.columnRoles when possible). Carry forward any pre-existing hierarchies from PREVIOUS_JSON.dataset.dimensionHierarchies unless the user explicitly retracts them. itemValues is OPTIONAL — omit it if the user did not enumerate the children.

ML1 · multi-level same-column hierarchies are supported. When the user declares NESTED rollups in the same column (e.g. "World totals everything; Asia totals India + China + Japan; India totals Mumbai + Delhi"), emit ONE hierarchy entry per rollup level (3 entries here, all with column="Geography"). Each entry's itemValues should list the IMMEDIATE children of that rollup (not the leaf values).

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

/**
 * H5 · Cheap regex pre-check: does this user message look like it might
 * declare a dimension hierarchy ("X is the category", "X is a rollup",
 * "Y, Z are products within X", etc.)? Used to gate the user-merge LLM
 * call so routine analytical questions don't pay LLM cost.
 */
const HIERARCHY_HINT_RE =
  /\b(is\s+(?:the|a|an)\s+(?:entire\s+|whole\s+|overall\s+|total\s+|grand\s+|sub[- ]?)?(?:category|categor[iy]|rollup|roll[- ]?up|aggregate|sub[- ]?total|grand\s+total|category\s+total|parent|total|umbrella)|are\s+(?:the\s+)?(?:individual\s+|child\s+|sub[- ]?)?(?:products?|items?|brands?|skus?|categor[iy]|sub[- ]?categor[iy]|members?)\s+(?:within|under|in|of|inside)|rolls?\s+up|rolled\s+up|category\s+total|grand\s+total)\b/i;

export function shouldExtractUserHierarchies(userText: string | undefined): boolean {
  if (!userText) return false;
  return HIERARCHY_HINT_RE.test(userText);
}

/**
 * H5 · Run the user-merge LLM on a chat-turn user message and persist the
 * resulting SAC to Cosmos via the same per-session mutex as the assistant
 * merge. Returns the new SAC when it actually changed, or undefined when
 * no merge happened (regex didn't match, no doc, or merge result is
 * identical to the previous SAC).
 */
export async function extractAndPersistUserHierarchies(params: {
  sessionId: string;
  username: string;
  userMessage: string;
  previous: SessionAnalysisContext | undefined;
}): Promise<SessionAnalysisContext | undefined> {
  if (!shouldExtractUserHierarchies(params.userMessage)) return undefined;
  const merged = await mergeSessionAnalysisContextUserLLM({
    previous: params.previous,
    userText: params.userMessage,
  });
  const prevHashable = JSON.stringify(
    params.previous?.dataset?.dimensionHierarchies ?? []
  );
  const nextHashable = JSON.stringify(
    merged.dataset?.dimensionHierarchies ?? []
  );
  if (prevHashable === nextHashable) return undefined;

  const previousChain = sessionPersistChain.get(params.sessionId);
  const work = (async () => {
    if (previousChain) {
      try {
        await previousChain;
      } catch {
        /* prior call's failure isn't this caller's concern */
      }
    }
    const { getChatBySessionIdForUser, updateChatDocument } = await import(
      "../models/chat.model.js"
    );
    const doc = await getChatBySessionIdForUser(params.sessionId, params.username);
    if (!doc) return undefined;
    doc.sessionAnalysisContext = merged;
    await updateChatDocument(doc);
    return merged;
  })();
  sessionPersistChain.set(params.sessionId, work);
  try {
    return await work;
  } finally {
    if (sessionPersistChain.get(params.sessionId) === work) {
      sessionPersistChain.delete(params.sessionId);
    }
  }
}

/**
 * EU1 · Replace `dataset.dimensionHierarchies` for a session via the same
 * per-session mutex as the assistant merge. Used by the PUT endpoint that
 * powers the in-banner remove/edit UI. Schema validation is performed by
 * the caller (controller). Returns the new SAC, or undefined if the chat
 * doc is missing.
 */
export async function updateSessionDimensionHierarchies(params: {
  sessionId: string;
  username: string;
  hierarchies: SessionAnalysisContext["dataset"]["dimensionHierarchies"];
}): Promise<SessionAnalysisContext | undefined> {
  const previousChain = sessionPersistChain.get(params.sessionId);
  const work = (async () => {
    if (previousChain) {
      try {
        await previousChain;
      } catch {
        /* prior call's failure isn't this caller's concern */
      }
    }
    const { getChatBySessionIdForUser, updateChatDocument } = await import(
      "../models/chat.model.js"
    );
    const doc = await getChatBySessionIdForUser(params.sessionId, params.username);
    if (!doc) return undefined;
    const baseSAC = doc.sessionAnalysisContext ?? emptySessionAnalysisContext();
    const next: SessionAnalysisContext = {
      ...baseSAC,
      dataset: {
        ...baseSAC.dataset,
        dimensionHierarchies: params.hierarchies,
      },
      lastUpdated: { reason: "user_context", at: ISO() },
    };
    doc.sessionAnalysisContext = next;
    await updateChatDocument(doc);
    return next;
  })();
  sessionPersistChain.set(params.sessionId, work);
  try {
    return await work;
  } finally {
    if (sessionPersistChain.get(params.sessionId) === work) {
      sessionPersistChain.delete(params.sessionId);
    }
  }
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
 *
 * Audience: manager-level analysts. The body is intentionally framed in
 * business terms ("4 regions · 17 categories", "Compare regional sales
 * performance") rather than data-engineer terms ("Numeric: Sales", "mixed
 * date formats in Order Date"). Column-type breakdowns and parse-quality
 * caveats live elsewhere — they're not what a manager opens this for.
 *
 * Two render states:
 *   1. Heuristic-only (LLM seed not yet landed) — `keyHighlights` /
 *      `whatYouCanAnalyze` are absent on `ctx.dataset`, so we synthesise
 *      both via `buildDeterministicScopeFacts(summary)`. Non-blocking
 *      startup contract: this path must always have substance. Memory:
 *      `feedback_non_blocking_startup`.
 *   2. LLM-seeded — `seedSessionAnalysisContextLLM` populated the manager-
 *      framed bullets, so we render those verbatim.
 *
 * Suggested questions are rendered as clickable pills in the UI
 * (`MessageBubble.tsx`), so they're intentionally omitted from the body.
 */
export function buildInitialAssistantContentFromContext(
  summary: DataSummary,
  ctx: SessionAnalysisContext
): string {
  const lines: string[] = [];

  // ── Dataset overview ──────────────────────────────────────────────────────
  lines.push(`**${summary.rowCount.toLocaleString()} rows · ${summary.columnCount} columns**`);

  const desc = ctx.dataset.shortDescription?.trim();
  if (desc) lines.push("", desc);

  if (ctx.dataset.grainGuess) lines.push("", `**Row grain:** ${ctx.dataset.grainGuess}`);

  // ── What's in this data ──────────────────────────────────────────────────
  // LLM-seeded bullets win when present; otherwise fall back to deterministic
  // scope facts so the heuristic-only render still has substance.
  const fallback = buildDeterministicScopeFacts(summary);
  const highlights = (ctx.dataset.keyHighlights ?? []).filter((b) => b.trim());
  const renderedHighlights = highlights.length > 0 ? highlights : fallback.highlights;
  if (renderedHighlights.length > 0) {
    lines.push("", "**What's in this data:**");
    for (const h of renderedHighlights) lines.push(`• ${h}`);
  }

  // ── What you can analyze ─────────────────────────────────────────────────
  const themes = (ctx.dataset.whatYouCanAnalyze ?? []).filter((t) => t.trim());
  const renderedThemes = themes.length > 0 ? themes : fallback.analyzeThemes;
  if (renderedThemes.length > 0) {
    lines.push("", "**What you can analyze:**");
    for (const t of renderedThemes) lines.push(`• ${t}`);
  }

  return lines.join("\n");
}

/** After saving an assistant message: merge reply into rolling JSON and persist. */
/**
 * W40 · per-session in-process mutex keyed by sessionId. Concurrent
 * `persistMergeAssistantSessionContext` calls for the same session
 * (e.g. duplicated tab firing two turns at once) chain through this
 * promise so the read-modify-write of `sessionAnalysisContext` is
 * serialised within a single Node process. Without this serialisation,
 * the W21 `priorInvestigations` append on turn B silently overwrites
 * turn A's append because the upsert is last-write-wins.
 *
 * Single-instance correctness only — multi-instance horizontal scaling
 * would need Cosmos `ifMatch` ETag or an external lock. Per CLAUDE.md
 * the deploy is single-instance today; the in-process mutex is a
 * sufficient minimal fix.
 */
const sessionPersistChain = new Map<string, Promise<unknown>>();

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
  // W40 · serialise per session. Chain after any in-flight persist for
  // this sessionId before running the read-modify-write below. We drop
  // the chain entry on completion so the map doesn't grow unbounded.
  const previous = sessionPersistChain.get(params.sessionId);
  const work = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Prior call's failure is its own concern; this call still runs.
      }
    }
    return doPersist(params);
  })();
  sessionPersistChain.set(params.sessionId, work);
  try {
    return await work;
  } finally {
    // Only clear if our chain entry is still the latest — otherwise a
    // newer caller has already chained off `work` and we'd orphan it.
    if (sessionPersistChain.get(params.sessionId) === work) {
      sessionPersistChain.delete(params.sessionId);
    }
  }
}

async function doPersist(params: {
  sessionId: string;
  username: string;
  assistantMessage: string;
  agentTrace?: unknown;
  analysisBrief?: AnalysisBrief;
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
