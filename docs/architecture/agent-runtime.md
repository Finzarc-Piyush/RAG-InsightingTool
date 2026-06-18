# Agent runtime

## Purpose

The engine every chat turn routes through when `AGENTIC_LOOP_ENABLED=true`.
Plans a sequence of tool calls, executes them with reflection between
steps, verifies the final answer, and streams SSE events to the client
workbench. The agentic loop is mandatory: with `AGENTIC_LOOP_ENABLED`
unset/false, `dataAnalyzer.answerQuestion` throws — the legacy
orchestrator was deleted in `9422bed7` (invariant #1), so there is no
fallback path. The "Legacy layer" section below is frozen history, not a
live alternative.

## Key files

**Runtime loop**

- `server/lib/agents/runtime/agentLoop.service.ts` — `runAgentTurn` (the
  entry point).
- `server/lib/agents/runtime/planner.ts` — produces a `PlanStep[]` from
  the brief + skills manifest + tool manifest.
- `server/lib/agents/runtime/reflector.ts` — between-step critique.
- `server/lib/agents/runtime/verifier.ts` — final verdict on the
  synthesised answer.
- `server/lib/agents/runtime/types.ts` — `AgentState`, `AgentTrace`,
  `VerdictType`, `PlanStep`, `AgentLoopResult`.
- `server/lib/agents/runtime/schemas.ts` — zod schemas for planner
  output, verifier output, critic rounds.
- `server/lib/agents/runtime/workingMemory.ts` — per-turn memory slots.
- `server/lib/agents/runtime/context.ts` — assembles
  `AgentExecutionContext` (session, summary, working memory, etc.).

**Tools + skills**

- `server/lib/agents/runtime/toolRegistry.ts` — the `ToolRegistry`
  class and `ToolExecutor` / `ToolResult` types. See
  [`tool-registry.md`](./tool-registry.md).
- `server/lib/agents/runtime/tools/registerTools.ts` — one-shot boot
  registration of all tools.
- `server/lib/agents/runtime/skills/**` — Phase-1 analytical skills.
  See [`skills.md`](./skills.md).

**Configuration / guards**

- `server/lib/agents/runtime/assertAgenticRag.ts` —
  `assertAgenticRagConfiguration()` and
  `assertDashboardAutogenConfiguration()`. Called inside `createApp()`;
  misconfig fails boot.

**Legacy layer (removed)**

- The pre-agentic orchestrator (its `AgentOrchestrator.processQuery`
  entry point) and the dispatcher that registered 7 handlers
  (Conversational, DataOps, MLModel, Statistical, Comparison,
  Correlation, General) were both deleted in `9422bed7` (invariant #1).
  Neither file exists today; the agentic loop is the only path, and the
  table below is frozen history kept for context.

**Capability gap (important):**

The legacy handlers were frozen before Phase-1 skills and Phase-2
dashboard autogen landed, so they can only serve:

| Capability | Legacy | Agentic |
|---|:---:|:---:|
| Conversational replies | ✅ | ✅ |
| Statistical / ML handlers (correlation, modelling, etc.) | ✅ | ✅ (via tools) |
| Data-ops (filter / aggregate / pivot) | ✅ | ✅ |
| Generic "tell me about this dataset" prose | ✅ | ✅ |
| `variance_decomposer` skill | ❌ | ✅ |
| `driver_discovery` skill | ❌ | ✅ |
| `insight_explorer` skill | ❌ | ✅ |
| `time_window_diff` skill | ❌ | ✅ |
| Dashboard autogen (draft → from-spec → patch_dashboard tool) | ❌ | ✅ |
| RAG-backed retrieval | partial | ✅ |
| `agentTrace` / workbench SSE | ❌ | ✅ |

**Do not** disable `AGENTIC_LOOP_ENABLED` as a hotfix. Use these
narrower knobs instead:

- `AGENT_TOOL_TIMEOUT_MS` — bound individual tool wall-time.
- `AGENTIC_MAX_STEPS` — cap the plan length.
- `DEEP_ANALYSIS_SKILLS_ENABLED=false` — turn off skills without
  leaving the agentic runtime; the planner falls back to ad-hoc
  tool plans.

The invariant "no legacy fallback when agentic is on" is declared
in `docs/plans/agentic_only_rag_chat.md` and enforced at boot by
`runtime/assertAgenticRag.ts`.

## Data contracts

- **`AgentTrace`** (`types.ts`) — the blob that ends up on the
  assistant message in Cosmos and is rendered by the client workbench.
  Already mirrored on both `schema.ts` files as
  `agentTrace: z.record(z.unknown()).optional()`.
- **`VerdictType`** (`types.ts`) — the verifier's possible
  outcomes: `"pass" | "revise_narrative" | "retry_tool" | "replan" |
  "ask_user" | "abort_partial"`. The zod enum in `schemas.ts`
  holds the same six values; the `VERIFIER_VERDICT` constant re-export
  (added in Wave F3) keeps `agentLoop.service.ts` literal-free.
- **`PlanStep`** (`types.ts`) — each plan entry carries `id`, `tool`,
  `args`, and optional `dependsOn`.

## Runtime flow

1. `services/chat/chatStream.service.ts` classifies the mode, assembles
   `AgentExecutionContext`, and calls `runAgentTurn`.
2. `runPlanner` returns a `PlanStep[]` or a rejection string. Arguments
   are repaired through `planArgRepairs.ts` and column names through
   `plannerColumnResolve.ts` before execution.
3. Each plan step resolves a tool via `ToolRegistry.execute(name, args,
   ctx)`. The registry safe-parses args against the tool's zod schema
   and writes a `tool_done` / `tool_error` log line with timing.
4. The reflector critiques after each step; `workingMemory` accumulates
   facts that later steps can reference.
5. When the plan finishes, the synthesiser produces the final answer.
6. The verifier reads the synthesised answer against the plan trace and
   returns a `VerifierResult { verdict, issues, course_correction }`.
7. On `verdict=revise_narrative`, the synthesiser runs again with the
   issues appended. Other verdicts (retry_tool, replan, etc.) hand back
   to the planner or surface a user-visible note.
8. The final `AgentLoopResult` is emitted as SSE events (through
   `services/chat/agentWorkbench.util.ts`) and persisted onto the
   assistant message in Cosmos.

## Verdict vocabulary

Six terminal verdicts. Use the `VERIFIER_VERDICT.*` constants (exported
from `schemas.ts`) rather than string literals:

| Verdict | Meaning | Loop action |
|---|---|---|
| `pass` | Answer is grounded and complete | Emit as-is |
| `revise_narrative` | Narrative drifts from evidence | Re-synthesise with issues |
| `retry_tool` | A specific tool run was flawed | Re-run that step |
| `replan` | The plan itself is wrong | Back to planner |
| `ask_user` | Ambiguous intent | Emit clarification prompt |
| `abort_partial` | Budget exhausted / unrecoverable | Emit partial answer + trace |

## Extension points

- **New tool**: define in `runtime/tools/<name>Tool.ts`, register inside
  `registerTools.ts`. See [`tool-registry.md`](./tool-registry.md).
- **New skill**: drop a module in `runtime/skills/`, call
  `registerSkill()` at module top-level, add an `import "./yourSkill.js"`
  line to `skills/index.ts`. See [`skills.md`](./skills.md).
- **New verdict branch**: update `VerdictType` union in `types.ts`, the
  zod enum in `schemas.ts`, the `VERIFIER_VERDICT` constant, and
  the dispatch in `agentLoop.service.ts`. TypeScript will surface every
  missing branch.

## Known pitfalls

- **No fallback path exists.** The old handlers were frozen before
  `varianceDecomposer`, `driverDiscovery`, `insightExplorer`,
  `timeWindowDiff`, or dashboard autogen existed, and were deleted in
  `9422bed7` (invariant #1). There is nothing to fall through to:
  `dataAnalyzer.answerQuestion` throws when `AGENTIC_LOOP_ENABLED` is
  unset/false. To bound a runaway turn use `AGENT_TOOL_TIMEOUT_MS` or
  `AGENTIC_MAX_STEPS` instead — never disable the agentic loop.
- **Skill selection is priority-ordered (Wave F1).** Prior to F1 it was
  first-match-wins on load order, which let `varianceDecomposer` shadow
  `timeWindowDiff`. See [`skills.md`](./skills.md).
- **Tool / skill registry duplicate re-registration is fatal (Wave
  F2).** Boot-time registration is called exactly once per process; a
  duplicate name throws loudly. See [`tool-registry.md`](./tool-registry.md).

## Recent changes

Per-wave history lives in [`docs/WAVES.md`](../WAVES.md) (search the wave id). The detailed
pre-2026-06 subsystem changelog was moved out of this routing doc to keep `/load` cheap —
see [`docs/archive/agent-runtime-changelog.md`](../archive/agent-runtime-changelog.md). Keep new
entries here to ONE line each; full prose belongs in `docs/WAVES.md`.

- 2026-06-18 · IUX3 (dashboard-build status) — the long, previously-silent post-answer dashboard phase (visual planner → feature sweep → `buildDashboardFromTurn` + persist) is now bracketed by a paired `safeEmit("thinking", { step: "Building dashboard", active→completed })` in `agentLoop.service.ts`, gated on the hoisted `isExplicitDashboardAsk && answer.trim()` (the feature-sweep gate reuses the same const). Client `ThinkingPanel` maps the step to "Assembling your dashboard…" and, while active+streaming, rotates ~100 witty lines (`dashboardBuildMessages.ts` via the new shared `useRotatingMessage` hook) under the pill and in the collapsed header — so the ~1 min no longer freezes on "Synthesizing answer". See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-17 · Wave IUX2 — envelope-repair loop keeps the seeded "Key Insights" entry in sync with a repaired `keyInsight` (it was dropped after the IUX1 body-suffix removal), via a function-scoped `seededKeyInsightText`. See [`docs/WAVES.md`](../WAVES.md).
- 2026-06-17 · Wave IUX1 — `formatAnswerFromEnvelope` no longer appends the `**Key insight:**` suffix (deduped: the key insight renders once, in the Key Insights section); `businessActions` domain-context cap 2500→6000; `context_trimmed` toast softened. See [`docs/WAVES.md`](../WAVES.md).
- PERF-10 (partial) — `turnColumnarStorage.ts` memoises ONE DuckDB handle per turn shared by all read-only analytical tools (`compute_growth`, `detect_seasonality`, `run_readonly_sql`, `run_analytical_query`, `execute_query_plan`, quick-answer); closed once by `runAgentTurn` at turn end. `add_computed_columns` (mutating DDL) keeps its own handle. Per-row coercion-into-DuckDB-types remainder staged.
