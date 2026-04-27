# Agent runtime

## Purpose

The engine every chat turn routes through when `AGENTIC_LOOP_ENABLED=true`.
Plans a sequence of tool calls, executes them with reflection between
steps, verifies the final answer, and streams SSE events to the client
workbench. When agentic is off, the legacy handler orchestrator takes
over — see "Legacy layer" below; the two layers have different
capabilities.

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

**Legacy layer**

- `server/lib/agents/orchestrator.ts` — `AgentOrchestrator.processQuery`.
- `server/lib/agents/index.ts` — dispatcher registering 7 handlers
  (Conversational, DataOps, MLModel, Statistical, Comparison,
  Correlation, General). Order matters. Carries a `DANGER — capability
  gap` banner at the top of the file.
- `server/lib/agents/handlers/**` — individual handlers.

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

- **`AgentTrace`** (`types.ts:205-225`) — the blob that ends up on the
  assistant message in Cosmos and is rendered by the client workbench.
  Already mirrored on both `schema.ts` files as
  `agentTrace: z.record(z.unknown()).optional()`.
- **`VerdictType`** (`types.ts:242-248`) — the verifier's possible
  outcomes: `"pass" | "revise_narrative" | "retry_tool" | "replan" |
  "ask_user" | "abort_partial"`. The zod enum in `schemas.ts:36-43`
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
  zod enum in `schemas.ts:36-43`, the `VERIFIER_VERDICT` constant, and
  the dispatch in `agentLoop.service.ts`. TypeScript will surface every
  missing branch.

## Known pitfalls

- **Legacy layer can't serve Phase-1 skills.** The handlers in
  `server/lib/agents/handlers/**` were frozen before
  `varianceDecomposer`, `driverDiscovery`, `insightExplorer`,
  `timeWindowDiff`, or dashboard autogen existed. Disabling
  `AGENTIC_LOOP_ENABLED` as a hotfix silently downgrades — questions
  that expect a skill fall through to `generalDataAnalysisAgent`. The
  banner on `server/lib/agents/index.ts` spells out the rule. Use
  `AGENT_TOOL_TIMEOUT_MS` or `AGENTIC_MAX_STEPS` instead.
- **Skill selection is priority-ordered (Wave F1).** Prior to F1 it was
  first-match-wins on load order, which let `varianceDecomposer` shadow
  `timeWindowDiff`. See [`skills.md`](./skills.md).
- **Tool / skill registry duplicate re-registration is fatal (Wave
  F2).** Boot-time registration is called exactly once per process; a
  duplicate name throws loudly. See [`tool-registry.md`](./tool-registry.md).

## Recent changes

- **Wave W16 · web-search hits surface in the W7 RAG bundle** —
  `DomainContextEntry["source"]` enum gains `"web"` alongside
  `rag_round1` / `rag_round2` / `injected`. The `web_search` tool now
  pushes successful hits to `ctx.exec.blackboard.domainContext` with
  `source: "web"` (in addition to its observation return). The W7
  `buildRagBlock` renders a third sub-section `# Web search context`
  for those entries; the section label flips to "RELATED CONTEXT
  (RAG / web)" and the narrator + synthesizer system prompts call
  out `[web:tavily:N]` tags as citable background — never numeric
  evidence. RAG cap bumped 4_000 → 6_000 chars to fit the third
  sub-section. Sub-section order is stable (round-1 → round-2 → web)
  so the prefix cache holds across calls.
- **Wave W15 · agent-path chart commentary** — extends W12's
  per-chart `businessCommentary` to the agentic correlation paths.
  `analyzeCorrelations` gains an optional
  `synthesisContext: ChartInsightSynthesisContext` parameter that
  flows through to `generateChartInsights`; the agent's
  `analyze_correlations` tool and the segment-driver-analysis tool
  both pass `ctx.exec.domainContext` (already populated upstream),
  so correlation/scatter charts emitted via the agent path now carry
  the same FMCG/Marico framing as charts enriched on the
  chatStream path. Back-compat: existing callers that omit the
  context still work and produce keyInsight-only output.
