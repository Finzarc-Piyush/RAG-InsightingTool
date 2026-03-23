import { randomUUID } from "crypto";
import type {
  AgentConfig,
  AgentExecutionContext,
  AgentLoopResult,
  AgentTrace,
  ToolCallRecord,
  WorkingMemoryEntry,
} from "./types.js";
import { AGENT_TRACE_MAX_BYTES } from "./types.js";
import { ToolRegistry } from "./toolRegistry.js";
import { registerDefaultTools } from "./tools/registerTools.js";
import { runPlanner } from "./planner.js";
import { formatWorkingMemoryBlock } from "./workingMemory.js";
import { runReflector } from "./reflector.js";
import { runVerifier, rewriteNarrative } from "./verifier.js";
import { agentLog } from "./agentLogger.js";
import { openai, MODEL } from "../../openai.js";

export type AgentSseEmitter = (event: string, data: unknown) => void;

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

async function synthesizeFinalAnswer(
  ctx: AgentExecutionContext,
  observations: string[],
  onLlmCall: () => void
): Promise<string> {
  onLlmCall();
  const sacBlock = ctx.sessionAnalysisContext
    ? `\n\nSessionAnalysisContextJSON:\n${JSON.stringify(ctx.sessionAnalysisContext).slice(0, 10000)}`
    : "";
  const permBlock = ctx.permanentContext?.trim().length
    ? `\n\nUser notes:\n${ctx.permanentContext.trim().slice(0, 4000)}`
    : "";
  const res = await openai.chat.completions.create({
    model: MODEL as string,
    messages: [
      {
        role: "system",
        content:
          "You are a data analyst. Answer the user clearly using ONLY the observations from tools. If insufficient, say what is missing. Respect constraints implied by SessionAnalysisContextJSON and user notes when they do not contradict the data.",
      },
      {
        role: "user",
        content: `Question: ${ctx.question}${permBlock}${sacBlock}\n\nObservations:\n${observations.join("\n\n---\n\n").slice(0, 12000)}`,
      },
    ],
    temperature: 0.35,
    max_tokens: 2000,
  });
  return res.choices[0]?.message?.content?.trim() || "I could not produce an answer from the available data.";
}

export async function runAgentTurn(
  ctx: AgentExecutionContext,
  config: AgentConfig,
  emit?: AgentSseEmitter
): Promise<AgentLoopResult | null> {
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
  const workingMemory: WorkingMemoryEntry[] = [];
  const mergedCharts: import("../../../shared/schema.js").ChartSpec[] = [];
  const mergedInsights: import("../../../shared/schema.js").Insight[] = [];
  let table: any;
  let operationResult: any;
  let lastNumeric = "";
  let delegateAnswer: string | undefined;
  let toolCallsDone = 0;
  let stepsWalked = 0;

  const deadline = Date.now() + config.maxWallTimeMs;

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
      const plan = await runPlanner(
        ctx,
        registry,
        turnId,
        onLlmCall,
        priorForPlanner,
        workingMemoryBlock || undefined
      );
      if (!plan || plan.steps.length === 0) {
        trace.parseFailures = (trace.parseFailures || 0) + 1;
        return null;
      }

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

      let stopEarly = false;

      for (const step of plan.steps) {
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

        if (result.numericPayload) {
          lastNumeric = result.numericPayload;
        }
        if (result.charts?.length) {
          mergedCharts.push(...result.charts);
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

        if (result.clarify) {
          trace.endedAt = Date.now();
          return {
            answer: result.clarify,
            charts: mergedCharts.length ? mergedCharts : undefined,
            insights: mergedInsights.length ? mergedInsights : undefined,
            table,
            operationResult,
            agentTrace: capAgentTrace(trace),
          };
        }

        if (result.answerFragment) {
          delegateAnswer = result.answerFragment;
        }

        let candidate =
          result.answerFragment ||
          result.summary ||
          (result.ok ? "(no summary)" : "Tool failed.");
        if (result.suggestedColumns?.length) {
          candidate += `\nSuggested columns: ${result.suggestedColumns.join(", ")}`;
        }

        let evidence = `${result.summary}\n${lastNumeric || ""}`.slice(0, 8000);

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
            candidate = await rewriteNarrative(ctx, candidate, issuesText, onLlmCall);
            vRound++;
            continue;
          }
          break;
        }

        observations.push(`[${step.tool}] ${candidate}`);

        workingMemory.push({
          callId,
          tool: step.tool,
          ok: result.ok,
          summaryPreview: result.summary,
          suggestedColumns: result.suggestedColumns,
          slots: result.memorySlots,
        });

        const ref = await runReflector(
          ctx,
          {
            observations,
            lastTool: step.tool,
            lastOk: result.ok,
          },
          turnId,
          onLlmCall
        );
        trace.reflectorNotes.push(ref.action + (ref.note ? `: ${ref.note}` : ""));

        if (ref.action === "finish") {
          stopEarly = true;
          break;
        }
        if (ref.action === "clarify" && ref.clarify_message) {
          trace.endedAt = Date.now();
          return {
            answer: ref.clarify_message,
            agentTrace: capAgentTrace(trace),
          };
        }
        if (ref.action === "replan") {
          replans++;
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

    let answer =
      delegateAnswer ||
      (observations.length > 0
        ? await synthesizeFinalAnswer(ctx, observations, onLlmCall)
        : "");

    if (!answer) {
      return null;
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
        answer = await rewriteNarrative(ctx, answer, issuesText, onLlmCall);
        finalRound++;
        continue;
      }
      break;
    }

    trace.endedAt = Date.now();
    agentLog("turn_done", { turnId, tools: toolCallsDone, llmCalls });

    return {
      answer,
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AGENT_LLM_BUDGET") {
      trace.budgetHits?.push("max_llm_calls");
      trace.endedAt = Date.now();
      agentLog("turn_budget", { turnId, kind: "llm" });
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
      };
    }
    trace.endedAt = Date.now();
    agentLog("turn_error", { turnId, err: msg.slice(0, 200) });
    return {
      answer: "",
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
    };
  }
}
