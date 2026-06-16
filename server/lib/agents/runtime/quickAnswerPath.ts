/**
 * ============================================================================
 * quickAnswerPath.ts — the "fast lane" for simple lookup questions
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When a user asks a SIMPLE question (e.g. "which region had the highest
 *   sales last quarter?"), running the full plan/act agent loop is overkill —
 *   it would take 60-120 seconds and produce a wordy report. This file is the
 *   shortcut. It checks whether the question looks like a plain table lookup,
 *   asks a small/cheap LLM ("Mini-tier" planner) to draft ONE database query,
 *   runs that query, and returns the resulting table directly. Total time is
 *   roughly 2 seconds.
 *
 *   "Fast path" / "fast lane" = an optimisation that handles the easy cases
 *   quickly so the heavyweight machinery only runs when actually needed.
 *   "QueryPlanBody" = a structured (JSON) description of a database query
 *   (group by, aggregate, filter, sort) that the executor turns into real SQL.
 *
 * WHY IT MATTERS
 *   It makes the product feel snappy for the common, simple questions while the
 *   full agent loop stays reserved for genuinely analytical ones. Crucially, on
 *   ANY problem — the detector says "not simple", the planner returns nothing,
 *   the query fails validation, zero rows come back, or the executor errors —
 *   it returns `null` so the caller silently falls through to the full agent
 *   loop. It NEVER ships a half-baked or wrong answer just to be fast.
 *
 * KEY PIECES
 *   - tryQuickAnswer — the orchestrator. Runs a series of "gates" (feature
 *     flag, mode check, detector, has-data check), then plans → repairs →
 *     validates → executes → composes an AgentLoopResult. Returns null to bail.
 *   - formatQuickLookupIntentHint — builds a steering hint that is appended to
 *     a retry prompt when the first plan failed but the question clearly has an
 *     aggregation shape ("X per Y", "X per Y per Z").
 *
 * HOW IT CONNECTS
 *   Called once from the agent-loop entry point (`runAgentTurn` in
 *   agentLoop.service.ts) before the full pipeline. It reuses the same query
 *   executors as the full loop (queryPlanExecutor.js for in-memory,
 *   queryPlanDuckdbExecutor.js for DuckDB), the same planner-side repairs
 *   (planArgRepairs.js), and the Mini-tier planner in quickAnswerPlanner.js.
 *   Detection lives in quickAnswerDetector.js; follow-up chips in
 *   quickAnswerFollowUps.js.
 */

import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, AgentLoopResult, PlanStep } from "./types.js";

/**
 * Mirrors `AgentSseEmitter` from `agentLoop.service.ts`. Inlining the type
 * here breaks the circular import (the loop imports this module from its
 * entry; this module can't import the loop).
 */
type AgentSseEmitter = (event: string, data: unknown) => void;
import {
  detectQuickLookup,
  isQuickLookupEnabled,
} from "./quickAnswerDetector.js";
import { runQuickLookupPlanner } from "./quickAnswerPlanner.js";
import { buildQuickAnswerFollowUps } from "./quickAnswerFollowUps.js";
import { isDirectFactualQuestion } from "./isDirectFactualQuestion.js";
import { agentLog } from "./agentLogger.js";
import { errorMessage } from "../../../utils/errorMessage.js";
import {
  normalizeAndValidateQueryPlanBody,
  executeQueryPlan,
  type QueryPlanBody,
} from "../../queryPlanExecutor.js";
import {
  executeQueryPlanOnDuckDb,
  canExecuteQueryPlanOnDuckDb,
} from "../../queryPlanDuckdbExecutor.js";
import { getTurnColumnarStorage } from "./turnColumnarStorage.js";
import {
  injectRollupExcludeFilters,
  injectCompoundShapeMetricGuard,
  injectPeriodAdditivityGuard,
  extractDistinctMetricValues,
  detectPerXIntent,
  detectMultiPerIntent,
} from "./planArgRepairs.js";

const QUICK_LOOKUP_PREVIEW_CAP = 200;

