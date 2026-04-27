/**
 * Wave W18 · LLM stub harness for tests
 *
 * Lets a test short-circuit `callLlm` per-purpose without touching the real
 * OpenAI / Anthropic clients. Routes via the test-only resolver hook
 * `__setLlmStubResolver` exported from `callLlm.ts`.
 *
 * Usage:
 *   installLlmStub({
 *     planner: () => ({ rationale: "...", steps: [...] }),
 *     narrator: () => ({ body: "...", findings: [...], implications: [...] }),
 *     verifier_deep: () => ({ verdict: "pass", issues: [] }),
 *   });
 *   // ...test runs runAgentTurn or whatever...
 *   clearLlmStub(); // teardown
 *
 * Each handler receives the OpenAI-shaped request and returns a plain JS
 * object. The harness wraps it into a valid `ChatCompletion` shape so
 * downstream code (completeJson's JSON.parse, callers reading `.choices[0]
 * .message.content`) works unchanged. When a purpose has no handler, the
 * default handler returns a minimal-but-valid envelope per purpose so the
 * pipeline doesn't crash on unstubbed paths.
 *
 * Production code never imports this file. The setter has a `__` prefix to
 * make the test-only intent unambiguous to readers.
 */
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions";
import {
  __setLlmStubResolver,
  type CallLlmOptions,
} from "../../lib/agents/runtime/callLlm.js";
import {
  LLM_PURPOSE,
  type LlmCallPurpose,
} from "../../lib/agents/runtime/llmCallPurpose.js";

export type StubHandler = (
  params: ChatCompletionCreateParamsNonStreaming
) => unknown;

export type StubHandlerMap = Partial<Record<LlmCallPurpose, StubHandler>>;

/**
 * Default per-purpose handlers used when a test doesn't override a specific
 * call. Each one returns a minimum-valid object that satisfies the schema the
 * caller's `completeJson` invocation expects, so pipelines don't crash on
 * unstubbed paths. Tests only need to supply the purposes whose output they
 * want to inspect.
 */
export const DEFAULT_STUB_HANDLERS: Required<StubHandlerMap> = {
  // ── Reasoning / synthesis ──
  [LLM_PURPOSE.HYPOTHESIS]: () => ({ hypotheses: [] }),
  [LLM_PURPOSE.PLANNER]: () => ({
    rationale: "stub planner",
    steps: [{ id: "s1", tool: "get_schema_summary", args: {} }],
  }),
  [LLM_PURPOSE.REFLECTOR]: () => ({ verdict: "continue", reason: "stub" }),
  [LLM_PURPOSE.VERIFIER_DEEP]: () => ({
    verdict: "pass",
    issues: [],
    course_correction: "pass",
  }),
  [LLM_PURPOSE.NARRATOR]: () => ({
    body: "Stub narrator body — analysis complete.",
    keyInsight: "Stub key insight.",
    ctas: [],
    findings: [
      { headline: "Stub finding 1", evidence: "Stub evidence 1" },
      { headline: "Stub finding 2", evidence: "Stub evidence 2" },
    ],
    implications: [
      { statement: "Stub statement 1", soWhat: "Stub so-what 1", confidence: "medium" },
      { statement: "Stub statement 2", soWhat: "Stub so-what 2", confidence: "medium" },
    ],
    recommendations: [
      { action: "Stub action 1", rationale: "Stub rationale 1", horizon: "now" },
      { action: "Stub action 2", rationale: "Stub rationale 2", horizon: "this_quarter" },
    ],
    domainLens: "Stub domain lens citing `marico-stub`.",
    tldr: "Stub TL;DR.",
    methodology: "Stub methodology.",
    caveats: ["Stub caveat"],
  }),
  [LLM_PURPOSE.FINAL_ANSWER]: () => ({
    body: "Stub final answer.",
    keyInsight: null,
    ctas: [],
  }),
  [LLM_PURPOSE.COORDINATOR]: () => ({ decision: "single", reason: "stub" }),
  [LLM_PURPOSE.ANALYSIS_BRIEF]: () => ({
    questionShape: "exploration",
    candidateDriverDimensions: [],
    epistemicNotes: "stub",
  }),
  [LLM_PURPOSE.VISUAL_PLANNER]: () => ({ charts: [] }),
  [LLM_PURPOSE.BUILD_DASHBOARD]: () => ({ tiles: [] }),
  [LLM_PURPOSE.SQL_GEN]: () => ({ sql: "SELECT 1" }),
  [LLM_PURPOSE.SESSION_CONTEXT]: () => ({}),
  [LLM_PURPOSE.DATASET_PROFILE]: () => ({
    shortDescription: "stub",
    dateColumns: [],
    suggestedQuestions: [],
  }),
  [LLM_PURPOSE.INSIGHT_GEN]: () => ({
    keyInsight: "Stub chart insight.",
    businessCommentary: "Per `marico-stub`, this metric typically …",
  }),
  [LLM_PURPOSE.CORRELATION_INSIGHT]: () => ({ insights: [] }),
  [LLM_PURPOSE.CHART_JSON_REPAIR]: () => ({}),
  [LLM_PURPOSE.CONVERSATIONAL]: () => ({ answer: "Stub conversational answer." }),
  [LLM_PURPOSE.ML_MODEL_SUMMARY]: () => ({ summary: "stub" }),

  // ── Classification / extraction (MINI) ──
  [LLM_PURPOSE.MODE_CLASSIFY]: () => ({ mode: "analysis" }),
  [LLM_PURPOSE.INTENT_CLASSIFY]: () => ({ intent: "analysis" }),
  [LLM_PURPOSE.COMPLEX_QUERY_SCORE]: () => ({ score: 0.5 }),
  [LLM_PURPOSE.SCHEMA_BIND]: () => ({ bindings: {} }),
  [LLM_PURPOSE.COLUMN_MATCH]: () => ({ matches: [] }),
  [LLM_PURPOSE.QUERY_PARSE]: () => ({}),
  [LLM_PURPOSE.TOOL_ARG_REPAIR]: () => ({}),
  [LLM_PURPOSE.DATE_ENRICH]: () => ({}),
  [LLM_PURPOSE.TEMPORAL_GRAIN]: () => ({ grain: "month" }),
  [LLM_PURPOSE.DATAOPS_INTENT]: () => ({ intent: "noop" }),
  [LLM_PURPOSE.DATAOPS_DEFAULTS]: () => ({}),
  [LLM_PURPOSE.DATAOPS_ML_PARAMS]: () => ({}),
  [LLM_PURPOSE.DATAOPS_COMPUTED_COL]: () => ({}),
  [LLM_PURPOSE.CLARIFY_QUESTION]: () => ({ question: "" }),
  [LLM_PURPOSE.SUGGEST_FOLLOW_UPS]: () => ({ suggestions: [] }),
  [LLM_PURPOSE.VERIFIER_SIMPLE]: () => ({ verdict: "pass", issues: [] }),
};

