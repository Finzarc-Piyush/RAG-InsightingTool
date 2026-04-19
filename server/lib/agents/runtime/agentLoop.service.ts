import { randomUUID } from "crypto";
import { z } from "zod";
import type {
  AgentConfig,
  AgentExecutionContext,
  AgentLoopResult,
  AgentMidTurnSessionPayload,
  AgentTrace,
  ToolCallRecord,
  WorkingMemoryEntry,
} from "./types.js";
import { AGENT_TRACE_MAX_BYTES } from "./types.js";
import { ToolRegistry, type ToolResult } from "./toolRegistry.js";
import { registerDefaultTools } from "./tools/registerTools.js";
import { runPlanner, type PlannerRejectReason } from "./planner.js";
import { formatWorkingMemoryBlock } from "./workingMemory.js";
import { runReflector } from "./reflector.js";
import { runVerifier, rewriteNarrative } from "./verifier.js";
import { agentLog } from "./agentLogger.js";
import { openai, MODEL } from "../../openai.js";
import { getInsightModel, getInsightTemperatureConservative } from "../../insightSynthesis/insightModelConfig.js";
import { completeJson } from "./llmJson.js";
import { proposeAndBuildExtraCharts } from "./visualPlanner.js";
import { chartSpecSchema, type ChartSpec, type Insight } from "../../../shared/schema.js";
import { lintAfterAnalyticalTool } from "../../agentToolObservationLint.js";
import { registerDerivedColumnOnSummary } from "../../deriveDimensionBucket.js";
import {
  addComputedColumnsArgsSchema,
  registerComputedColumnsOnSummary,
} from "../../computedColumns.js";
import {
  validateChartProposal,
  chartRowsForProposal,
} from "./chartProposalValidation.js";
import { processChartData } from "../../chartGenerator.js";
import { buildIntermediateInsight } from "./buildIntermediateInsight.js";
import { derivePivotDefaultsFromPreviewRows } from "../../pivotDefaultsFromPreview.js";

const INTERMEDIATE_TABLE_TOOLS = new Set([
  "run_analytical_query",
  "execute_query_plan",
  "run_readonly_sql",
  "derive_dimension_bucket",
  "add_computed_columns",
  "run_segment_driver_analysis",
]);

