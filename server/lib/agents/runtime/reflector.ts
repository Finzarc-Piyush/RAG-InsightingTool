/**
 * ============================================================================
 * reflector.ts — the agent's "should I keep going?" decision-maker
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The agent answers questions in a plan/act loop: it makes a plan, runs a tool,
 *   looks at the result, and decides what to do next. This file IS that "decide
 *   what to do next" step (the "reflector"). After each tool runs, it asks an LLM
 *   to read the latest observations, the question, and the current blackboard
 *   (shared scratchpad of findings/hypotheses), then return one strategic verdict
 *   as JSON: continue (run more planned steps), finish (we have enough to answer),
 *   replan (the plan is wrong), clarify (ask the user), or investigate_gap (an
 *   open hypothesis has no evidence — add a targeted tool call to fill it).
 *
 * WHY IT MATTERS
 *   This is the steering wheel of the act loop. Good reflection stops the agent
 *   from finishing on bad data (e.g. an un-aggregated or empty query result) and
 *   from looping forever. It also detects anomalies worth spawning follow-up
 *   sub-questions for, and avoids repeating a verdict it already gave this turn.
 *
 * KEY PIECES
 *   - runReflector — builds the system+user prompts, calls the LLM via
 *     completeJson with the reflector schema, and returns the parsed verdict.
 *     On parse failure it safely defaults to {action:"continue"}.
 *
 * HOW IT CONNECTS
 *   Uses completeJson (llmJson.js) with reflectorOutputSchema (schemas.js), the
 *   shared ANALYST_PREAMBLE (sharedPrompts.js), context appendix
 *   (context.js · appendixForReflectorPrompt), and the blackboard formatter
 *   (analyticalBlackboard.js · formatForPlanner). LLM_PURPOSE.REFLECTOR
 *   (llmCallPurpose.js) selects which model handles this role. Called by the main
 *   act loop after each tool execution.
 *
 * NOTE: the system prompt starts with ANALYST_PREAMBLE so the static system text
 * is long enough to clear Azure OpenAI's prompt-cache threshold — every dynamic
 * value (question, observations, blackboard) lives in the user message instead.
 */
import type { AgentExecutionContext } from "./types.js";
import { reflectorOutputSchema } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import { appendixForReflectorPrompt } from "./context.js";
import { formatForPlanner } from "./analyticalBlackboard.js";