export interface TryQuickAnswerInput {
  ctx: AgentExecutionContext;
  turnId: string;
  onLlmCall: () => void;
  safeEmit: AgentSseEmitter;
}

/**
 * Try the quick-lookup fast path. Returns a populated `AgentLoopResult` when
 * the path fired and the executor produced rows. Returns null otherwise —
 * the caller continues into the full pre-planner/planner/etc. pipeline.
 *
 * Side effects: emits `mode`, `thinking`, `plan`, `tool_call`, `tool_result`
 * SSE events on success so the workbench shows the same skeleton (1-2 rows)
 * the full path emits for an analytical step. No `answer_chunk`, no
 * `business_actions`, no `agent_workbench` enrichment.
 */
export async function tryQuickAnswer(
  input: TryQuickAnswerInput
): Promise<AgentLoopResult | null> {
  const { ctx, turnId, onLlmCall, safeEmit } = input;

  // Gate 1 — feature flag.
  if (!isQuickLookupEnabled()) return null;

  // Gate 2 — only the `analysis` mode is eligible. DataOps + modeling have
  // their own dispatch shape; the fast path would short-circuit a transform.
  if (ctx.mode !== "analysis") return null;

  // Gate 3 — detector regex/heuristic, OR the front-door router's explicit
  // lookup route (Wave R2). The router (tryDirectAnswer) understands phrasings
  // the regex misses ("give me a list of X", "what markets exist?") and sets
  // `ctx.routeToLookup` so the fast path still fires.
  if (!ctx.routeToLookup && !detectQuickLookup(ctx.question)) return null;

  // Gate 4 — there has to BE row data. An unmounted / empty session can't
  // answer a lookup question.
  if (!ctx.summary?.columns?.length) return null;

  agentLog("quick_lookup.candidate", {
    turnId,
    questionLen: ctx.question.length,
  });

  safeEmit("mode", { mode: "quick_lookup" });
  safeEmit("thinking", {
    step: "Quick lookup · drafting query",
    status: "active",
    timestamp: Date.now(),
  });

  // 1) Plan generation — single Mini-tier LLM call with one retry built in.
  //
  // When the first attempt returns null AND the question has a detectable
  // aggregation shape (multi-per or per-X), retry once with an explicit
  // steering hint appended to the user prompt. This closes the silent
  // fall-through where the Mini model misreads a multi-`per` shape, returns a
  // schema-invalid plan, and the user gets a slow full-loop with hypotheses
  // instead of a 2s table.
  const plannerStartedAt = Date.now();
  let plannerOut = await runQuickLookupPlanner(ctx, {
    turnId,
    onLlmCall,
  });
  let retriedWithHint = false;
  if (!plannerOut) {
    const perX = detectPerXIntent(ctx.question, ctx.summary);
    const multiPer = detectMultiPerIntent(ctx.question, ctx.summary);
    const intentHint = formatQuickLookupIntentHint(perX, multiPer);
    if (intentHint) {
      retriedWithHint = true;
      agentLog("quick_lookup.retry_with_intent", { turnId, hintLen: intentHint.length });
      plannerOut = await runQuickLookupPlanner(ctx, {
        turnId,
        onLlmCall,
        intentHint,
      });
    }
  }
  if (!plannerOut) {
    safeEmit("thinking", {
      step: "Quick lookup · drafting query",
      status: "completed",
      timestamp: Date.now(),
      details: "fell through to full loop",
    });
    agentLog("quick_lookup.planner_null", { turnId, retriedWithHint });
    safeEmit("quick_lookup_fallback", {
      reason: "planner_null",
      retriedWithHint,
      turnId,
    });
    return null;
  }

  // 2) Deterministic planner-side repairs (rollup-exclude, compound metric
  // guard). These mirror the full-loop planner repairs so wide-format and
  // dimension-hierarchy invariants are honoured even when the LLM produces a
  // naïve plan.
  const stubStep: PlanStep = {
    id: "ql_s1",
    tool: "execute_query_plan",
    args: { plan: plannerOut.plan },
  };
  try {
    injectRollupExcludeFilters(
      stubStep,
      ctx.sessionAnalysisContext?.dataset?.dimensionHierarchies,
      ctx.question
    );
    const wf = ctx.summary.wideFormatTransform;
    if (wf?.detected && wf.shape === "compound" && wf.metricColumn) {
      const metricCol = ctx.summary.columns.find(
        (c) => c.name === wf.metricColumn
      );
      const distinctMetrics =
        metricCol?.topValues
          ?.map((t) => String(t.value))
          .filter((v) => v.trim().length > 0) ??
        extractDistinctMetricValues(ctx.data, wf.metricColumn);
      injectCompoundShapeMetricGuard(
        stubStep,
        wf,
        ctx.question,
        distinctMetrics
      );
    }
    // Period-additivity guard on the quick-answer fast path — the quick-lookup
    // shape ("highest sales in the latest 12 months") would otherwise bypass
    // the planner backstop and SUM across overlapping periods (double-counting).
    if (wf?.detected && wf.shape === "pure_period") {
      const isoInfo = ctx.summary.columns.find((c) => c.name === wf.periodIsoColumn);
      const kindInfo = ctx.summary.columns.find((c) => c.name === wf.periodKindColumn);
      const isoVals =
        (isoInfo?.topValues ?? []).map((t) => String(t.value).trim()).filter(Boolean) ||
        [];
      const kindVals =
        (kindInfo?.topValues ?? []).map((t) => String(t.value).trim()).filter(Boolean) ||
        [];
      const pg = injectPeriodAdditivityGuard(
        stubStep,
        wf,
        ctx.question,
        isoVals.length ? isoVals : extractDistinctMetricValues(ctx.data, wf.periodIsoColumn),
        kindVals.length ? kindVals : extractDistinctMetricValues(ctx.data, wf.periodKindColumn)
      );
      if (pg.injectedFilter && pg.caveat) {
        (ctx.deterministicCaveats ??= []).push(pg.caveat);
      }
    }
  } catch (err) {
    // Repairs are best-effort. A throw here is unexpected; log and continue
    // with the raw plan rather than poisoning the fast path.
    agentLog("quick_lookup.repair_threw", {
      turnId,
      error: errorMessage(err),
    });
  }
  const repairedPlan = (stubStep.args as { plan: QueryPlanBody }).plan;

  // 3) Schema-level validation: column-allowlist + structural minima.
  const validation = normalizeAndValidateQueryPlanBody(
    ctx.summary,
    repairedPlan
  );
  if (!validation.ok) {
    safeEmit("thinking", {
      step: "Quick lookup · drafting query",
      status: "completed",
      timestamp: Date.now(),
      details: "plan rejected, falling back",
    });
    agentLog("quick_lookup.plan_invalid", {
      turnId,
      error: validation.error.slice(0, 200),
    });
    safeEmit("quick_lookup_fallback", {
      reason: "plan_invalid",
      turnId,
      error: validation.error.slice(0, 200),
    });
    return null;
  }
  const normalizedPlan = validation.normalizedPlan;
  const planLatencyMs = Date.now() - plannerStartedAt;

  safeEmit("thinking", {
    step: "Quick lookup · drafting query",
    status: "completed",
    timestamp: Date.now(),
    details: plannerOut.questionRestated,
  });

  // 4) Emit a one-step plan so the workbench renders cleanly (matches the
  // shape the full loop emits for a single execute_query_plan step).
  safeEmit("plan", {
    rationale: plannerOut.questionRestated,
    steps: [
      {
        id: "ql_s1",
        tool: "execute_query_plan",
        args: { plan: normalizedPlan },
      },
    ],
  });

  // 5) Execute. DuckDB when available; in-memory otherwise (matches the
  // execute_query_plan tool's branching).
  safeEmit("thinking", {
    step: "Quick lookup · running query",
    status: "active",
    timestamp: Date.now(),
  });
  const toolCallId = `ql_tc_${randomUUID().slice(0, 8)}`;
  const toolCallStartedAt = Date.now();
  safeEmit("tool_call", {
    // SSE tool_call schema requires `name` (sseEvents.ts) — emit it (mirrors the
    // main agent loop's `safeEmit("tool_call", { id, name: step.tool, ... })`).
    // Previously this sent `tool:` only, failing schema validation and rendering
    // the workbench entry as "Tool: tool".
    id: toolCallId,
    name: "execute_query_plan",
    tool: "execute_query_plan",
    args_summary: JSON.stringify(normalizedPlan).slice(0, 300),
    args: { plan: normalizedPlan },
  });

  let rows: Record<string, unknown>[] = [];
  let inputRowCount = 0;
  let execOk = false;
  let execError: string | undefined;

  const tryDuck =
    Boolean(ctx.columnarStoragePath) &&
    Boolean(ctx.sessionId) &&
    canExecuteQueryPlanOnDuckDb(normalizedPlan);

  if (tryDuck) {
    // PERF-10 · Reuse the per-turn shared DuckDB handle (closed by the agent
    // loop's fast-path teardown when this path returns).
    const { storage: sharedStorage } = await getTurnColumnarStorage(ctx);
    const duck = await executeQueryPlanOnDuckDb(
      ctx.sessionId,
      normalizedPlan,
      ctx.summary,
      ctx.chatDocument,
      ctx.abortSignal,
      sharedStorage
    );
    if (duck.ok) {
      rows = duck.rows;
      inputRowCount = duck.inputRowCount;
      execOk = true;
    } else {
      execError = duck.error;
    }
  }
  // This fast path is an optimization layer; the in-memory fallback gives the
  // user a 2-second answer instead of falling through to the slow full loop.
  // The "DuckDB always for aggregations" architectural contract is enforced at
  // the FULL-LOOP `execute_query_plan` tool seam (hard-fail in
  // registerTools.ts) — that's where the slow path would otherwise silently
  // grind through Cosmos-loaded rows. The fast path stays permissive so users
  // with short questions still get fast results.
  if (!execOk) {
    const mem = executeQueryPlan(ctx.data, ctx.summary, normalizedPlan);
    if (mem.ok) {
      rows = mem.data;
      inputRowCount = ctx.data.length;
      execOk = true;
    } else {
      execError = mem.error;
    }
  }

  const toolCallEndedAt = Date.now();

  if (!execOk) {
    safeEmit("tool_result", {
      id: toolCallId,
      ok: false,
      summary: execError ?? "executor failed",
    });
    safeEmit("thinking", {
      step: "Quick lookup · running query",
      status: "completed",
      timestamp: Date.now(),
      details: "executor failed, falling back",
    });
    agentLog("quick_lookup.exec_failed", {
      turnId,
      error: (execError ?? "").slice(0, 200),
    });
    safeEmit("quick_lookup_fallback", {
      reason: "exec_failed",
      turnId,
      error: (execError ?? "").slice(0, 200),
    });
    return null;
  }

  // 6) Zero rows → fall through. Often means the planner mini misread the
  // schema; the full loop can investigate and possibly clarify.
  if (rows.length === 0) {
    safeEmit("tool_result", {
      id: toolCallId,
      ok: true,
      summary: "0 rows returned",
    });
    safeEmit("thinking", {
      step: "Quick lookup · running query",
      status: "completed",
      timestamp: Date.now(),
      details: "no rows, falling back",
    });
    // High-signal diagnostic: zero rows on an aggregation-shape question almost
    // always means the planner bound the wrong column or wrong filter. Surfaces
    // in agent logs to inform tuning.
    const hasAggIntent =
      detectPerXIntent(ctx.question, ctx.summary) !== null ||
      detectMultiPerIntent(ctx.question, ctx.summary) !== null;
    agentLog(
      hasAggIntent ? "quick_lookup.zero_rows_with_intent" : "quick_lookup.zero_rows",
      { turnId }
    );
    safeEmit("quick_lookup_fallback", {
      reason: "zero_rows",
      turnId,
      hasAggIntent,
    });
    return null;
  }

  safeEmit("tool_result", {
    id: toolCallId,
    ok: true,
    summary: `${rows.length} row${rows.length === 1 ? "" : "s"}`,
  });
  safeEmit("thinking", {
    step: "Quick lookup · running query",
    status: "completed",
    timestamp: Date.now(),
    details: `${rows.length} row${rows.length === 1 ? "" : "s"}`,
  });

  // 7) Deterministic follow-up chips. Depth gate (query-intent authority): a
  // DIRECT factual ask ("what is the average X per Y?") gets NO "investigate
  // further" chips — the user asked for the number, not next steps (the explicit
  // "direct question → no further investigation" rule). Exploratory lookups
  // ("top 10 X by Y") keep navigational chips.
  const followUps = isDirectFactualQuestion(ctx.question)
    ? undefined
    : buildQuickAnswerFollowUps({
        plan: normalizedPlan,
        rows,
        dataSummary: ctx.summary,
      });

  // 8) Cap preview rows (mirrors the loop's tool-result preview cap).
  const previewRows =
    rows.length > QUICK_LOOKUP_PREVIEW_CAP
      ? rows.slice(0, QUICK_LOOKUP_PREVIEW_CAP)
      : rows;

  const turnStartedAt = plannerStartedAt;
  const turnEndedAt = Date.now();

  agentLog("quick_lookup.success", {
    turnId,
    planLatencyMs,
    execLatencyMs: toolCallEndedAt - toolCallStartedAt,
    totalLatencyMs: turnEndedAt - turnStartedAt,
    rowCount: rows.length,
    inputRowCount,
  });

  // 9) Compose `AgentLoopResult`. Empty answer body — the preview table IS
  // the answer; no narrator preamble. agentTrace carries the single
  // execute_query_plan step so `derivePivotDefaultsFromExecution` in
  // chatStream picks up the right pivot shape automatically.
  const result: AgentLoopResult = {
    answer: "",
    table: previewRows,
    agentTrace: {
      turnId,
      startedAt: turnStartedAt,
      endedAt: turnEndedAt,
      steps: [
        {
          id: "ql_s1",
          tool: "execute_query_plan",
          args: { plan: normalizedPlan },
        },
      ],
      toolCalls: [
        {
          id: toolCallId,
          name: "execute_query_plan",
          argsSummary: JSON.stringify(normalizedPlan).slice(0, 300),
          ok: true,
          startedAt: toolCallStartedAt,
          endedAt: toolCallEndedAt,
          resultSummary: `${rows.length} rows`,
        },
      ],
      criticRounds: [],
      reflectorNotes: [],
      parseFailures: 0,
      planRationale: plannerOut.questionRestated,
    },
    followUpPrompts: followUps,
    lastAnalyticalRowsForEnrichment: previewRows,
  };

  return result;
}