function toolTableRowsForIntermediate(tr: ToolResult): Record<string, unknown>[] {
  const t = tr.table;
  if (!t) return [];
  if (Array.isArray(t)) return t as Record<string, unknown>[];
  if (typeof t === "object" && t !== null && Array.isArray((t as { rows?: unknown }).rows)) {
    return (t as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

function toolTableColumnOrderForIntermediate(tr: ToolResult): string[] | null {
  const t = tr.table;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const cols = (t as { columns?: unknown }).columns;
  if (!Array.isArray(cols)) return null;
  const out = cols.filter((v): v is string => typeof v === "string");
  return out.length ? out : null;
}
import {
  calculateSmartDomainsForChart,
  multiSeriesYDomainKind,
  yDomainForMultiSeriesRows,
} from "../../axisScaling.js";

export type AgentSseEmitter = (event: string, data: unknown) => void;

function lastAnalyticalRowsSnapshot(
  ctx: AgentExecutionContext
): Record<string, unknown>[] | undefined {
  const rows = ctx.lastAnalyticalTable?.rows;
  return rows?.length ? rows : undefined;
}

function rowKeysFromFirstRow(rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return [];
  return Object.keys(rows[0] as object);
}

/** Shape needed to rebuild a plan-time build_chart after synthesis (same frame as narrative). */
type DeferredBuildChartTemplate = Pick<ChartSpec, "type" | "title" | "x" | "y" | "aggregate"> & {
  y2?: string;
  y2Series?: string[];
  z?: string;
  seriesColumn?: string;
  barLayout?: "stacked" | "grouped";
};

function deferredTemplateFromBuiltChart(c: ChartSpec): DeferredBuildChartTemplate {
  return {
    type: c.type,
    title: c.title,
    x: c.x,
    y: c.y,
    ...(c.y2 ? { y2: c.y2 } : {}),
    ...(c.y2Series?.length ? { y2Series: [...c.y2Series] } : {}),
    ...(c.z ? { z: c.z } : {}),
    ...(c.seriesColumn ? { seriesColumn: c.seriesColumn } : {}),
    ...(c.barLayout ? { barLayout: c.barLayout } : {}),
    ...(c.aggregate != null ? { aggregate: c.aggregate } : {}),
  };
}

function rowFrameSupportsDeferredTemplate(
  first: Record<string, unknown> | undefined,
  t: DeferredBuildChartTemplate
): boolean {
  if (!first) return false;
  const keys = [
    t.x,
    t.y,
    ...(t.y2 ? [t.y2] : []),
    ...(t.y2Series ?? []),
    ...(t.z ? [t.z] : []),
    ...(t.seriesColumn ? [t.seriesColumn] : []),
  ];
  return keys.every((k) => Object.prototype.hasOwnProperty.call(first, k));
}

/**
 * Plan-time build_chart specs are deferred until after synthesis so series are built from the
 * same analytical frame the answer used (last execute_query_plan / ctx.data), not mid-plan snapshots.
 */
function materializeDeferredBuildCharts(
  ctx: AgentExecutionContext,
  deferred: DeferredBuildChartTemplate[],
  mergedCharts: ChartSpec[]
): void {
  if (!deferred.length) return;
  for (const tmpl of deferred) {
    try {
      const p = {
        type: tmpl.type,
        x: tmpl.x,
        y: tmpl.y,
        ...(tmpl.z ? { z: tmpl.z } : {}),
        ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
        ...(tmpl.barLayout ? { barLayout: tmpl.barLayout } : {}),
      };
      if (!validateChartProposal(ctx, p)) continue;
      const { rows, useAnalyticalOnly } = chartRowsForProposal(ctx, p);
      const first = rows[0] as Record<string, unknown> | undefined;
      if (!rowFrameSupportsDeferredTemplate(first, tmpl)) continue;
      const spec = chartSpecSchema.parse({
        type: tmpl.type,
        title: tmpl.title,
        x: tmpl.x,
        y: tmpl.y,
        ...(tmpl.z ? { z: tmpl.z } : {}),
        ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
        ...(tmpl.barLayout ? { barLayout: tmpl.barLayout } : {}),
        ...(tmpl.y2 ? { y2: tmpl.y2 } : {}),
        ...(tmpl.y2Series?.length ? { y2Series: tmpl.y2Series } : {}),
        aggregate: tmpl.aggregate ?? "none",
        ...(useAnalyticalOnly ? { _useAnalyticalDataOnly: true as const } : {}),
      });
      const processed = processChartData(
        rows as Record<string, any>[],
        spec,
        ctx.summary.dateColumns,
        { chartQuestion: ctx.question }
      );
      let smartDomains: Record<string, unknown> = {};
      if (spec.type === "heatmap") {
        smartDomains = {};
      } else if (spec.seriesKeys?.length) {
        const sk = spec.seriesKeys;
        smartDomains = yDomainForMultiSeriesRows(
          processed,
          sk,
          multiSeriesYDomainKind(spec.type, spec.barLayout)
        );
      } else {
        smartDomains = calculateSmartDomainsForChart(
          processed,
          spec.x,
          spec.y,
          spec.y2 || undefined,
          {
            yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
            y2Options: spec.y2 ? { useIQR: true, paddingPercent: 5, includeOutliers: true } : undefined,
          }
        );
      }
      mergedCharts.push({
        ...spec,
        xLabel: spec.x,
        yLabel: spec.y,
        data: processed,
        ...smartDomains,
      });
    } catch {
      /* skip invalid */
    }
  }
  deferred.length = 0;
}

function capAgentTrace(trace: AgentTrace): AgentTrace {
  const clone: AgentTrace = {
    ...trace,
    toolCalls: trace.toolCalls.map((t) => ({
      ...t,
      resultSummary: t.resultSummary
        ? t.resultSummary.slice(0, 500)
        : undefined,
    })),
    criticRounds: trace.criticRounds.slice(-20),
  };
  let encoded = JSON.stringify(clone);
  if (encoded.length <= AGENT_TRACE_MAX_BYTES) {
    return clone;
  }
  return {
    ...clone,
    toolCalls: clone.toolCalls.map((t) => ({
      ...t,
      resultSummary: t.resultSummary?.slice(0, 120),
    })),
    budgetHits: [...(clone.budgetHits || []), "trace_byte_cap"],
  };
}

const finalAnswerEnvelopeSchema = z.object({
  body: z.string(),
  keyInsight: z.string().nullable().optional(),
  ctas: z.array(z.string()).max(3),
});

function lastVerdictForStep(trace: AgentTrace, stepId: string): string | undefined {
  for (let i = trace.criticRounds.length - 1; i >= 0; i--) {
    if (trace.criticRounds[i].stepId === stepId) {
      return trace.criticRounds[i].verdict;
    }
  }
  return undefined;
}

function formatAnswerFromEnvelope(body: string, keyInsight: string | null | undefined): string {
  const parts: string[] = [body.trim()];
  const ki = keyInsight?.trim();
  if (ki) {
    parts.push("", `**Key insight:** ${ki}`);
  }
  return parts.join("\n").trim();
}

async function synthesizeFinalAnswerEnvelope(
  ctx: AgentExecutionContext,
  observations: string[],
  turnId: string,
  onLlmCall: () => void
): Promise<{ answer: string; keyInsight?: string; ctas: string[]; suggestionHints: string[] }> {
  const sacBlock = ctx.sessionAnalysisContext
    ? `\n\nSessionAnalysisContextJSON:\n${JSON.stringify(ctx.sessionAnalysisContext).slice(0, 10000)}`
    : "";
  const permBlock = ctx.permanentContext?.trim().length
    ? `\n\nUser notes:\n${ctx.permanentContext.trim().slice(0, 4000)}`
    : "";
  const user = `Question: ${ctx.question}${permBlock}${sacBlock}\n\nObservations:\n${observations.join("\n\n---\n\n").slice(0, 12000)}`;

  const system = `You are a senior data analyst. Using ONLY the observations from tools, produce JSON with:
- "body": main markdown answer (clear, concise). Do not duplicate the full key insight inside body; keep body focused on the direct answer.
- "keyInsight": optional substantive takeaway (1–4 sentences, or null if nothing beyond the body adds value). Interpret what the numbers imply for decisions: segments, risk, opportunity, or “so what” for the business—using general knowledge only where it does not contradict the data. Do not repeat the question. If the result is purely descriptive with no extra implication, use null.
- "ctas": 0 to 3 short, actionable follow-up prompts (different angles from body; no numbering in strings). Use empty array if none fit.
Numeric claims, extremes, and trends must match tool output (aggregated tables, formatted results, chart summaries). Do not invent order-level or row-level numbers that do not appear in observations.
If data is insufficient, say what is missing in body and use minimal ctas. Respect SessionAnalysisContextJSON and user notes when they do not contradict the data.
If observations mention zero analytical results, "0 rows", or "Diagnostic:" with distinct value samples, explain that concretely in body (likely filter/label mismatch or missing column) using those samples — do NOT ask vague clarification when the user question was already specific.`;

  const out = await completeJson(system, user, finalAnswerEnvelopeSchema, {
    turnId: `${turnId}_synth`,
    maxTokens: 2600,
    temperature: getInsightTemperatureConservative(),
    model: getInsightModel(),
    onLlmCall,
  });

  if (!out.ok) {
    onLlmCall();
    const res = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
            content:
            "You are a data analyst. Answer using ONLY tool observations. If results are empty, cite diagnostics and distinct samples from observations; do not give vague clarifying questions when the user was specific.",
        },
        { role: "user", content: user },
      ],
      temperature: 0.35,
      max_tokens: 2000,
    });
    const fallback =
      res.choices[0]?.message?.content?.trim() ||
      "I could not produce an answer from the available data.";
    return { answer: fallback, ctas: [], suggestionHints: [] };
  }

  const { body, keyInsight, ctas } = out.data;
  const ki = keyInsight?.trim() || undefined;
  const ctaList = (ctas ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
  let answer = formatAnswerFromEnvelope(body ?? "", ki ?? null);
  let suggestionHints = [...ctaList, ...(ki ? [ki] : [])];

  if (!answer.trim()) {
    onLlmCall();
    const res = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a data analyst. Answer using ONLY tool observations. If results are empty, cite diagnostics and distinct samples from observations; do not give vague clarifying questions when the user was specific.",
        },
        { role: "user", content: user },
      ],
      temperature: 0.35,
      max_tokens: 2000,
    });
    const chatFallback =
      res.choices[0]?.message?.content?.trim() ||
      "";
    if (chatFallback) {
      return { answer: chatFallback, ctas: [], suggestionHints: [] };
    }
    const deterministic = observations.join("\n\n---\n\n").trim().slice(0, 8000);
    return {
      answer:
        deterministic ?
          `Summary from tool output:\n\n${deterministic}`
        : "I could not produce an answer from the available data.",
      ctas: [],
      suggestionHints: [],
    };
  }

  return { answer, keyInsight: ki, ctas: ctaList, suggestionHints };
}

