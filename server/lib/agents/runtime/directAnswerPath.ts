/**
 * ============================================================================
 * directAnswerPath.ts — the LLM-driven "front door" / request router
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Before the heavyweight plan/act agent loop runs, this asks ONE small LLM
 *   call to TRIAGE the question: can it be answered RIGHT NOW with no tools, or
 *   does it genuinely need to query the dataset / run analysis? Many questions
 *   never needed the analytical machinery at all:
 *     - conversational ("hi", "thanks", "what can you do?")
 *     - general knowledge / definitions ("what is price elasticity?")
 *     - schema-metadata answerable straight from the dataset summary
 *       ("what columns are here?", "how many rows?", "what date range?")
 *   For those, the router returns the answer directly (strategy "direct"). For
 *   anything that needs real data or external research it returns "escalate"
 *   (→ null), and the caller falls through to the existing fast-lookup path and
 *   then the full agentic loop — completely unchanged.
 *
 *   This replaces brittle keyword/regex gating with LLM understanding: the
 *   model decides where each question should go. It is deliberately fail-safe —
 *   on ANY uncertainty, empty answer, schema-invalid output, or thrown error it
 *   returns null so the request is handled by the normal pipeline. It can only
 *   ever make easy questions faster; it never ships a wrong answer to be fast.
 *
 * WHY IT MATTERS
 *   Today a greeting runs the entire hypothesis → brief → planner → act →
 *   narrator → verifier loop (slow, costly, occasionally weird). Routing those
 *   to a single LLM call is faster and cleaner, and finally wires the
 *   previously-dead `LLM_PURPOSE.CONVERSATIONAL` constant.
 *
 * KEY PIECES
 *   - tryDirectAnswer — the orchestrator. Gates (flag, mode, has-data), builds a
 *     compact schema + chat-history prompt, makes one CONVERSATIONAL call, and
 *     either returns a text-only AgentLoopResult or null.
 *   - isDirectAnswerEnabled — env-flag gate (DIRECT_ANSWER_ENABLED).
 *
 * HOW IT CONNECTS
 *   Called once from `runAgentTurn` (agentLoop.service.ts), ABOVE the
 *   quick-lookup fast path, so the order is: direct → quick-lookup → full loop.
 *   Uses `completeJson` from ./llmJson.js for the single LLM call. The returned
 *   AgentLoopResult carries only `answer` (+ a minimal agentTrace and optional
 *   follow-up chips); a text-only result flows through dataAnalyzer +
 *   chatResponse validation cleanly. The trace's `planRationale: "direct_answer"`
 *   marker lets chatStream skip writing the answer to the semantic question
 *   cache (a conversational reply must never be replayed for a later question).
 */

import { z } from "zod";
import type { AgentExecutionContext, AgentLoopResult } from "./types.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { agentLog } from "./agentLogger.js";
import type { DataSummary } from "../../../shared/schema.js";

/**
 * Mirrors `AgentSseEmitter` from `agentLoop.service.ts`. Inlined to break the
 * circular import (the loop imports this module from its entry point).
 */
type AgentSseEmitter = (event: string, data: unknown) => void;

export interface TryDirectAnswerInput {
  ctx: AgentExecutionContext;
  turnId: string;
  onLlmCall: () => void;
  safeEmit: AgentSseEmitter;
}

/** Feature flag. Default OFF in code; enabled per-deployment via env. */
export function isDirectAnswerEnabled(): boolean {
  return process.env.DIRECT_ANSWER_ENABLED === "true";
}

const MAX_COLUMNS_IN_PROMPT = 60;
const MAX_TOP_VALUES_PER_COLUMN = 8;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS_PER_TURN = 300;

/**
 * Router output. Three strategies:
 *   - "direct"   → answer now, no tools (answer required, non-empty).
 *   - "lookup"   → a single simple data query (list distinct / top-N / count /
 *                  sum / avg / latest); routed to the quick-lookup fast path.
 *   - "escalate" → needs full analysis or external research → the full loop.
 */
const directAnswerSchema = z.object({
  strategy: z.enum(["direct", "lookup", "escalate"]),
  answer: z.string().max(6000).optional(),
  followUps: z.array(z.string().min(1).max(160)).max(3).optional(),
});

type DirectAnswerOut = z.infer<typeof directAnswerSchema>;

/**
 * Byte-stable system prompt (prompt-cache friendly — lives entirely in the
 * `system` slot). Encodes the triage policy: answer directly ONLY when no
 * dataset query is needed; otherwise escalate. Bias to escalate on doubt.
 */