/**
 * Build a steering hint for the retry attempt when the Mini-tier planner failed
 * and the question carries a detectable aggregation shape. Returns null when
 * neither a multi-per nor a per-X intent was detected — no point retrying the
 * planner with a generic nudge.
 *
 * The hint goes into the USER message (not system) so the system-prompt cache
 * stays warm across the initial + retry pair.
 */
export function formatQuickLookupIntentHint(
  perX: ReturnType<typeof detectPerXIntent>,
  multiPer: ReturnType<typeof detectMultiPerIntent>
): string | null {
  if (multiPer) {
    return `The question is a multi-per shape ("<agg> X per Y per Z" / "<agg> X per Y across Z"). Y is the RATE DENOMINATOR (use perDimension + innerOperation: "sum"); Z is the ANSWER DIMENSION (use groupBy). Recommended plan shape: { groupBy: [${multiPer.groupColumns
      .map((c) => `"${c}"`)
      .join(", ")}], aggregations: [{ column: "<metric>", operation: "${
      multiPer.outerOp
    }", perDimension: "${multiPer.rateDenominator.column}", innerOperation: "sum" }] }`;
  }
  if (perX) {
    return `The question is a rate intent ("<agg> X per Y"). Y is the RATE DENOMINATOR — emit aggregations with perDimension="${perX.perDimension}" + innerOperation="sum" + operation="${perX.outerOp}".`;
  }
  return null;
}