function buildPreSynthesisMidTurnSummary(
  ctx: AgentExecutionContext,
  trace: AgentTrace,
  observations: string[],
  mergedCharts: Array<{ title: string; x: string; y: string }>
): string {
  const tools = trace.toolCalls.map((t) => `${t.name}:${t.ok}`).join(", ");
  const obsTail = observations.join("\n\n---\n\n").slice(-5000);
  const charts = mergedCharts.map((c) => `${c.title}(${c.x}/${c.y})`).join("; ");
  return [
    `Question: ${ctx.question.slice(0, 500)}`,
    `planRationale: ${(trace.planRationale || "").slice(0, 1200)}`,
    `tools: ${tools || "(none)"}`,
    `chartsSoFar: ${charts || "(none)"}`,
    `recentObservations:\n${obsTail}`,
  ].join("\n\n");
}

function appendEnvelopeInsightWhenNoCharts(
  mergedCharts: { length: number },
  mergedInsights: Insight[],
  keyInsight?: string
) {
  if (mergedCharts.length > 0 || !keyInsight?.trim()) return;
  const text = keyInsight.trim();
  const duplicate = mergedInsights.some((i) => i.text.slice(0, 50) === text.slice(0, 50));
  if (duplicate) return;
  const nextId = mergedInsights.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  mergedInsights.push({ id: nextId, text });
}

