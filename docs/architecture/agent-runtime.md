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

- **Wave W45 · CI workflow YAML for live-LLM golden replay** —
  pre-W45 the W28 + W33 harness existed but only ran when an
  operator manually invoked it. New
  `.github/workflows/live-llm-replay.yml` runs the harness on a
  weekly schedule (Mondays 08:00 UTC) and via `workflow_dispatch`.
  Required secrets: `AZURE_OPENAI_API_KEY`,
  `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT_NAME`. Optional:
  `TAVILY_API_KEY` for fixtures that exercise web search.
  `concurrency: live-llm-replay` group so newer runs cancel older
  queued ones — bounds cost. The `recording_mode` workflow input
  triggers W33 baseline capture and uploads
  `<id>.recorded.json` files as a 30-day artifact. Failures emit
  notifications but do NOT block `main` merges (this workflow
  doesn't gate branch protection). Cost: ~$3/run × weekly = ~$12/mo.
- **Wave W44 · clickable recommendation actions** — pre-W44 the W9
  `recommendations` rendered as static text, forcing users to retype
  each action as a follow-up question. Each recommendation now has a
  small "Try this →" ghost button rendered only when
  `onSuggestedQuestionClick` is wired (matches the existing
  `nextSteps` pattern). Click spawns a new chat turn with a
  templated prompt: `"Help me with: <action>. Specifically:
  <rationale>. Show me the relevant analysis."` Pure additive UI;
  legacy renders are unchanged when the prop is absent. Semantic
  tokens only; theme:check clean.
- **Wave W43 · batched repair issues** — pre-W43 a draft missing
  implications + citing a fake pack id + with a fabricated magnitude
  triggered THREE separate narrator repair calls (~6000 tokens
  each). Now W17/W22/W35 gaps are collected into a single composite
  course correction and ONE narrator call addresses all of them.
  Behaviour-equivalent on single-issue cases (composite is the one
  issue without numbering). The completeness short-circuit is
  preserved — when completeness fails, citation/magnitudes still
  skip (avoid noise), only completeness fires. When completeness
  passes, citation AND magnitudes can BOTH fire and batch into the
  same round. New `flow_decision` SSE layer
  `envelope-multi-issue` for workbench timeline visibility on
  multi-issue rounds. Telemetry: `envelope_repair` log line gains
  comma-joined `codes` and `issueCount` fields.
- **Wave W42 · streaming preview UX surface** — pairs with W41 to
  finally make the W38 streaming feature visible to users. New
  `client/src/pages/Home/Components/StreamingPreviewCard.tsx`
  renders the W38 `streamingNarratorPreview` text (cleaned by W41)
  as a live "Drafting answer…" card with a pulsing icon. Three
  independent guards keep it hidden when not streaming: `isPending`
  must be true, preview text must be non-empty, and the server must
  be emitting `answer_chunk` events at all.
  `streamingNarratorPreview` lifted into Home.tsx and threaded
  through ChatInterface to the last-message slot. Semantic tokens
  only (`bg-muted/30`, `text-foreground`, `text-muted-foreground`,
  `bg-primary/10`, `text-primary`); theme:check clean.
- **Wave W41 · streaming narrator `body`-field extraction** — closes
  the W38 "shipped-but-unusable" gap. New
  `lib/agents/runtime/jsonFieldStreamExtractor.ts` is a pure state
  machine that consumes streaming JSON chunks and emits ONLY the
  decoded text content of a single named string field (`body`).
  Decodes JSON escapes (`\\\"`, `\\n`, `\\t`, `\\\\`) to plain text;
  passes `\\uXXXX` through as raw 6 chars (rare in narrator output;
  decode in a follow-up wave). The agent loop's narrator hook now
  runs each delta through the extractor, so the client receives
  clean readable prose via `answer_chunk` SSE events instead of raw
  JSON tokens. Robustness contract: extractor NEVER throws — every
  malformed-input case stays silent or transitions to `done`. The
  W38 schema-validation fallback at end-of-stream is the
  authoritative correctness gate; extraction is best-effort UX.
- **Wave W40 · per-session mutex on `persistMergeAssistantSessionContext`** —
  closes the race-condition edge case identified in the audit.
  Pre-W40, two concurrent turns on the same session (e.g. duplicated
  tab firing two requests) both read the same `priorInvestigations`
  base, both appended their digest, and the `containerInstance.items.upsert`
  was last-write-wins — so the first turn's append silently
  vanished. New module-scope `sessionPersistChain: Map<sessionId, Promise>`
  serialises calls per-session: each new persist awaits any
  in-flight one before running its own read-modify-write.
  Single-instance correctness only — multi-instance horizontal
  scaling would need Cosmos `ifMatch` ETag or external lock; per
  CLAUDE.md the deploy is single-instance, so the in-process mutex
  is the right minimal fix. The map self-cleans on completion to
  avoid unbounded growth.
- **Wave W39 · merged hypothesis + analysis-brief LLM call (env-
  gated)** — pre-W39 a typical analytical turn fired TWO sequential
  pre-planner LLM calls: `generateHypotheses` (always) +
  `maybeRunAnalysisBrief` (when diagnostic-intent). Both consume the
  same dataset summary + question. New
  `lib/agents/runtime/runHypothesisAndBrief.ts` merges them into a
  single LLM call with a unified schema
  `{ hypotheses, brief: AnalysisBrief | null }`. Cuts ~one network
  round-trip + 30–40% of pre-planner tokens per analytical turn.
  Falls back to per-task calls on any failure (parse, schema,
  network) so the merged option is strictly safer than the per-task
  path. Reuses the existing `analysisBriefSchema` + the original
  hypothesis shape — no schema divergence. Gated by
  `MERGED_PRE_PLANNER=true` (default off — opt-in for A/B).
  `shouldBuildAnalysisBrief` exported from `analysisBrief.ts` so the
  merged path applies the same gating logic.
- **Wave W38 · streaming narrator output** — new
  `completeJsonStreaming` in `lib/agents/runtime/llmJson.ts` calls
  `openai.chat.completions.create({stream: true})` directly,
  accumulates each chunk's delta, validates against the Zod schema
  at the end, and falls back to non-streaming `completeJson` on ANY
  failure (network, parse, schema). Double-gated by
  `STREAMING_NARRATOR_ENABLED=true` AND non-Anthropic model (the
  Anthropic adapter doesn't yet expose a streaming surface).
  `runNarrator` accepts an optional `streaming` hook; the agent
  loop wires it to `safeEmit("answer_chunk", { delta })` for the
  initial narrator call only — repair calls (W17/W22) stay non-
  streaming so the user doesn't see the answer thrash. Client
  `useHomeMutations` accumulates deltas into a new
  `streamingNarratorPreview` state surfaced via the hook return so
  future UX can render a live "drafting answer…" preview. Reset on
  each new turn. Default off; opt-in until UX surface lands.
- **Wave W37 · per-message PriorInvestigationsBanner (W30 UI
  surface)** — closes the half-built W30 promise. `PriorInvestigationsBanner`
  refactored to accept EITHER `sessionAnalysisContext` (W26 mode —
  live current state at top of chat) OR `priorInvestigations`
  (W37 mode — historical snapshot from a single message). Header
  label adapts: "What we already learned in this session" vs.
  "What we knew at the time of this turn". Mounted inside
  `MessageBubble.tsx` directly under the W13 InvestigationSummaryCard
  for analytical assistant messages where
  `priorInvestigationsSnapshot.length > 0`. Default-collapsed to
  stay subordinate to W13 and avoid noise. Legacy / chatty turns
  render unchanged.
- **Wave W36 · `web_search` hit URL-dedup** — closes the cleanup
  deferred from W16. Before adding new hits to the analytical
  blackboard, the tool now extracts URLs from existing
  `source: "web"` entries (via the new exported helper
  `extractUrlsFromFormattedHits`) and filters new hits whose URL
  already appears. Avoids the case where the planner fires two
  similar queries and the W7 ragBlock carries the same hit twice
  (wastes tokens, confuses the synthesizer). When ALL new hits are
  duplicates, returns a clear `web_search.all_dup` log line and a
  short observation message so the planner learns. Telemetry now
  reports `dropped` count alongside `hitCount`.
- **Wave W35 · `magnitudes` numerical fabrication check** — new
  `checkMagnitudesAgainstObservations` extracts every numeric token
  from each magnitude's `value` (and `label` as fallback) and
  confirms each appears within ±2% in the supplied evidence pool:
  tool observations, the W7 RAG block, AND the composed
  FMCG/Marico domain context. Reuses W7.5's
  `extractNumbersFromNarrative` helper. Fires `revise_narrative`
  with code `FABRICATED_MAGNITUDES` when ≥2 magnitudes cite
  unsupported numbers (single-magnitude flag is rounding-artefact
  tolerance). Wired into the agent loop's repair block alongside
  W17/W22, sharing the same `maxVerifierRoundsFinal` budget. Pure
  deterministic check; zero new LLM calls.
- **Wave W34 · single-load domain context per turn** —
  `chat.service.ts` (non-streaming path) was loading
  `loadEnabledDomainContext` twice per turn — once for chart
  commentary (W23) and again for step-insight enrichment (W25). The
  loader is process-memoised so the cached text is fetched in O(1),
  but the dynamic `await import(...)` chain ran twice. Hoisted the
  load to a single per-turn `perTurnDomainContext` variable that
  both consumers reuse. `chatStream.service.ts` was already correct
  (one load, two consumers) — no change needed there. Pure
  refactor; zero runtime behaviour change.
- **Wave W33 · W28 fixture expansion + recording mode** — added two
  new fixtures: `q04-citation-check.json` exercises the W22 `domainLens`
  citation gate (asserts the LLM cites a real pack id via regex);
  `q05-conversational.json` exercises the W17 completeness-bypass
  path for descriptive turns. Per-fixture optional flags
  (`expectDomainLensCitesPackId`, `knownPackIdRegex`,
  `expectCompletenessGateBypassed`) drive the new assertions only
  for fixtures that opt in. New `RECORD_LIVE_LLM_BASELINE=true` mode
  (gated behind `LIVE_LLM_REPLAY=true`) dumps each fixture's full
  result envelope to `<id>.recorded.json` (gitignored) so operators
  can inspect what the LLM actually produces and inform tighter
  assertions later. New
  `tests/fixtures/golden-replay/README.md` documents the workflow.
  All in-CI tests still skip trivially without the env gate;
  `.env.example` documents the new flag.
- **Wave W32 · `chatStream.service.ts` schema mismatches** —
  knocked typecheck noise from **91 → 89 errors** (-2) by fixing the
  two real type mismatches flagged in W27 as "scoped investigation
  needed." Line 205: `PastAnalysisDoc` literal now supplies
  `feedbackReasons: []` explicitly — matches what the schema's
  `.default([])` would produce, and is identical to the runtime path
  the model's patch helper (`pastAnalysis.model.ts:persistFeedbackReasons`)
  expects to mutate later. Line 804: `parseUserQuery` return value
  cast `as unknown as Record<string, unknown>` at the assignment site
  (matches W27's `agentTrace` cast pattern). Tried widening
  `parsedQueryForLoad`'s declaration to `QueryParserResult | null`
  first but that cascaded errors at four downstream consumers also
  expecting the generic record shape; cast is the cleanest minimum-
  diff fix. `QueryParserResult` is now exported from
  `lib/queryParser.ts` for any future caller that wants the precise
  type. Zero runtime change.
- **Wave W31 · real-time refresh of W26 banner via SSE** —
  `persistMergeAssistantSessionContext` now returns the new
  `SessionAnalysisContext` (or `undefined` when the chat doc is
  missing); existing void-returning callers ignore the return value
  forward-compatibly. After the persist succeeds in
  `chatStream.service.ts`, the streaming code emits a new
  `session_context_updated` SSE event carrying the updated
  `priorInvestigations` array. Client `useHomeMutations` handles the
  event by calling the lifted `setSessionAnalysisContext` setter
  passed in from `Home.tsx`, which causes the W26
  `PriorInvestigationsBanner` to re-render with the new state — no
  page reload. Old clients ignore the unknown event; old servers
  leave the banner stale (today's behaviour exactly).
- **Wave W30 · per-turn `priorInvestigationsSnapshot` on the
  message** — refactored the W21 `priorInvestigations` per-entry
  shape into a canonical `priorInvestigationItemSchema` defined in
  `shared/schema.ts` and re-exported from
  `lib/agents/runtime/priorInvestigations.ts` (avoids the
  schema-imports-lib circular). Reused by both
  `sessionAnalysisContextSchema.sessionKnowledge.priorInvestigations`
  (live array) AND the new optional `messageSchema.priorInvestigationsSnapshot`
  field — single source of truth, no schema drift. Both
  `chatStream.service.ts` and `chat.service.ts` snapshot the
  in-memory `chatDocument.sessionAnalysisContext` array BEFORE
  `persistMergeAssistantSessionContext` runs (where the W21 append
  fires), so the snapshot represents what the agent knew at the
  start of THIS turn — distinct from the live current-state array.
  Optional + back-compat: legacy messages parse cleanly. No client
  UI surface this wave; per-message rendering is a future UX wave.
- **Wave W29 · `uploadQueue.ts` typecheck cleanup** — knocked
  pre-existing typecheck noise from **127 → 91 errors** (-36) with
  two surgical zero-runtime-change fixes: `let data:
  Record<string, any>[];` initialised to `[]` (production-proven
  safe — every reachable path assigns before reading; empty default
  is a no-op), and `enrichmentStatus: 'value'` literals annotated
  with `as const` so they satisfy the narrow union `"pending" |
  "complete" | "in_progress" | "failed"` on `ChatDocument`. All 39
  upload-related tests still pass; runtime semantics unchanged.
- **Wave W28 · live-LLM golden replay (env-gated)** — new
  `tests/liveLlmGoldenReplayW28.test.ts` runs the real agent
  pipeline against three curated FMCG fixtures
  (`tests/fixtures/golden-replay/q01..q03.json`) and asserts SHAPE
  only — minBodyChars, populated envelope fields, investigation
  summary present — never exact text. Catches prompt-quality drift
  that mock-only tests (W18/W20/W24) cannot. Double-gated by
  `LIVE_LLM_REPLAY=true` AND `AZURE_OPENAI_API_KEY`. With either
  unset, the test is a single trivially-passing skip. Cost ~$3 /
  replay run; intended for nightly CI or pre-release smoke, never
  per-commit. Per-fixture timeout 90s. Documented in
  `server/.env.example`.
- **Wave W27 · typecheck cleanup (low-risk only)** — knocked
  pre-existing typecheck noise from 127 → 116 errors with four
  surgical fixes that change zero runtime semantics: `pivotDefaultsFromPreview.ts`
  import path was off by one segment; `chatStream.service.ts`
  callback params (`onMidTurnSessionContext`, `onIntermediateArtifact`)
  gained explicit annotations; `chat.service.ts` `agentTrace` cast
  matches the streaming-path pattern; `req.on(...)` calls are now
  cast through `IncomingMessage` so tsc resolves the listener API.
  Higher-risk errors (`uploadQueue.ts` use-before-assign,
  `chatStream.service.ts` schema mismatches) deferred to scoped
  investigation. 130 wave-related tests still pass.
- **Wave W26 · PriorInvestigationsBanner UI** — surfaces the W21
  `priorInvestigations` digest as a collapsed pill above the chat
  message list ("📚 N earlier turns" with confirmed/refuted/open
  totals). When expanded, lists each prior turn with its question,
  headline finding, and per-status hypotheses (✓ confirmed, ✗
  refuted, ◯ open). Hidden when the array is empty so legacy chats
  are unchanged. The session's `sessionAnalysisContext` is now lifted
  into Home.tsx via an optional `setSessionAnalysisContext` callback
  on `useSessionLoader`. Semantic tokens only (`bg-card`,
  `bg-muted/30`, `bg-primary/10`, `text-foreground`,
  `text-muted-foreground`, `text-primary`, `border-border`).
  `npm run theme:check` clean.
- **Wave W25 · chat.service workbench parity** — the non-streaming
  code path now installs the same workbench accumulator as
  `chatStream.service.ts`: `agentSseEventToWorkbenchEntries` +
  `appendWorkbenchEntry` listening on `agentOpts.onAgentEvent`. The
  W25 wave also runs `enrichStepInsights` on the accumulated workbench
  (env-gated `RICH_STEP_INSIGHTS_ENABLED`, same as streaming) and
  persists the array onto the assistant message via
  `addMessagesBySessionId`. Failures are non-fatal — a misbehaving
  accumulator can't break the turn (`safeEmit` swallows handler
  errors). Closes the W10/W19 parity gap so non-streaming responses
  carry per-step insights too.
- **Wave W24 · multi-turn e2e — proves W21 carry-over** — new
  `tests/agentTurnMultiTurnE2EW24.test.ts` runs two consecutive
  `runAgentTurn` calls and asserts that turn 2's planner user prompt
  receives the labelled `PRIOR_INVESTIGATIONS` block built from turn
  1's investigation summary, including turn-1's question text and at
  least one hypothesis text echoed verbatim. No Cosmos: between
  turns the test applies `buildPriorInvestigationDigest` +
  `appendPriorInvestigation` in-process — the same operations
  `persistMergeAssistantSessionContext` performs sans I/O. Pure
  test; zero production-runtime change.
- **Wave W23 · chat.service parity for W12 chart commentary** —
  the non-streaming `chat.service.ts` now loads enabled FMCG/Marico
  domain packs and threads them through `enrichCharts` so chart
  `businessCommentary` lights up on this code path too. Closes the
  W12 gap (only the streaming path was wired before). The
  non-streaming path doesn't accumulate a workbench, so W19 per-step
  enrichment doesn't apply there — this wave only addresses chart
  parity.
- **Wave W22 · domainLens citation anti-hallucination check** — new
  pure helper `checkDomainLensCitations` extracts backtick-quoted
  pack-id-shaped tokens from `envelope.domainLens` and verifies each
  was actually present in the supplied domain context. Pack ids are
  pulled deterministically from the `<<DOMAIN PACK: id>>` markers in
  `ctx.domainContext` via `extractSuppliedPackIds` (no loader I/O).
  When the LLM cites an id it was never given (hallucination), the
  agent loop runs the same `NarratorRepairContext` flow as W17, with
  a course correction listing the legit pack ids. Shares the same
  `maxVerifierRoundsFinal` budget so completeness + citation issues
  alternating across rounds remain bounded. Heuristic guards against
  false positives: only kebab-case backtick tokens (≥5 chars, ≥1
  hyphen) are treated as candidate pack-id citations.
- **Wave W21 · prior-turn investigation carry-over** — the agent now
  builds knowledge across turns instead of starting fresh.
  `sessionAnalysisContext.sessionKnowledge` gains an optional
  `priorInvestigations` array carrying compact digests of recent turns
  (question + hypotheses confirmed/refuted/open + headline finding,
  capped at 5 entries with FIFO eviction). New
  `lib/agents/runtime/priorInvestigations.ts` distils a turn's W13
  investigation summary into the digest shape and renders the array
  as a labelled `PRIOR_INVESTIGATIONS` block emitted from
  `formatUserAndSessionJsonBlocks` so the planner sees it as a
  first-class signal, not buried in the session-context JSON dump.
  `persistMergeAssistantSessionContext` now accepts the turn's
  question + investigationSummary and appends the digest after the
  LLM merge runs. Wired in both `chatStream.service.ts` and
  `chat.service.ts`. Backwards-compatible: schema field is optional;
  legacy contexts without it parse cleanly. Block is byte-stable for
  prefix-cache friendliness.
- **Wave W20 · end-to-end agent turn smoke test** —
  `tests/agentTurnE2EW20.test.ts` runs `runAgentTurn` end-to-end
  against a 60-row Marico-shaped fixture with every LLM call stubbed
  via the W18 harness. Asserts the *combined* shape that waves
  W7–W19 produce: answer body length, decision-grade envelope
  (≥2 implications + ≥2 recommendations + domainLens citing the pack
  id), investigation summary (hypotheses + findings), magnitudes,
  trace shape. Failure here = regression in any of those waves.
  Drove out two latent bugs: `appendEnvelopeInsight` was re-exported
  but never imported into `agentLoop.service.ts` (the synthesis catch
  swallowed the `ReferenceError`); `cache.ts`'s 5-minute cleanup
  `setInterval` was not `.unref()`'d, holding the event loop open in
  tests. Both fixed in this wave.
- **Wave W19 · per-step LLM-enriched insights (env-gated)** — new
  `lib/agents/runtime/enrichStepInsights.ts` is a single-batched LLM
  call (cheap insight model) that ties each meaningful workbench step
  to the analysis arc — 1–2 sentences per step on top of the W10
  deterministic insight, citing the FMCG/Marico pack id when
  relevant. Mutates the workbench in place; deterministic insights
  stay as the fallback for entries the LLM omits or when the call
  fails. Wired in `chatStream.service.ts` after chart enrichment;
  emits a final `workbench_enriched` SSE event so the client live-
  refreshes the StepByStepInsightsPanel via `useHomeMutations`.
  Gated by `RICH_STEP_INSIGHTS_ENABLED=true` (default off — opt-in
  due to ~2–5s latency). Also: `llmJson.completeJson` now forwards
  `purpose` to `callLlm` so the W18 stub resolver fires for tests
  (cost: one idempotent re-resolve per attempt — negligible).
- **Wave W18 · LLM stub harness for tests** — `callLlm` gains a tiny
  optional resolver hook (`__setLlmStubResolver`) gated by a nullable
  pointer check. Production never sets it; tests install a stub via
  `installLlmStub({ [purpose]: handler })`. Default handlers cover
  every member of `LLM_PURPOSE` with a minimum-valid response so
  unstubbed purposes don't crash the pipeline. Foundation for W19
  per-step insight tests and W20 e2e smoke. Production cost: zero
  (one nullable pointer check per call).
- **Wave W17 · verifier requires decision-grade sections** — new
  pure helper `lib/agents/runtime/checkEnvelopeCompleteness.ts` is a
  deterministic pre-LLM gate that returns `{ ok: false,
  MISSING_DECISION_GRADE_SECTIONS, courseCorrection }` when an
  analytical narrator envelope is missing implications (≥2),
  recommendations (≥2), or `domainLens` (when domain context was
  supplied). The agent loop runs this check between synthesis and the
  deep verifier, and on failure re-runs `runNarrator` with a
  `NarratorRepairContext` (issues + course correction + prior draft)
  for up to `config.maxVerifierRoundsFinal` rounds. This is
  intentionally separate from the deep verifier's single-flow policy
  (which suppresses LLM-judged narrative rewrites): completeness
  here is objective, not opinion. Conversational turns
  (`questionShape` undefined) skip the check; fallback path (no
  envelope) skips too. Telemetry: `envelope_repair` agent log on each
  retry; `flow_decision` SSE event for the workbench timeline.
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