- **Wave W14 · `web_search` tool (env-gated, planner-callable)** —
  fills the last remaining "world wide web" gap from the original
  ask. New `lib/agents/runtime/tools/webSearchTool.ts` registers a
  `web_search` tool unconditionally so the planner sees it in the
  manifest, but real execution is double-gated: `WEB_SEARCH_ENABLED=true`
  AND a `TAVILY_API_KEY`. Disabled invocations return a clear no-op
  message so the planner learns to stop calling. Results format as
  `[web:tavily:N] Title\nContent\n— url` blocks identical to RAG
  formatting so synthesis treats them uniformly with the W7 RAG
  bundle. Capped at 5 hits × 1.5k chars (≤ 6k total). Failures are
  non-fatal. Provider is pluggable inside the tool file.
- **Wave W13 · investigation summary card** — `messageSchema`
  gains an optional `investigationSummary` field carrying a compact
  digest of the analytical blackboard: `hypotheses` (text + status +
  evidenceCount), `findings` (label + significance), `openQuestions`
  (question + priority). New
  `lib/agents/runtime/buildInvestigationSummary.ts` distils the
  full blackboard into the persistable shape (sorts findings by
  significance, filters actioned open questions, clips long text with
  ellipses). The agentic loop attaches it to `AgentLoopResult`,
  `dataAnalyzer.answerQuestion` propagates it, and both
  `chatStream.service.ts` + `chat.service.ts` persist it onto the
  assistant message. Client `InvestigationSummaryCard` renders at the
  top of the analytical body (default-open) with status pills,
  significance dots, and priority dots — surfacing *what was tested*,
  *what was found*, and *what remains open* before the user reads
  findings or pivots. Optional + back-compat — descriptive turns and
  legacy messages render as before.
- **Wave W12 · per-chart business commentary** — `chartSpecSchema`
  gains an optional `businessCommentary: z.string().max(500)` field.
  `generateChartInsights` now accepts a `domainContext` block on the
  synthesis context; when present it asks the LLM (same call as
  `keyInsight`, no extra LLM cost) to produce 1–2 sentences framing
  the chart's metric against the FMCG/Marico domain packs (cite the
  pack id verbatim, e.g. `kpi-and-metric-glossary`,
  `marico-haircare-portfolio`). The streaming chat path
  (`chatStream.service.ts`) loads the enabled packs once via
  `loadEnabledDomainContext` (process-cached) and threads the text
  into `enrichCharts → generateChartInsights`. Client `MessageBubble`
  renders the commentary directly under each chart card as a muted
  italic line ("Business context: …"). Field is optional and back-
  compat — legacy charts without it parse + render unchanged.
- **Wave W11 · workbench rendering + post-pivot interpretation panel** —
  `WorkbenchActivityRow` (in `client/src/pages/Home/Components/ThinkingPanel.tsx`)
  now renders `entry.insight` as an italic line on a left accent border
  directly beneath the title, so each step in the live thinking panel
  carries a "what this means" annotation. New
  `StepByStepInsightsPanel.tsx` mounts in `MessageBubble` after the
  auto-pivot block (and before the markdown / AnswerCard) for the final
  assistant message — a default-collapsed card listing every meaningful
  workbench entry with its insight, one per row, with a kind-specific
  icon. No-op `flow_decision` rows (no insight, no override, no reason)
  are filtered out so the panel stays signal-dense. Hidden entirely
  when no entry carries an insight (legacy turns).
- **Wave W10 · workbench-entry `insight` field** —
  `agentWorkbenchEntrySchema` gains an optional `insight: z.string().max(400)`
  field (back-compat: legacy Cosmos rows without it parse cleanly).
  `agentSseEventToWorkbenchEntries` now populates it deterministically
  per kind — first sentence of `rationale`/`summary`/`course_correction`,
  or a templated line built from `tool name + arg preview`,
  `from → to: intent`, etc. **Zero new LLM calls** — the helper is pure
  string manipulation. Sets the foundation for W11's per-step rendering
  in the workbench timeline and the post-pivot interpretation panel.