const PLANNER_RETRY_HINTS: Partial<Record<PlannerRejectReason, string>> = {
  llm_json_invalid:
    "IMPORTANT: Fix the previous attempt. Output ONLY valid JSON: an object with \"rationale\" (string) and \"steps\" (non-empty array of objects with id, tool, args, optional dependsOn). Use exact tool names from the Tools list.",
  empty_steps:
    "IMPORTANT: The steps array must not be empty. Include at least one step with a valid tool and args.",
  invalid_tool_args:
    "IMPORTANT: Tool arguments failed schema validation. For `execute_query_plan`, ensure `plan.dimensionFilters` items include required keys `column`, `op` ('in'|'not_in'), and `values` (string[]). If `plan.sort` is present, every item must include `column` and `direction` ('asc'|'desc') — otherwise omit invalid sort entries. For other tools, use only allowed keys and exact column names from the Dataset columns line.",
  unknown_tool:
    "IMPORTANT: Use only tool names exactly as listed in the Tools section (no invented names).",
  column_not_in_schema:
    "IMPORTANT: Every column in the plan must match a name from the Dataset columns line exactly (including parentheses and spacing).",
  invalid_aggregation_alias:
    "IMPORTANT: For execute_query_plan aggregations, alias must differ from source column. Keep schema column in aggregations[].column and use a distinct human-readable aggregations[].alias if needed.",
  ambiguous_column_resolution:
    "IMPORTANT: Use the AUTHORITATIVE columns for this question exactly. Do not invent near-miss names; use only exact schema/canonical names in groupBy/aggregations/filters/sort.",
  bad_depends_on:
    "IMPORTANT: Each dependsOn must reference another step id from the same plan.",
  dependency_cycle:
    "IMPORTANT: Remove circular dependsOn links; order steps as a DAG.",
};

/** One follow-up planner attempt with a corrective hint (reduces empty-plan user-facing failures). */
async function runPlannerWithOneRetry(
  ctx: AgentExecutionContext,
  registry: ToolRegistry,
  turnId: string,
  onLlmCall: () => void,
  priorObservationsText?: string,
  workingMemoryBlock?: string
) {
  const first = await runPlanner(
    ctx,
    registry,
    turnId,
    onLlmCall,
    priorObservationsText,
    workingMemoryBlock
  );
  if (first.ok) return first;
  const hint = first.reason ? PLANNER_RETRY_HINTS[first.reason] : undefined;
  if (!hint) return first;
  agentLog("planner.retry", { turnId, reason: first.reason });
  const ctxRetry: AgentExecutionContext = {
    ...ctx,
    question: `${ctx.question}\n\n${hint}`,
  };
  return runPlanner(
    ctxRetry,
    registry,
    turnId,
    onLlmCall,
    priorObservationsText,
    workingMemoryBlock
  );
}