export async function runReflector(
  ctx: AgentExecutionContext,
  payload: {
    observations: string[];
    lastTool: string;
    lastOk: boolean;
    lastAnalyticalMeta?: {
      inputRowCount: number;
      outputRowCount: number;
      appliedAggregation: boolean;
    };
    /** Columns observed in prior successful tool calls — helps the reflector
     *  choose replan vs continue based on what has actually been explored. */
    workingMemorySuggestedColumns?: string[];
    /**
     * Prior reflector verdicts emitted earlier in THIS turn. Lets the
     * reflector detect repetition ("I already said replan at step 3 and was
     * suppressed; don't say it again") and converge.
     */
    priorReflectorVerdicts?: ReadonlyArray<{
      stepIndex: number;
      action: string;
      rationale: string;
    }>;
    /**
     * Prior verifier verdicts emitted earlier in THIS turn. Lets the
     * reflector escalate if the verifier already flagged something the
     * current plan keeps reasserting.
     */
    priorVerifierVerdicts?: ReadonlyArray<{
      stepIndex: number;
      verdict: string;
      rationale: string;
    }>;
  },
  turnId: string,
  onLlmCall: () => void,
  interAgentDigest?: string
) {
  // ANALYST_PREAMBLE prepended (~520 tokens) so this system string clears
  // Azure OpenAI's 1024-token cache threshold. Below the preamble is purely
  // static text — every dynamic bit (question, observations, blackboard) is in
  // the user message.
  const system = `${ANALYST_PREAMBLE}You are the reflector for a data agent. Decide the next strategic action.
Output JSON only: {"action":"continue"|"replan"|"finish"|"clarify"|"investigate_gap","note":string optional,"clarify_message":string optional,"spawnedQuestions":[...] optional,"gapFill":{...} optional}
- continue: more planned steps should run
- finish: we have enough to answer the user
- replan: the plan is wrong (rare)
- clarify: need user input (set clarify_message)
- investigate_gap (W11): an open hypothesis in INVESTIGATION_HYPOTHESES has NO evidence yet and the current plan will not cover it — add a targeted tool call. Set gapFill={"hypothesisId":string,"tool":string,"rationale":string,"args"?:object}. args MUST include real tool arguments (e.g. {"question_override":"sum of Sales by Region"} for run_analytical_query). Without args the step repeats the original question with no new evidence. Only use when the gap would materially affect answer quality and there are steps remaining or budget available.
If observations contain lines including [SYSTEM_VALIDATION], treat them as high-priority signals: prefer **continue** (if more steps can fix it) or **replan** (adjust dateAggregationPeriod, groupBy, filters, use derive_dimension_bucket, or add_computed_columns then re-aggregate) over **finish** when the mismatch would produce a misleading answer.
Use Last analytical metadata when present: if run_analytical_query failed (ok=false) or appliedAggregation is false with output row count nearly equal to input row count, prefer continue or replan over finish until an aggregated result or a clear row-level answer exists. If outputRows=0 but inputRows is large, prefer replan (retry with dimensionFilters / case_insensitive / fewer dimensions) over finish or clarify — observations often include distinct value samples to fix filters. If a chart would help comparisons and none was produced yet, prefer continue.
If "Columns explored so far" is present and the question asks about a dimension NOT in that list, prefer **replan** with a step that explicitly groups by or filters on the missing dimension.
W8 — spawnedQuestions: when action="finish" AND observations reveal a CONCRETE ANOMALOUS pattern (a spike, drop, or outlier with specific numbers that is NOT explained by the current plan), emit up to 3 sub-questions as spawnedQuestions:[{"question":string,"spawnReason":string,"priority":"high"|"medium"|"low","suggestedColumns":[]}]. ONLY spawn for anomalies where a follow-up investigation would substantially improve the root answer. Do NOT spawn for routine findings, expected patterns, or when the question is already fully answered. Each "question" MUST ask exactly ONE thing and be answerable in a single query — NEVER combine clauses with "and"/"or" or list multiple dimensions (BAD: "How do compliance visits and total visits vary by ASM or HQ?"); split any compound ask into separate single questions. NEVER suggest a RANDOM-SAMPLE question ("N random X", "sample some rows", "representative sample") — those are never actionable. NEVER group by an individual-entity IDENTIFIER column (a per-person name/code/id with thousands of distinct values, e.g. "by <rep name>" / "by <code>") — rank a meaningful dimension (region/area/cluster/manager) instead. Prefer questions about the metrics and dimensions central to the user's topic; skip low-relevance dimensions.`;

  const appendix = appendixForReflectorPrompt(ctx);
  const digestBlock =
    interAgentDigest?.trim().length ?
      `Coordinator handoff log (this turn):\n${interAgentDigest.trim().slice(0, 6_000)}\n\n`
      : "";
  const metaLine =
    payload.lastAnalyticalMeta ?
      `Last analytical metadata: inputRows=${payload.lastAnalyticalMeta.inputRowCount}, outputRows=${payload.lastAnalyticalMeta.outputRowCount}, appliedAggregation=${payload.lastAnalyticalMeta.appliedAggregation}\n`
      : "";
  const columnsLine =
    payload.workingMemorySuggestedColumns && payload.workingMemorySuggestedColumns.length > 0
      ? `Columns explored so far (from prior tool suggestedColumns): ${payload.workingMemorySuggestedColumns.slice(0, 20).join(", ")}\n`
      : "";
  // Inject blackboard hypothesis state so the reflector can identify uncovered
  // hypotheses. Generous char budget — the reflector quality-gates replans, so
  // don't starve it of context.
  const bbBlock = ctx.blackboard ? `${formatForPlanner(ctx.blackboard).slice(0, 4_000)}\n\n` : "";
  // Prior in-turn verdict history so the reflector can detect repetition
  // ("I already said replan at step 3") and the verifier pattern ("verifier
  // flagged FABRICATED_MAGNITUDES at step 2; the current plan still asserts it").
  const priorReflectorBlock =
    payload.priorReflectorVerdicts && payload.priorReflectorVerdicts.length > 0
      ? `Past reflector verdicts in this turn (most recent last):\n${payload.priorReflectorVerdicts
          .slice(-8)
          .map(
            (v) =>
              `  step ${v.stepIndex}: ${v.action} — ${v.rationale.slice(0, 280)}`
          )
          .join("\n")}\n\n`
      : "";
  const priorVerifierBlock =
    payload.priorVerifierVerdicts && payload.priorVerifierVerdicts.length > 0
      ? `Past verifier verdicts in this turn (most recent last):\n${payload.priorVerifierVerdicts
          .slice(-8)
          .map(
            (v) =>
              `  step ${v.stepIndex}: ${v.verdict} — ${v.rationale.slice(0, 280)}`
          )
          .join("\n")}\n\n`
      : "";
  const head = `Question: ${ctx.question}${appendix}\n${digestBlock}${bbBlock}${priorReflectorBlock}${priorVerifierBlock}${metaLine}${columnsLine}Last tool: ${payload.lastTool} ok=${payload.lastOk}\nObservations:\n`;
  // Generous observation cap so the reflector can reason on real error/summary text.
  const obsMax = Math.max(0, 12000 - head.length);
  const user = `${head}${payload.observations.join("\n---\n").slice(0, obsMax)}`;

  const out = await completeJson(system, user, reflectorOutputSchema, {
    turnId,
    temperature: 0.2,
    onLlmCall,
    purpose: LLM_PURPOSE.REFLECTOR,
  });
  if (!out.ok) {
    return { action: "continue" as const, note: "reflector_parse_failed" };
  }
  return out.data;
}