- **Wave W9 · AnswerCard renders W8 envelope sections** — the
  client-side `AnswerCard` (`client/src/pages/Home/Components/AnswerCard.tsx`)
  now renders three new sections from `message.answerEnvelope`:
  - `domainLens` as a muted "Industry context" preamble pill at the top
    (italic, with a `BookOpen` icon), so the FMCG/Marico framing is
    visible before the user reads the body.
  - `implications` as a numbered card list, each entry pairing the
    observed `statement` with a bold "**So what:**" `soWhat` line and a
    confidence pill (high → primary tone, medium → muted, low → muted).
  - `recommendations` grouped by horizon ("Do now", "This quarter",
    "Strategic", "Other"), each card containing an ordered list of
    `action — rationale` entries.
  Existing TL;DR / findings / methodology / caveats / next-steps blocks
  are unchanged. Semantic tokens only (`bg-card`, `bg-muted/30`,
  `bg-primary/10`, `text-foreground`, `text-muted-foreground`,
  `text-primary`); `npm run theme:check` clean.
- **Wave W8 · synthesis prompt overhaul + decision-grade envelope** —
  the narrator (`runNarrator`) and synthesizer
  (`synthesizeFinalAnswerEnvelope`) both now consume the W7
  context bundle (data understanding, user, RAG, FMCG/Marico packs)
  inside their user prompt. Length targets bumped from 250–600 → **600–
  1200 words** for analytical questions; narrator `maxTokens` 4000 →
  6000, synthesizer 2600 → 4500. `narratorOutputSchema` and the
  persisted `messageSchema.answerEnvelope` gain three optional fields:
  `implications` (statement → soWhat with confidence), `recommendations`
  (action + rationale + horizon), and `domainLens` (one-paragraph
  framing citing the domain pack id). The synthesizer branch now also
  builds an `answerEnvelope` so the AnswerCard renders the same shape
  regardless of which writer ran. `synthesis_result` telemetry adds
  `bodyWordCount`, `implicationsCount`, `recommendationsCount`,
  `domainLensLen` so we can verify post-rollout that the new sections
  are actually being produced.
- **Wave W7 · `buildSynthesisContext` shared bundle** — pure helper at
  `lib/agents/runtime/buildSynthesisContext.ts` composes four labelled
  blocks (data understanding, user context, RAG, FMCG/Marico domain
  packs) for consumption by both the narrator and the synthesizer.
  Pre-W7 the writers received only the raw `sessionAnalysisContext`
  JSON and never saw `ctx.domainContext` or upfront RAG hits; W7
  centralises the bundle so future signals (web search, etc.) wire
  into both writers in one place. `formatSynthesisContextBundle`
  emits markdown sections; empty signals collapse to "" so the prompt
  stays minimal. Caps (6k domain, 4k RAG, 20 column roles, 2k user
  notes) keep the user-message byte-stable for prompt-cache hits.
- **`user_context` RAG chunk + starter-question regeneration** —
  `ChatDocument.permanentContext` is now indexed as a `user_context`
  chunk (prepended in `buildChunksForSession`), so planner/reflector
  retrieval includes user-stated goals alongside data chunks. A new
  `regenerateStarterQuestionsLLM` helper in `sessionAnalysisContext.ts`
  is called from `updateSessionPermanentContext` to tailor the initial
  welcome message's `suggestedQuestions` to the user's context — but
  the initial seed (`seedSessionAnalysisContextLLM`) keeps its original
  signature and never waits on user input, so the welcome message is
  produced from dataset understanding alone. `mergeSuggestedQuestions`
  uses strict primary/fallback semantics: LLM-generated questions are
  returned as-is when non-empty; hardcoded column-name templates are
  used only when the LLM list is empty (skip/failure fallback).
- **Wave W6 · `appliedFilters` chips above chart cards** — both
  `messageSchema` and `chatResponseSchema` carry an optional
  `appliedFilters` array (mirror of `analysisBriefFilterSchema`).
  `AgentLoopResult.appliedFilters` is populated from
  `ctx.inferredFilters` via `appliedFiltersOut()` in
  `agentLoop.service.ts`, threaded through `dataAnalyzer.answerQuestion`,
  and saved onto the assistant message in both `chat.service.ts` and
  `chatStream.service.ts`. Client renders a `Filters applied: Category
  = Furniture` chip row above the charts tab in
  `AnalyticalDashboardResponse.tsx` using semantic tokens only
  (`bg-muted`, `border-border`, `text-muted-foreground`,
  `text-foreground`).