export async function runAgentTurn(
  ctx: AgentExecutionContext,
  config: AgentConfig,
  emit?: AgentSseEmitter
): Promise<AgentLoopResult> {
  const registry = new ToolRegistry();
  registerDefaultTools(registry);
  const toolCtx = { exec: ctx, config };

  const turnId = randomUUID();
  const trace: AgentTrace = {
    turnId,
    startedAt: Date.now(),
    endedAt: Date.now(),
    steps: [],
    toolCalls: [],
    criticRounds: [],
    reflectorNotes: [],
    budgetHits: [],
    parseFailures: 0,
  };

  let llmCalls = 0;
  const onLlmCall = () => {
    llmCalls++;
    if (llmCalls > config.maxTotalLlmCallsPerTurn) {
      throw new Error("AGENT_LLM_BUDGET");
    }
  };

  const safeEmit = (event: string, data: unknown) => {
    try {
      emit?.(event, data);
    } catch {
      /* ignore client errors */
    }
  };

  let observations: string[] = [];
  let agentSuggestionHints: string[] = [];
  let followUpPrompts: string[] | undefined;
  const workingMemory: WorkingMemoryEntry[] = [];
  const mergedCharts: ChartSpec[] = [];
  const mergedInsights: Insight[] = [];
  const deferredPlanCharts: DeferredBuildChartTemplate[] = [];
  let table: any;
  let operationResult: any;
  let lastNumeric = "";
  let delegateAnswer: string | undefined;
  let lastRagHitCount: number | undefined;
  let toolCallsDone = 0;
  let stepsWalked = 0;
  let lastMidTurnPersist = 0;
  const midTurnThrottleMs = Math.max(
    0,
    parseInt(process.env.AGENT_MID_TURN_CONTEXT_THROTTLE_MS || "8000", 10) || 8000
  );

  const deadline = Date.now() + config.maxWallTimeMs;

  const mergeStepArtifacts = (tool: string, result: ToolResult) => {
    if (result.ragHitCount !== undefined) {
      lastRagHitCount = result.ragHitCount;
    }
    if (result.numericPayload) {
      lastNumeric = result.numericPayload;
    }
    if (result.charts?.length) {
      if (tool === "build_chart") {
        for (const c of result.charts) {
          deferredPlanCharts.push(deferredTemplateFromBuiltChart(c as ChartSpec));
        }
      } else {
        mergedCharts.push(...result.charts);
      }
    }
    if (result.insights?.length) {
      mergedInsights.push(...result.insights);
    }
    if (result.table) {
      table = result.table;
    }
    if (result.operationResult) {
      operationResult = result.operationResult;
    }
    if (result.answerFragment) {
      delegateAnswer = result.answerFragment;
    }
  };

  const maybeMidTurn = async (payload: AgentMidTurnSessionPayload) => {
    if (process.env.AGENT_MID_TURN_CONTEXT === "false") return;
    const fn = ctx.onMidTurnSessionContext;
    if (!fn) return;
    const now = Date.now();
    if (!payload.bypassThrottle && now - lastMidTurnPersist < midTurnThrottleMs) return;
    lastMidTurnPersist = Date.now();
    await fn({
      summary: payload.summary,
      phase: payload.phase,
      tool: payload.tool,
      ok: payload.ok,
    }).catch(() => {});
  };

  /** Survives catch if a post-synthesis step throws (e.g. visual planner). */
  let preservedAnswer = "";

  function observationsFallbackAnswer(): string {
    const body = observations.join("\n\n---\n\n").trim();
    if (!body) return "";
    return `Summary from tool output:\n\n${body.slice(0, 8000)}`;
  }

  try {
    let replans = 0;
    while (replans <= 2) {
      if (Date.now() > deadline) {
        trace.budgetHits?.push("wall_time");
        break;
      }

      const priorForPlanner =
        observations.length > 0
          ? observations.join("\n\n---\n\n").slice(0, 12_000)
          : undefined;
      const workingMemoryBlock = formatWorkingMemoryBlock(workingMemory);
      const planResult = await runPlannerWithOneRetry(
        ctx,
        registry,
        turnId,
        onLlmCall,
        priorForPlanner,
        workingMemoryBlock || undefined
      );
      if (!planResult.ok) {
        trace.parseFailures = (trace.parseFailures || 0) + 1;
        trace.plannerRejectReason = planResult.reason;
        trace.plannerRejectDetail = [
          planResult.tool,
          planResult.stepId,
          planResult.argKeys,
          planResult.zod_error,
        ]
          .filter(Boolean)
          .join("|")
          .slice(0, 300);
        trace.endedAt = Date.now();
        agentLog("turn.abort", {
          phase: "planner",
          turnId,
          reason: planResult.reason,
          parseFailures: trace.parseFailures ?? 0,
          questionLength: ctx.question.length,
          sessionIdLen: ctx.sessionId.length,
        });
        return {
          answer: "",
          charts: mergedCharts.length ? mergedCharts : undefined,
          insights: mergedInsights.length ? mergedInsights : undefined,
          table,
          operationResult,
          agentTrace: capAgentTrace(trace),
          agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
          lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
        };
      }

      const plan = planResult;

      trace.planRationale = plan.rationale;
      trace.steps = plan.steps;
      safeEmit("plan", {
        rationale: plan.rationale,
        steps: plan.steps.map((s) => ({
          id: s.id,
          tool: s.tool,
          args_summary: JSON.stringify(s.args).slice(0, 400),
        })),
      });

      if (ctx.mode === "analysis") {
        void maybeMidTurn({
          phase: "plan",
          summary: `Plan rationale:\n${(plan.rationale || "").slice(0, 2000)}\nSteps: ${plan.steps.map((s) => `${s.id}:${s.tool}`).join(" | ")}`,
          ok: true,
        });
      }

      let stopEarly = false;

      stepLoop: for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];
        if (Date.now() > deadline) {
          trace.budgetHits?.push("wall_time");
          stopEarly = true;
          break;
        }
        if (stepsWalked >= config.maxSteps) {
          trace.budgetHits?.push("max_steps");
          stopEarly = true;
          break;
        }
        if (toolCallsDone >= config.maxToolCalls) {
          trace.budgetHits?.push("max_tool_calls");
          stopEarly = true;
          break;
        }

        stepsWalked++;

        let stepResult: ToolResult | undefined;
        let finalCallId = "";
        let finalCandidate = "";

        attemptLoop: for (let attempt = 0; attempt < 2; attempt++) {
          const callId = `${step.id}-${toolCallsDone}`;
          const argsSummary = JSON.stringify(step.args).slice(0, 400);
          safeEmit("tool_call", { id: callId, name: step.tool, args_summary: argsSummary });

          const t0 = Date.now();
          const result = await registry.execute(step.tool, step.args, toolCtx);
          const t1 = Date.now();
          toolCallsDone++;

          const record: ToolCallRecord = {
            id: callId,
            name: step.tool,
            argsSummary,
            ok: result.ok,
            startedAt: t0,
            endedAt: t1,
            resultSummary: result.summary.slice(0, 800),
          };
          trace.toolCalls.push(record);

          safeEmit("tool_result", {
            id: callId,
            ok: result.ok,
            summary: result.summary.slice(0, 2000),
          });

          if (result.workbenchArtifact) {
            safeEmit("workbench", { entry: result.workbenchArtifact });
          }

          void maybeMidTurn({
            phase: "tool",
            tool: step.tool,
            summary: result.summary,
            ok: result.ok,
          });

          stepResult = result;
          finalCallId = callId;

          const invalidArgs =
            !result.ok && result.summary.startsWith("Invalid args for");
          if (invalidArgs) {
            trace.parseFailures = (trace.parseFailures || 0) + 1;
            const help = registry.getArgsHelpForTool(step.tool) ?? "{}";
            observations.push(
              `[SYSTEM_REPAIR] Tool "${step.tool}" args must match the schema. Allowed: ${help}. Error: ${result.summary.slice(0, 400)}`
            );
            workingMemory.push({
              callId,
              tool: step.tool,
              ok: false,
              summaryPreview: result.summary,
              suggestedColumns: undefined,
              slots: undefined,
            });
            replans++;
            break stepLoop;
          }

          if (result.clarify) {
            mergeStepArtifacts(step.tool, result);
            materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
            trace.endedAt = Date.now();
            return {
              answer: result.clarify,
              charts: mergedCharts.length ? mergedCharts : undefined,
              insights: mergedInsights.length ? mergedInsights : undefined,
              table,
              operationResult,
              agentTrace: capAgentTrace(trace),
              lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
            };
          }

          let candidate =
            result.answerFragment ||
            result.summary ||
            (result.ok ? "(no summary)" : "Tool failed.");
          if (result.suggestedColumns?.length) {
            candidate += `\nSuggested columns: ${result.suggestedColumns.join(", ")}`;
          }

          const evidence = `${result.summary}\n${lastNumeric || ""}`.slice(0, 8000);

          let vRound = 0;
          while (vRound < config.maxVerifierRoundsPerStep) {
            const verdict = await runVerifier(
              ctx,
              {
                candidate,
                evidenceSummary: evidence,
                stepId: step.id,
                turnId,
              },
              onLlmCall
            );

            trace.criticRounds.push({
              stepId: step.id,
              verdict: verdict.verdict,
              issueCodes: verdict.issues.map((i) => i.code),
              courseCorrection: verdict.course_correction,
            });

            safeEmit("critic_verdict", {
              stepId: step.id,
              verdict: verdict.verdict,
              issue_codes: verdict.issues.map((i) => i.code),
              course_correction: verdict.course_correction,
            });

            if (verdict.verdict === "pass") {
              break;
            }
            if (
              verdict.verdict === "revise_narrative" ||
              verdict.course_correction === "revise_narrative"
            ) {
              const issuesText = verdict.issues.map((i) => i.description).join("; ");
              candidate = await rewriteNarrative(
                ctx,
                candidate,
                issuesText,
                onLlmCall,
                evidence
              );
              vRound++;
              continue;
            }
            break;
          }

          finalCandidate = candidate;

          const lastV = lastVerdictForStep(trace, step.id);
          if (lastV === "retry_tool" && attempt < 1) {
            trace.reflectorNotes.push(`retry_tool: re-exec ${step.tool}`);
            continue attemptLoop;
          }
          break attemptLoop;
        }

        if (!stepResult) {
          break;
        }

        mergeStepArtifacts(step.tool, stepResult);

        if (
          stepResult.ok &&
          ctx.onIntermediateArtifact &&
          INTERMEDIATE_TABLE_TOOLS.has(step.tool)
        ) {
          const intermediateRows = toolTableRowsForIntermediate(stepResult);
          if (intermediateRows.length > 0) {
            const insight = buildIntermediateInsight(step.tool, stepResult);
            const pivotDefaults = derivePivotDefaultsFromPreviewRows(
              intermediateRows,
              ctx.summary,
              toolTableColumnOrderForIntermediate(stepResult)
            );
            const hasPivotHint =
              Boolean(pivotDefaults?.rows?.length) && Boolean(pivotDefaults?.values?.length);
            ctx.onIntermediateArtifact({
              preview: intermediateRows.slice(0, 50),
              insight,
              ...(hasPivotHint
                ? {
                    pivotDefaults: {
                      rows: pivotDefaults!.rows,
                      values: pivotDefaults!.values,
                      ...(pivotDefaults!.columns?.length
                        ? { columns: pivotDefaults!.columns }
                        : {}),
                    },
                  }
                : {}),
            });
          }
        }

        if (
          stepResult.ok &&
          stepResult.table &&
          Array.isArray(stepResult.table.rows) &&
          stepResult.table.rows.length > 0 &&
          (step.tool === "run_analytical_query" ||
            step.tool === "execute_query_plan" ||
            step.tool === "derive_dimension_bucket" ||
            step.tool === "add_computed_columns" ||
            step.tool === "run_readonly_sql")
        ) {
          const analyticalRows = stepResult.table.rows as Record<string, unknown>[];
          ctx.data = analyticalRows;
          ctx.lastAnalyticalTable = {
            rows: analyticalRows,
            columns: rowKeysFromFirstRow(analyticalRows),
            sourceTool: step.tool,
          };
        }

        if (stepResult.ok && step.tool === "derive_dimension_bucket") {
          const neu = step.args.newColumnName;
          if (typeof neu === "string" && neu.trim()) {
            registerDerivedColumnOnSummary(ctx.summary, neu, ctx.data);
          }
        }

        if (stepResult.ok && step.tool === "add_computed_columns") {
          const parsedArgs = addComputedColumnsArgsSchema.safeParse(step.args);
          if (parsedArgs.success) {
            registerComputedColumnsOnSummary(ctx.summary, parsedArgs.data, ctx.data);
          }
        }

        for (const line of lintAfterAnalyticalTool({
          tool: step.tool,
          ok: stepResult.ok,
          question: ctx.question,
          parsed: stepResult.queryPlanParsed,
          outputRowCount:
            stepResult.table?.rowCount ?? stepResult.analyticalMeta?.outputRowCount,
          outputColumns: Array.isArray(stepResult.table?.columns)
            ? (stepResult.table.columns as string[])
            : undefined,
        })) {
          observations.push(line);
        }

        const finalTrimmed = finalCandidate.trimStart();
        // If the tool already produced a structured SYSTEM_VALIDATION line, keep it
        // intact so the reflector can reliably detect it.
        if (finalTrimmed.startsWith("[SYSTEM_VALIDATION]")) {
          observations.push(finalTrimmed);
        } else {
          observations.push(`[${step.tool}] ${finalCandidate}`);
        }

        workingMemory.push({
          callId: finalCallId,
          tool: step.tool,
          ok: stepResult.ok,
          summaryPreview: stepResult.summary,
          suggestedColumns: stepResult.suggestedColumns,
          slots: stepResult.memorySlots,
        });

        const ref = await runReflector(
          ctx,
          {
            observations,
            lastTool: step.tool,
            lastOk: stepResult.ok,
            lastAnalyticalMeta:
              step.tool === "run_analytical_query" ||
              step.tool === "execute_query_plan"
                ? stepResult.analyticalMeta
                : undefined,
          },
          turnId,
          onLlmCall
        );
        trace.reflectorNotes.push(ref.action + (ref.note ? `: ${ref.note}` : ""));

        if (ref.action === "finish") {
          const remaining = plan.steps.length - si - 1;
          if (remaining > 0) {
            trace.reflectorNotes.push(`finish_overridden: ${remaining} step(s) remain`);
          } else {
            stopEarly = true;
            break;
          }
        } else if (ref.action === "clarify" && ref.clarify_message) {
          trace.endedAt = Date.now();
          materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
          return {
            answer: ref.clarify_message,
            charts: mergedCharts.length ? mergedCharts : undefined,
            insights: mergedInsights.length ? mergedInsights : undefined,
            agentTrace: capAgentTrace(trace),
            lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
          };
        } else if (ref.action === "replan") {
          replans++;
          void maybeMidTurn({
            phase: "plan_replan",
            summary: `Replanned after step ${step.id} (${step.tool}). Observations: ${observations.length}. Note: ${ref.note ?? "(none)"}`.slice(
              0,
              4000
            ),
            ok: true,
          });
          break;
        }
      }

      if (stopEarly) {
        break;
      }
      if (replans > 0 && observations.length > 0) {
        /* replan loop continues */
        continue;
      }
      break;
    }

    await maybeMidTurn({
      phase: "pre_synthesis",
      bypassThrottle: true,
      ok: true,
      summary: buildPreSynthesisMidTurnSummary(ctx, trace, observations, mergedCharts),
    });

    let answer = delegateAnswer || "";
    if (!answer && observations.length > 0) {
      try {
        const env = await synthesizeFinalAnswerEnvelope(ctx, observations, turnId, onLlmCall);
        answer = env.answer;
        agentSuggestionHints = env.suggestionHints;
        const trimmedCtas = (env.ctas ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
        if (trimmedCtas.length) followUpPrompts = trimmedCtas;
        appendEnvelopeInsightWhenNoCharts(mergedCharts, mergedInsights, env.keyInsight);
      } catch (synErr) {
        const msg = synErr instanceof Error ? synErr.message : String(synErr);
        agentLog("synthesis_error", { turnId, err: msg.slice(0, 300) });
        answer = observationsFallbackAnswer();
      }
    }
    preservedAnswer = answer;

    materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);

    let visualExtra: Awaited<ReturnType<typeof proposeAndBuildExtraCharts>> = {
      charts: [],
    };
    try {
      visualExtra = await proposeAndBuildExtraCharts(
        ctx,
        observations.join("\n\n---\n\n"),
        turnId,
        onLlmCall,
        mergedCharts,
        answer.trim().slice(0, 6000)
      );
    } catch (visErr) {
      const msg = visErr instanceof Error ? visErr.message : String(visErr);
      agentLog("visual_planner_failed", { turnId, err: msg.slice(0, 300) });
    }
    if (visualExtra.charts.length) {
      mergedCharts.push(...visualExtra.charts);
      if (ctx.mode === "analysis") {
        void maybeMidTurn({
          phase: "post_visual",
          summary: `Visual planner added: ${visualExtra.charts.map((c) => `${c.title}:${c.x}/${c.y}`).join("; ")}`,
          ok: true,
        });
      }
    }

    if (!answer?.trim()) {
      const fb = observationsFallbackAnswer();
      if (fb) {
        answer = fb;
        preservedAnswer = fb;
        agentLog("synthesis_empty_fallback", {
          turnId,
          observationsCount: observations.length,
          toolCallsDone,
        });
      }
    }

    if (!answer?.trim()) {
      trace.endedAt = Date.now();
      agentLog("turn.abort", {
        phase: "synthesis",
        turnId,
        observationsCount: observations.length,
        hadDelegateAnswer: Boolean(delegateAnswer?.trim()),
        toolCallsDone,
        chartsCount: mergedCharts.length,
        sessionIdLen: ctx.sessionId.length,
      });
      return {
        answer: "",
        charts: mergedCharts.length ? mergedCharts : undefined,
        insights: mergedInsights.length ? mergedInsights : undefined,
        table,
        operationResult,
        agentTrace: capAgentTrace(trace),
        agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
        lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
      };
    }

    let finalRound = 0;
    const chartTitles = mergedCharts.map((c) => `${c.title}:${c.x}/${c.y}`).join("; ");
    const finalEvidence = `${observations.join("\n")}\nCharts: ${chartTitles}`.slice(0, 10000);

    while (finalRound < config.maxVerifierRoundsFinal) {
      const fv = await runVerifier(
        ctx,
        {
          candidate: answer,
          evidenceSummary: finalEvidence,
          stepId: "final",
          turnId,
        },
        onLlmCall
      );
      trace.criticRounds.push({
        stepId: "final",
        verdict: fv.verdict,
        issueCodes: fv.issues.map((i) => i.code),
        courseCorrection: fv.course_correction,
      });
      safeEmit("critic_verdict", {
        stepId: "final",
        verdict: fv.verdict,
        issue_codes: fv.issues.map((i) => i.code),
        course_correction: fv.course_correction,
      });
      if (fv.verdict === "pass") {
        break;
      }
      if (fv.verdict === "revise_narrative" || fv.course_correction === "revise_narrative") {
        const issuesText = fv.issues.map((i) => i.description).join("; ");
        answer = await rewriteNarrative(
          ctx,
          answer,
          issuesText,
          onLlmCall,
          finalEvidence
        );
        finalRound++;
        continue;
      }
      break;
    }

    preservedAnswer = answer;
    trace.endedAt = Date.now();
    agentLog("turn_done", {
      turnId,
      tools: toolCallsDone,
      llmCalls,
      mode: ctx.mode,
      legacyFallback: false,
      ragHitCount: lastRagHitCount,
    });

    return {
      answer,
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
      agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
      ...(followUpPrompts?.length ? { followUpPrompts } : {}),
      lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AGENT_LLM_BUDGET") {
      trace.budgetHits?.push("max_llm_calls");
      trace.endedAt = Date.now();
      agentLog("turn_budget", {
        turnId,
        kind: "llm",
        mode: ctx.mode,
        legacyFallback: false,
      });
      materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
      const partial =
        delegateAnswer ||
        (observations.length > 0
          ? observations.join("\n\n").slice(0, 8000)
          : "Agent LLM budget exceeded for this turn.");
      return {
        answer: partial,
        charts: mergedCharts.length ? mergedCharts : undefined,
        insights: mergedInsights.length ? mergedInsights : undefined,
        table,
        operationResult,
        agentTrace: capAgentTrace(trace),
        lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
      };
    }
    trace.endedAt = Date.now();
    agentLog("turn_error", {
      turnId,
      err: msg.slice(0, 200),
      mode: ctx.mode,
      legacyFallback: false,
    });
    materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
    const errFallback =
      preservedAnswer.trim() ||
      observationsFallbackAnswer() ||
      "";
    return {
      answer:
        errFallback ||
        `The analysis agent encountered an error (${msg.length > 200 ? `${msg.slice(0, 200)}…` : msg}). Please try again.`,
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
      ...(followUpPrompts?.length ? { followUpPrompts } : {}),
      lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
    };
  }
}