/** Track installed handlers so `clearLlmStub` is a clean teardown. */
let __activeHandlers: StubHandlerMap | null = null;

/**
 * Install a stub. Tests pass per-purpose handlers; everything not overridden
 * uses the default. Sets the resolver on `callLlm` so the next call hits the
 * stub instead of the network. Call `clearLlmStub()` in teardown.
 */
export function installLlmStub(handlers: StubHandlerMap = {}): void {
  __activeHandlers = handlers;
  const merged: StubHandlerMap = { ...DEFAULT_STUB_HANDLERS, ...handlers };
  __setLlmStubResolver((params, opts) =>
    buildStubCompletion(params, opts, merged)
  );
}

/** Tear down: restore the real `callLlm` path. */
export function clearLlmStub(): void {
  __activeHandlers = null;
  __setLlmStubResolver(null);
}

/** Inspect handlers currently installed (for debugging tests). */
export function getActiveStubHandlers(): StubHandlerMap | null {
  return __activeHandlers;
}

function buildStubCompletion(
  params: ChatCompletionCreateParamsNonStreaming,
  opts: CallLlmOptions,
  handlers: StubHandlerMap
): ChatCompletion | undefined {
  const purpose = opts.purpose;
  // Only stub purposeful calls; calls without a purpose (rare, mostly tests)
  // pass through. This keeps the harness tightly scoped to the agent runtime.
  if (!purpose) return undefined;
  const handler = handlers[purpose];
  if (!handler) return undefined;
  let payload: unknown;
  try {
    payload = handler(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`llmStub handler for "${purpose}" threw: ${msg}`);
  }
  const content =
    typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  return wrapAsChatCompletion(content, params.model);
}

function wrapAsChatCompletion(content: string, model: string): ChatCompletion {
  // Minimal valid ChatCompletion shape — enough for `callLlm` to return and
  // for downstream `JSON.parse(message.content)` to succeed. Token counts are
  // synthetic; usage telemetry is skipped on the stubbed path anyway.
  return {
    id: `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          refusal: null,
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  } as unknown as ChatCompletion;
}