- **Wave W5 · contains filter now LIKE-compiled, no more silent drop** —
  `queryPlanDuckdbExecutor.buildWhereClause` previously short-circuited
  with empty SQL when any `dimensionFilter.match === "contains"`,
  silently dropping the entire plan; `canExecuteQueryPlanOnDuckDb`
  forced the whole query off the DuckDB path for the same reason. Both
  are fixed: `contains` filters now compile to
  `LOWER(TRIM(CAST(col AS VARCHAR))) LIKE '%v%' ESCAPE '\\'` with
  proper `% _` escaping, multiple values OR together, and `not_in`
  inverts to `NOT (...)`. `case_insensitive` / `exact` SQL is
  unchanged.
- **Wave W4 · inferred-filter plan enforcement** —
  `ensureInferredFiltersOnStep` (in `planArgRepairs.ts`) auto-injects
  any missing inferred filter into `execute_query_plan.plan.dimensionFilters`
  and the top-level `dimensionFilters` arg on `run_correlation`,
  `run_segment_driver_analysis`, `breakdown_ranking`, and
  `run_two_segment_compare`. The planner runs this repair in the same
  loop as the existing `repairExecuteQueryPlanDimensionFilters` pass.
  Backstop: `checkInferredFilterFidelity` (pure helper in
  `verifierHelpers.ts`) emits `MISSING_INFERRED_FILTER` with verdict
  `replan` when the plan still doesn't reference an inferred column
  after repair — wired into both per-step and final `runVerifier`
  invocations in `agentLoop.service.ts` via the new `planSteps`
  parameter.
- **Wave W3 · inferred filters wired to planner + analysis brief** —
  `buildAgentExecutionContext` now runs `inferFiltersFromQuestion`
  once per turn and stashes the result on `ctx.inferredFilters`.
  `summarizeContextForPrompt` surfaces an `INFERRED_FILTERS_JSON`
  block to the planner; `maybeRunAnalysisBrief` forwards the same
  signal to the brief LLM and `mergeInferredFiltersIntoBrief` unions
  any inferred filters the brief LLM dropped back into
  `ctx.analysisBrief.filters`.
- **Wave W2 · categoricalValues in planner prompt** —
  `summarizeContextForPrompt` now emits a bounded
  `categoricalValues:` block (≤ 8 values per column, ≤ 2000 chars
  total, skipping numeric/date columns and those without
  `topValues`). Teaches the planner upfront which tokens exist as
  segment values, so bare qualifiers like "furniture" can be bound to
  `dimensionFilters` on the first planning pass without requiring a
  separate `get_schema_summary` tool call.
- **Wave W1 · `inferFiltersFromQuestion`** — new pure helper at
  `server/lib/agents/utils/inferFiltersFromQuestion.ts` that
  deterministically resolves 1–3-word candidates from the user
  question against `DataSummary.topValues` / `sampleValues` using the
  existing `findUniqueValueColumnMatch`. Returns ready-to-use
  `InferredFilter[]` (column / op: "in" / canonical values / match
  mode / matched tokens). First half of the fix for the bug where
  pointed qualifiers ("furniture sales by region") were dropped
  because the planner never saw categorical values upfront and no
  pre-planner pass resolved bare tokens to column filters.
- **Wave F6** — documented the capability gap between the legacy
  orchestrator and the agentic runtime; added a `DANGER — capability
  gap` banner at the top of `server/lib/agents/index.ts` spelling out
  the hotfix knobs to use instead of disabling
  `AGENTIC_LOOP_ENABLED`.
- **Wave F3** — verdict string literals replaced with the exported
  `VERIFIER_VERDICT` constant from `runtime/schemas.ts`. One source of
  truth for the enum tuple; typos in `agentLoop.service.ts` or
  `verifier.ts` are now compile errors, not silently-missed retry
  branches.
- Initial seed of this doc — captures the runtime as of the
  `claude/add-claude-documentation-PaA9h` branch.