const DIRECT_ANSWER_SYSTEM_PROMPT = `You are the FRONT-DOOR router for an analytical data-chat assistant. The user is chatting about an uploaded tabular dataset. For EACH message you pick ONE of three strategies and return JSON.

Return shape: { "strategy": "direct" | "lookup" | "escalate", "answer"?: string, "followUps"?: string[] }

Choose "direct" — and write the full answer in "answer" — ONLY when you can fully and correctly answer WITHOUT querying the dataset's rows or any external source. That means:
- Conversational: greetings, thanks, small talk, "what can you do?", questions about this assistant/tool.
- General knowledge / definitions / how-to: "what is price elasticity?", "explain correlation vs causation", "how should I read a heatmap?".
- Dataset METADATA answerable from the SCHEMA block alone: which columns exist, how many rows/columns, a column's data type, the date range / time period the data spans. The SCHEMA block below is exact for these facts.

Choose "lookup" — and OMIT "answer" — for a SIMPLE single-query data retrieval that needs the actual rows but no analysis or interpretation. The system will run one database query for you. This is the right choice (regardless of phrasing) for:
- Listing the DISTINCT VALUES of a dimension: "list all products", "give me a list of markets", "what regions exist?", "which periods are covered?". (The SCHEMA shows only a few EXAMPLE values, never the full set — so these need a query, not a direct answer.)
- Plain top-N / bottom-N, counts, sums, averages, min/max, or "latest/most recent N rows".

Choose "escalate" — and OMIT "answer" — for anything that needs analysis, multiple steps, or outside information:
- "Why" / drivers / causes, correlation, trends over time, comparisons, segmentation, ranking-with-explanation, charts, dashboards, or modeling.
- Anything needing external/world knowledge, news, competitor research, or live lookups.
- Data transformations (add/remove/rename columns, filter rows, pivot).

Rules:
- When unsure between "lookup" and "escalate", pick "escalate". When unsure whether you can answer without data, pick "lookup" or "escalate" — never guess dataset values in a "direct" answer.
- For "direct" answers: be helpful, concise, accurate, plain markdown. Ground every metadata fact in the SCHEMA block; never invent values or figures.
- "followUps": optionally 1–3 short suggested next questions (each ≤ 160 chars). Omit if none are natural. (Used only with "direct".)
- Output JSON only. No prose outside the JSON object.`;

/**
 * Compact schema snapshot for the prompt. Mirrors quickAnswerPlanner's
 * buildSchemaChips but additionally surfaces the dataset shape (row/column
 * counts) and per-column date ranges so schema-metadata questions ("what time
 * period does the data cover?") can be answered directly and exactly.
 */
function buildSchemaBlock(summary: DataSummary): string {
  const numericSet = new Set(summary.numericColumns ?? []);
  const dateSet = new Set(summary.dateColumns ?? []);
  const cols = (summary.columns ?? []).slice(0, MAX_COLUMNS_IN_PROMPT);
  const lines: string[] = [
    `rows: ${summary.rowCount}, columns: ${summary.columnCount}`,
  ];
  if (summary.numericColumns?.length) {
    lines.push(`numeric columns: ${summary.numericColumns.join(", ")}`);
  }
  if (summary.dateColumns?.length) {
    lines.push(`date columns: ${summary.dateColumns.join(", ")}`);
  }
  lines.push("columns (name · type · details):");
  for (const c of cols) {
    const role = numericSet.has(c.name)
      ? "numeric"
      : dateSet.has(c.name)
        ? "date"
        : "dimension";
    let detail = "";
    if (c.dateRange) {
      detail = ` · range: ${c.dateRange.minIso}..${c.dateRange.maxIso} (${c.dateRange.distinctDayCount} distinct days, span ${c.dateRange.spanDays}d)`;
    } else if (
      role === "dimension" &&
      Array.isArray(c.topValues) &&
      c.topValues.length > 0
    ) {
      const vals = c.topValues
        .slice(0, MAX_TOP_VALUES_PER_COLUMN)
        .map((tv) => String(tv.value).slice(0, 40))
        .join(" | ");
      detail = ` · example values (not exhaustive): ${vals}`;
    }
    lines.push(`  - ${c.name} (${role})${detail}`);
  }
  if ((summary.columns?.length ?? 0) > MAX_COLUMNS_IN_PROMPT) {
    lines.push(
      `  ... (${(summary.columns?.length ?? 0) - MAX_COLUMNS_IN_PROMPT} more columns omitted)`
    );
  }
  return lines.join("\n");
}

/** Recent chat history, newest-last, each turn trimmed. Empty string if none. */
function buildHistoryBlock(ctx: AgentExecutionContext): string {
  const history = ctx.chatHistory ?? [];
  if (history.length === 0) return "";
  const recent = history.slice(-MAX_HISTORY_TURNS);
  const lines = recent.map((m) => {
    const content = (m.content ?? "").slice(0, MAX_HISTORY_CHARS_PER_TURN);
    return `${m.role}: ${content}`;
  });
  return lines.join("\n");
}

function buildUserPrompt(ctx: AgentExecutionContext): string {
  const schemaBlock = buildSchemaBlock(ctx.summary);
  const historyBlock = buildHistoryBlock(ctx);
  return `SCHEMA:
${schemaBlock}
${historyBlock ? `\nRECENT CONVERSATION (oldest→newest):\n${historyBlock}\n` : ""}
USER MESSAGE:
${ctx.question}

Decide the strategy and return JSON.`;
}

/**
 * Try the direct-answer front door. Returns a populated text-only
 * `AgentLoopResult` when the question was answered directly; returns null on
 * "escalate", empty/invalid output, a disabled flag, the wrong mode, missing
 * data, or any thrown error — in which case the caller continues into the
 * quick-lookup path and then the full agent loop. NEVER throws.
 */
export async function tryDirectAnswer(
  input: TryDirectAnswerInput
): Promise<AgentLoopResult | null> {
  const { ctx, turnId, onLlmCall, safeEmit } = input;

  // Gate 1 — feature flag.
  if (!isDirectAnswerEnabled()) return null;
  // Gate 2 — only `analysis` mode is eligible (dataOps / modeling have their
  // own dispatch shape; routing them would short-circuit a transform).
  if (ctx.mode !== "analysis") return null;
  // Gate 3 — there must be a dataset summary to ground metadata answers and to
  // let the router reason about what would need a query.
  if (!ctx.summary?.columns?.length) return null;

  const startedAt = Date.now();
  agentLog("direct_answer.candidate", {
    turnId,
    questionLen: ctx.question.length,
  });
  safeEmit("thinking", {
    step: "Triage · considering a direct answer",
    status: "active",
    timestamp: startedAt,
  });

  let out: DirectAnswerOut | null = null;
  try {
    const res = await completeJson(
      DIRECT_ANSWER_SYSTEM_PROMPT,
      buildUserPrompt(ctx),
      directAnswerSchema,
      {
        purpose: LLM_PURPOSE.CONVERSATIONAL,
        turnId,
        onLlmCall,
        maxTokens: 900,
        temperature: 0.2,
      }
    );
    if (res.ok) out = res.data;
    else {
      agentLog("direct_answer.llm_failed", {
        turnId,
        kind: res.kind,
        err: res.error.slice(0, 200),
      });
    }
  } catch (err) {
    agentLog("direct_answer.threw", {
      turnId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const fallThrough = (reason: string): null => {
    safeEmit("thinking", {
      step: "Triage · considering a direct answer",
      status: "completed",
      timestamp: Date.now(),
      details: "needs analysis — using the full pipeline",
    });
    safeEmit("direct_answer_fallback", { reason, turnId });
    return null;
  };

  if (!out) return fallThrough("llm_failed");

  // "lookup" → hand off to the quick-lookup fast path: flag the context so its
  // detector gate fires regardless of phrasing, then return null (no fallback
  // event — we are NOT escalating to the full loop, the quick path runs next).
  if (out.strategy === "lookup") {
    ctx.routeToLookup = true;
    safeEmit("thinking", {
      step: "Triage · considering a direct answer",
      status: "completed",
      timestamp: Date.now(),
      details: "routing to a quick data lookup",
    });
    agentLog("direct_answer.route_lookup", { turnId });
    return null;
  }

  if (out.strategy !== "direct") return fallThrough("escalate");
  const answer = (out.answer ?? "").trim();
  if (!answer) return fallThrough("empty_answer");

  safeEmit("mode", { mode: "direct_answer" });
  safeEmit("thinking", {
    step: "Triage · considering a direct answer",
    status: "completed",
    timestamp: Date.now(),
    details: "answered directly",
  });
  agentLog("direct_answer.success", {
    turnId,
    latencyMs: Date.now() - startedAt,
    answerLen: answer.length,
  });

  const result: AgentLoopResult = {
    answer,
    agentTrace: {
      turnId,
      startedAt,
      endedAt: Date.now(),
      // `planRationale: "direct_answer"` is the marker chatStream reads to skip
      // the semantic question-cache write (see maybeWritePastAnalysisDoc).
      planRationale: "direct_answer",
      steps: [],
      toolCalls: [],
      criticRounds: [],
      reflectorNotes: [],
      parseFailures: 0,
    },
    ...(out.followUps?.length
      ? { followUpPrompts: out.followUps.slice(0, 3) }
      : {}),
  };
  return result;
}
