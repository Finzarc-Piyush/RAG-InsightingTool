# CLAUDE.md — the holy bible of this codebase

> **Last updated:** 2026-04-30 · **Status:** reflects HEAD (post-Waves DWD1 + DWD2/A/B/C — top-left "Download Dataset" button + `GET /api/data-ops/download-working/:sessionId` (xlsx default, `?format=csv` opt-in, auto-switches to CSV at >900k rows, `X-Working-Dataset-Row-Count` exposed); `parseFlexibleDate` now resolves wide-format calendar PeriodIso labels (`2024-Q1`, `2024-Wnn`, `MAT-YYYY-MM`, `WE-YYYY-MM-DD`, …) so `applyTemporalFacetColumns` produces non-null `Year ·` / `Quarter ·` / `Month ·` buckets on the calendar rows that previously came back empty).
> **Maintenance contract:** when you change anything described in this file, bump the date above, add a one-line entry to the [Changelog](#changelog) at the bottom, and only describe behaviour you have **verified against the live tree** — not what was planned. The previous version drifted because nobody re-checked when whole subsystems were deleted; treat that as the lesson.

This file is the canonical orientation for Claude Code (claude.ai/code) and any human or agent landing in the repo. It tells you what the product is, how the code is laid out, how a chat turn flows end-to-end, what every major subsystem does, and where the gotchas live. Sub-docs in [`docs/`](docs/) go deeper on individual subsystems — this file points to them rather than duplicating their content.

---

## Table of contents

1. [What this product is](#what-this-product-is)
2. [Workflow rules for Claude](#workflow-rules-for-claude) — plan-mode, subagents, lessons, verification, elegance, bug-fixing
3. [Working cadence — tiny waves](#working-cadence--tiny-waves)
4. [Repository layout](#repository-layout)
5. [Dev loop, env files, build, test](#dev-loop-env-files-build-test)
6. [Architecture — end-to-end data flow](#architecture--end-to-end-data-flow)
7. [Server reference](#server-reference) — routes, controllers, services, lib, models
8. [Agent runtime — the heart of the system](#agent-runtime--the-heart-of-the-system)
9. [Tool registry](#tool-registry)
10. [Skills (Phase-1 analytical competencies)](#skills-phase-1-analytical-competencies)
11. [MMM pipeline (Marketing Mix Modeling)](#mmm-pipeline-marketing-mix-modeling)
12. [RAG / retrieval](#rag--retrieval)
13. [Wide-format ingestion](#wide-format-ingestion)
14. [Domain context system](#domain-context-system)
15. [Charting (v1 + the v2 overhaul)](#charting-v1--the-v2-overhaul)
16. [Client reference](#client-reference) — routing, Home page, pivot, dashboard
17. [Deployment + CI](#deployment--ci)
18. [Conventions that bite](#conventions-that-bite)
19. [Where to look in `docs/`](#where-to-look-in-docs)
20. [Changelog](#changelog)

---

## What this product is

A multi-tenant analytical chat tool for Marico (FMCG / haircare) and adjacent enterprise data work. The user uploads a dataset (CSV / Excel / Snowflake import), the system enriches it with an LLM-driven profile and domain context, and then answers analytical questions in chat through an **agentic plan/act loop** that uses RAG over the session, calls structured tools (DuckDB queries, correlation, segment-driver analysis, MMM optimiser, web search, etc.), and synthesises a decision-grade answer envelope (TL;DR, findings, implications grouped by horizon, magnitudes, methodology, caveats). Charts and dashboards are first-class outputs, not afterthoughts.

The agentic loop is **mandatory** — the older handler-based orchestrator was removed in commit `9422bed7` (2026-04-26). RAG is a hard prerequisite at startup unless explicitly bypassed for tests.

---

## Workflow rules for Claude

These are rules for the assistant, not codebase facts.

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions).
- If something goes sideways, STOP and re-plan immediately.
- Use plan mode for verification steps, not just building.
- Write detailed specs upfront to reduce ambiguity.

### 2. Subagent Strategy
- Use subagents liberally to keep the main context window clean.
- Offload research, exploration, and parallel analysis to subagents.
- For complex problems, throw more compute at it via subagents.
- One task per subagent for focused execution.

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern.
- Write rules for yourself that prevent the same mistake.
- Ruthlessly iterate on these lessons until mistake rate drops.
- Review lessons at session start for relevant project.

### 4. Verification Before Done
- Never mark a task complete without proving it works.
- Diff behavior between main and your changes when relevant.
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness.

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution".
- Skip this for simple, obvious fixes -- don't over-engineer.
- Challenge your own work before presenting it.

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding.
- Point at logs, errors, failing tests -- then resolve them.
- Zero context switching required from the user.
- Go fix failing CI tests without being told how.

### Task management
1. Plan first → `tasks/todo.md` with checkable items.
2. Verify the plan before starting implementation.
3. Mark items complete as you go.
4. High-level summary at each step.
5. Add a review section to `tasks/todo.md`.
6. Update `tasks/lessons.md` after corrections.

### Core principles
- **Simplicity first** — make every change as simple as possible. Impact minimal code.
- **No laziness** — find root causes. No temporary fixes. Senior-developer standards.
- **Minimal impact** — only touch what's necessary. No side effects with new bugs.

---

## Working cadence — tiny waves

Every unit of work — audit fix, feature wave, refactor — is sized to **one file class** (pure fn OR schema mirror OR one route OR one UI component OR one polish fix) plus its test plus one doc line. Target ~100–200 LOC per wave, reviewable in under 30 minutes, shippable in a single session. Planning documents (under `docs/plans/` or `/root/.claude/plans/`) express the full feature as a dependency graph of tiny waves; each wave ships on its own commit with a subject line `Wave W<n> · <subject>`. **HEAD is currently at W55** — the MMM feature stream (W46–W55) is the most recent multi-wave effort.

The cadence exists to combat rate limits and idle timeouts on long agent sessions, and to keep diffs reviewable. Never bundle unrelated concerns inside a wave; split waves by file class (pure fn → schema → python → TS shim → wiring → UI → polish).

When a request spans more than one wave, plan explicitly: list the waves, mark dependencies, ship in order, update `docs/architecture/*.md` "Recent changes" per wave.

---

## Repository layout

Monorepo with three deployable services. **No top-level `package.json`** — each service has its own dependencies and is run from its own directory.

| Directory | Runtime | Default port | Purpose |
|-----------|---------|-------------:|---------|
| [`client/`](client/) | Vite + React 18 + TS (ESM) | 3000 | SPA; Azure MSAL auth; `wouter` routing; Tailwind + Radix UI; TanStack Query |
| [`server/`](server/) | Node 20 + Express + TS via `tsx` (ESM) | 3002 | REST + SSE API, agentic chat orchestration, RAG, file parsing, DuckDB query execution |
| [`python-service/`](python-service/) | FastAPI + Uvicorn | 8001 | Data operations (pandas / sklearn): preview, transforms, ML training, MMM optimiser |
| [`api/`](api/) | Vercel serverless wrappers | — | `api/index.ts` wraps `server/createApp()`; `api/data-ops/index.py` wraps `python-service/main.py` |
| [`docs/`](docs/) | — | — | Architecture and plans; **start here** before changing major subsystems |

---

## Dev loop, env files, build, test

### Dev loop

Three terminals — order matters because the Node API touches Python at boot for some ops:

```bash
# Terminal 1: Python data-ops + MMM optimiser
cd python-service && python3 main.py            # uvicorn on :8001

# Terminal 2: Node API
cd server && npm run dev                         # tsx :3002

# Terminal 3: Vite client
cd client && npm run dev                         # :3000 (proxies /api → :3002)
```

When the user says **"restart servers"** (plural / "all"), kill PIDs on **8001, 3002, 3000** then start all three in order. This is enforced by [`.cursor/rules/restart-servers.mdc`](.cursor/rules/restart-servers.mdc). If they ask to restart a single service, only restart that one.

### Environment files (non-standard names — neither tooling auto-loads them)

- [`server/server.env`](server/.env.example) — loaded by [`server/loadEnv.ts`](server/loadEnv.ts), which **must be the first import** in [`server/index.ts`](server/index.ts). See `server/.env.example` for the full list.
- [`client/client.env`](client/client.env.example) — loaded manually in [`client/vite.config.ts`](client/vite.config.ts) via `dotenv` before `loadEnv()`, because Vite only auto-reads `.env*` names.

**Critical flags, grouped by purpose:**

- **Agentic loop (mandatory):** `AGENTIC_LOOP_ENABLED=true` is **required** — `dataAnalyzer.answerQuestion` throws if false. Requires `RAG_ENABLED=true` + `AZURE_SEARCH_*`; [`assertAgenticRagConfiguration`](server/lib/agents/runtime/assertAgenticRag.ts) enforces this in `createApp()`. Tests / local can bypass with `AGENTIC_ALLOW_NO_RAG=true`.
- **Agent budgets:** `AGENT_MAX_STEPS` (30), `AGENT_MAX_WALL_MS` (600 000), `AGENT_MAX_TOOL_CALLS` (60), `AGENT_MAX_LLM_CALLS`, `AGENT_MAX_VERIFIER_ROUNDS_STEP` (2), `AGENT_MAX_VERIFIER_ROUNDS_FINAL` (2), `AGENT_OBSERVATION_MAX_CHARS` (8 000), `AGENT_SAMPLE_ROWS_CAP` (200), `AGENT_TOOL_TIMEOUT_MS`, `AGENT_TRACE_MAX_BYTES`. Tracing: `AGENT_INTER_AGENT_MESSAGES`, `AGENT_INTER_AGENT_PROMPT_FEEDBACK`, `AGENT_SSE_CRITIC_FINAL_ONLY`. Mid-turn context: `AGENT_MID_TURN_CONTEXT`, `AGENT_MID_TURN_CONTEXT_THROTTLE_MS`. Visual planner: `AGENT_MAX_EXTRA_CHARTS_PER_TURN`.
- **LLM routing (Claude Opus 4.7 ↔ Azure OpenAI):** `ANTHROPIC_API_KEY` plus `OPENAI_MODEL_FOR_NARRATOR`, `OPENAI_MODEL_FOR_VERIFIER_DEEP`, `OPENAI_MODEL_FOR_COORDINATOR`, `OPENAI_MODEL_FOR_HYPOTHESIS` route specific roles to Anthropic. Falls back to Azure OpenAI (`AZURE_OPENAI_*`) when the key is missing.
- **RAG (mandatory when agentic is on):** `RAG_ENABLED`, `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_ADMIN_KEY`, `RAG_TOP_K`. Embeddings: `AZURE_OPENAI_EMBEDDING_ENDPOINT`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME`, `AZURE_OPENAI_EMBEDDING_DIMENSIONS`.
- **Auth:** `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `DISABLE_AUTH`, `AUTH_BYPASS_DEV_TOKEN`, `TRUST_PROXY`, `FRONTEND_URL`, `ALLOWED_ORIGINS`.
- **Python bridge:** `PYTHON_SERVICE_URL=http://localhost:8001`. **`PYTHON_SERVICE_API_KEY` is required in production** (P-037).
- **Feature flags:** `STREAMING_NARRATOR_ENABLED` (W38), `RICH_STEP_INSIGHTS_ENABLED` (W19), `MERGED_PRE_PLANNER` (W39), `DASHBOARD_AUTOGEN_ENABLED`, `DEEP_ANALYSIS_SKILLS_ENABLED`, `WEB_SEARCH_ENABLED` + `TAVILY_API_KEY`, `DIAGNOSTIC_PIVOT_FILTER_MERGE_ENABLED`, `AUTO_ATTACH_LAYERS_ENABLED`.
- **Golden replay (CI):** `LIVE_LLM_REPLAY=true` runs the live-LLM replay tests; `RECORD_LIVE_LLM_BASELINE=true` records new fixtures (W28 / W33).
- **Ports:** if you change server `PORT`, set `VITE_DEV_API_PORT` (or `VITE_DEV_API_ORIGIN`) in `client.env` so the Vite proxy still reaches it.

### Build / test / lint

```bash
# Server (CI runs: npm ci && npm run build && npm test)
cd server
npm run build                                    # esbuild → dist/
npm test                                         # node --test via tsx (explicit file list, see below)
npm run create-rag-index                         # create Azure AI Search index
npm run rag-smoke                                # smoke test retrieval

# Client (CI runs: npm ci && npm run build && npm run theme:check && npm test)
cd client
npm run build                                    # vite build → dist/
npm run theme:check                              # scripts/theme-check.mjs (required pre-merge for UI)
npm test                                         # vitest (new convention: *.vitest.test.ts)
```

There is no project-wide `lint` target. TypeScript `strict` is on in both services; rely on `tsc` via `npm run build` for type errors.

#### Running a single test

[`server/package.json`](server/package.json) → `test` is an **explicit file list** (~187 server tests + ~8 client tests imported via relative `../client/...` paths) passed to Node's built-in test runner. To run one file:

```bash
cd server
node --import tsx --test tests/chartSpecCompiler.test.ts
# filter by test name
node --import tsx --test --test-name-pattern="temporal facet" tests/temporalFacetColumns.test.ts
```

When you add a new test file, **append it to the `test` script's file list** — it will not be picked up by a glob, and CI runs exactly what's listed there. New client tests can either be added to that same list (legacy `node:test` style) or written under the vitest convention (`client/src/**/*.vitest.test.ts`, run by `client/npm test` via [`client/vitest.config.ts`](client/vitest.config.ts), env: `node`).

---

## Architecture — end-to-end data flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Upload                                                                  │
│    StartAnalysisView → POST /api/upload (multipart) OR Snowflake import   │
│      → uploadController → uploadQueue (in-process)                         │
│      → fileParser → datasetProfile (heuristic dataSummary)                 │
│      → persist preview to Cosmos (≤50 sample rows)                         │
│      → enqueue enrichment job                                              │
│                                                                             │
│ 2. Enrichment (background)                                                 │
│    enrichmentService → LLM dataset profile + domain context seed           │
│      → seedSessionAnalysisContextLLM → Cosmos sessionAnalysisContext       │
│      → indexSession → Azure AI Search (RAG chunks, incl. user_context)     │
│      → enrichmentStatus = "complete"                                       │
│                                                                             │
│ 3. Chat turn (SSE)                                                         │
│    POST /api/chat/stream (chatController → chatStream.service)             │
│      → mode classification, schema binding                                 │
│      → answerQuestionContext → answerQuestion (dataAnalyzer.ts)            │
│        ↓ AGENTIC_LOOP_ENABLED required                                     │
│      → buildAgentExecutionContext → runAgentTurn (agentLoop.service)       │
│                                                                             │
│ 4. Agent loop (per turn)                                                   │
│    [hypothesisPlanner] → [contextAgent (RAG)]                              │
│      → runPlanner → PlanStep[]                                             │
│      → for each step: ToolRegistry.execute(...)                            │
│         ↳ blackboard accumulates findings / hypotheses / open Qs           │
│         ↳ reflector critiques between steps                                │
│         ↳ workingMemory holds inter-step facts                             │
│      → narratorAgent reads blackboard → AnswerEnvelope                     │
│      → checkEnvelopeCompleteness + checkMagnitudesAgainstObservations      │
│        + checkDomainLensCitations (deterministic gates, W17/W22/W35)       │
│      → runVerifier (final) → verdict                                       │
│                                                                             │
│ 5. SSE → client                                                            │
│    agentSseEventToWorkbenchEntries → AgentWorkbenchEntry rows              │
│      events: agent_workbench, answer_chunk (W38 streaming narrator),       │
│              session_context_updated (W31), sub_question_spawned,          │
│              workbench_enriched (W19), streaming_preview, handoff          │
│    persist message + workbench + answerEnvelope + investigationSummary     │
│    + priorInvestigationsSnapshot to Cosmos                                 │
│    persistMergeAssistantSessionContext (W40 per-session mutex) appends a   │
│    digest to sessionAnalysisContext.priorInvestigations (FIFO, cap 5)      │
│                                                                             │
│ 6. Render                                                                  │
│    MessageBubble → AnswerCard (envelope) + ThinkingPanel +                 │
│    StepByStepInsightsPanel + InvestigationSummaryCard +                    │
│    PriorInvestigationsBanner + charts + pivot + DashboardDraftCard         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key invariants**

- **Single agentic path.** No legacy fallback. `dataAnalyzer.answerQuestion` throws if `AGENTIC_LOOP_ENABLED` is false; the deleted handler chain (commit `9422bed7`) is not coming back.
- **Enrichment gates the chat.** Until `enrichmentStatus ∈ {complete, failed}`, chat answers are deferred — this is intentional (agent needs the profile to answer accurately).
- **Boring first.** Upload queue is in-process, session state lives in Cosmos. **Do not** add Redis / external queues / WebSockets / worker processes speculatively. Triggers for evolving live in [`docs/architecture/upload_and_enrichment.md`](docs/architecture/upload_and_enrichment.md).
- **Single-flow policy.** Reflector `replan` and verifier `revise_narrative` no longer silently override the planned flow (W11–W13); the original plan + narrative wins, and the would-be override is emitted as a `flow_decision` SSE row for visibility. Exception: when synthesis cascades to the fallback renderer, the final verifier is skipped entirely (W4).

---

## Server reference

### Entry + middleware

- [`server/index.ts`](server/index.ts) — entrypoint. **`loadEnv` MUST be the first import.**
- [`server/loadEnv.ts`](server/loadEnv.ts) — populates `process.env` from `server/server.env`.
- [`server/middleware/`](server/middleware/) — Express middleware (auth, error handling, request logging). `requireAzureAdAuth` validates Azure AD JWTs on all `/api/*` except `/api/health`.
- `createApp()` runs `assertAgenticRagConfiguration()` and `assertDashboardAutogenConfiguration()` — misconfig fails boot.

### Routes ([`server/routes/`](server/routes/))

Wired in [`server/routes/index.ts`](server/routes/index.ts) under the `/api` prefix.

| Route module | Surface |
|---|---|
| [`upload.ts`](server/routes/upload.ts) | Upload + `/api/upload/status/:jobId` polling |
| [`snowflake.ts`](server/routes/snowflake.ts) | Snowflake import flow |
| [`chat.ts`](server/routes/chat.ts) | `POST /api/chat/stream` (SSE) + non-streaming |
| [`chatManagement.ts`](server/routes/chatManagement.ts) | Session/chat lifecycle, regenerate, edit |
| [`sessions.ts`](server/routes/sessions.ts) | Session list, get-by-id, permanent context |
| [`dataRetrieval.ts`](server/routes/dataRetrieval.ts) (`/api/data`) | Preview, summary, sample rows |
| [`dataApi.ts`](server/routes/dataApi.ts) (`/api/data`) | Lower-level data fetches |
| [`dataOps.ts`](server/routes/dataOps.ts) | Bridge to python-service data ops |
| [`dashboards.ts`](server/routes/dashboards.ts) | Dashboards CRUD, `from-spec`, share, export |
| [`sharedAnalyses.ts`](server/routes/sharedAnalyses.ts), [`sharedDashboards.ts`](server/routes/sharedDashboards.ts) | Shared (public) analysis + dashboard surfaces |
| [`feedback.ts`](server/routes/feedback.ts) | Thumbs / reasons feedback ingestion |
| [`blobStorage.ts`](server/routes/blobStorage.ts) | Blob upload helpers |
| [`admin.ts`](server/routes/admin.ts) | Admin (costs, domain context packs, analysis memory) |

### Controllers ([`server/controllers/`](server/controllers/))

Mirror the routes; one controller per surface (e.g. [`chatController.ts`](server/controllers/chatController.ts), [`uploadController.ts`](server/controllers/uploadController.ts), [`dashboardController.ts`](server/controllers/dashboardController.ts), [`sessionController.ts`](server/controllers/sessionController.ts), [`adminCostsController.ts`](server/controllers/adminCostsController.ts), [`adminDomainContextController.ts`](server/controllers/adminDomainContextController.ts), [`analysisMemoryController.ts`](server/controllers/analysisMemoryController.ts)).

### Services ([`server/services/`](server/services/))

- [`chat/chatStream.service.ts`](server/services/chat/chatStream.service.ts) — streaming chat orchestrator (SSE).
- `chat/chat.service.ts` — non-streaming chat (parity-tracked with the streaming path).
- `chat/answerQuestionContext.ts` — context assembly handed to `answerQuestion`.
- `chat/agentWorkbench.util.ts` — SSE → `AgentWorkbenchEntry` rows.
- `chat/intermediatePivotPolicy.ts` — pivot SSE coalescing.
- `dashboardExport/` + `dashboardExport.service.ts` — dashboard export pipeline.
- `dataOps/` — orchestration helpers for the python-service bridge.

### `server/lib/` — the bulk of the logic

Major modules grouped by concern:

- **Chat / analysis pipeline** — [`dataAnalyzer.ts`](server/lib/dataAnalyzer.ts), [`chatAnalyzer.ts`](server/lib/chatAnalyzer.ts), [`analysisSpecRouter.ts`](server/lib/analysisSpecRouter.ts), [`reportIntent.ts`](server/lib/reportIntent.ts).
- **Agent runtime** — [`agents/runtime/`](server/lib/agents/runtime/) (see [§ Agent runtime](#agent-runtime--the-heart-of-the-system)).
- **Agent utilities** — [`agents/utils/columnMatcher.ts`](server/lib/agents/utils/columnMatcher.ts), [`columnExtractor.ts`](server/lib/agents/utils/columnExtractor.ts), [`inferFiltersFromQuestion.ts`](server/lib/agents/utils/inferFiltersFromQuestion.ts).
- **RAG** — [`rag/`](server/lib/rag/) (see [§ RAG / retrieval](#rag--retrieval)).
- **Domain context** — [`domainContext/`](server/lib/domainContext/) (see [§ Domain context system](#domain-context-system)).
- **Data ops bridge** — [`dataOps/dataOpsOrchestrator.ts`](server/lib/dataOps/dataOpsOrchestrator.ts), [`pythonService.ts`](server/lib/dataOps/pythonService.ts), [`mmmService.ts`](server/lib/dataOps/mmmService.ts), [`pythonResponseSchemas.ts`](server/lib/dataOps/pythonResponseSchemas.ts), [`dataPersistence.ts`](server/lib/dataOps/dataPersistence.ts).
- **DuckDB query plans** — [`queryPlanDuckdbExecutor.ts`](server/lib/queryPlanDuckdbExecutor.ts), [`duckdbPlanExecutor.ts`](server/lib/duckdbPlanExecutor.ts), [`queryPlanExecutor.ts`](server/lib/queryPlanExecutor.ts), [`ensureSessionDuckdbMaterialized.ts`](server/lib/ensureSessionDuckdbMaterialized.ts), [`queryPlanFacetPromotion.ts`](server/lib/queryPlanFacetPromotion.ts), [`queryPlanTemporalPatch.ts`](server/lib/queryPlanTemporalPatch.ts), [`agentReadonlySql.ts`](server/lib/agentReadonlySql.ts).
- **Charts** — [`chartSpecCompiler.ts`](server/lib/chartSpecCompiler.ts), [`chartGenerator.ts`](server/lib/chartGenerator.ts), [`analyticalChartBuilders.ts`](server/lib/analyticalChartBuilders.ts), [`chartDownsampling.ts`](server/lib/chartDownsampling.ts), [`chartEnrichmentRows.ts`](server/lib/chartEnrichmentRows.ts), [`chartPreviewFromPivot.ts`](server/lib/chartPreviewFromPivot.ts), [`charts/autoAttachLayers.ts`](server/lib/charts/autoAttachLayers.ts) (Fix-2 layer detection).
- **Pivot helpers** — [`pivotCache.ts`](server/lib/pivotCache.ts), [`pivotDefaultsFromExecution.ts`](server/lib/pivotDefaultsFromExecution.ts), [`pivotDefaultsFromPreview.ts`](server/lib/pivotDefaultsFromPreview.ts), [`pivotFilterSql.ts`](server/lib/pivotFilterSql.ts), [`pivotLayoutFromDimensions.ts`](server/lib/pivotLayoutFromDimensions.ts), [`pivotQueryService.ts`](server/lib/pivotQueryService.ts), [`pivotRowFilters.ts`](server/lib/pivotRowFilters.ts), [`pivotSliceDefaultsFromDimensionFilters.ts`](server/lib/pivotSliceDefaultsFromDimensionFilters.ts).
- **Schema binding + temporal** — [`schemaColumnBinding.ts`](server/lib/schemaColumnBinding.ts), [`agentTemporalCapabilities.ts`](server/lib/agentTemporalCapabilities.ts), [`temporalFacetColumns.ts`](server/lib/temporalFacetColumns.ts), [`temporalFacetKeyNormalization.ts`](server/lib/temporalFacetKeyNormalization.ts), [`temporalGrain.ts`](server/lib/temporalGrain.ts), [`queryParserTemporalDefault.ts`](server/lib/queryParserTemporalDefault.ts), [`dateUtils.ts`](server/lib/dateUtils.ts), [`dirtyDateEnrichment.ts`](server/lib/dirtyDateEnrichment.ts).
- **Data engine helpers** — [`columnIdHeuristics.ts`](server/lib/columnIdHeuristics.ts), [`columnarStorage.ts`](server/lib/columnarStorage.ts), [`computedColumns.ts`](server/lib/computedColumns.ts), [`correlationAnalyzer.ts`](server/lib/correlationAnalyzer.ts), [`correlationMath.ts`](server/lib/correlationMath.ts), [`statisticalSummary.ts`](server/lib/statisticalSummary.ts), [`streamingCorrelation.ts`](server/lib/streamingCorrelation.ts).
- **Wide-format ingestion** — [`server/lib/wideFormat/`](server/lib/wideFormat/) (`periodVocabulary`, `metricVocabulary`, `tokenize`, `tagColumn`).
- **MMM** — [`marketingColumnTags.ts`](server/lib/marketingColumnTags.ts), [`dataOps/mmmService.ts`](server/lib/dataOps/mmmService.ts).
- **Insight synthesis** — [`insightGenerator.ts`](server/lib/insightGenerator.ts), [`insightSynthesis/`](server/lib/insightSynthesis), [`suggestedFollowUpsFromSummary.ts`](server/lib/suggestedFollowUpsFromSummary.ts), [`suggestedQuestions.ts`](server/lib/suggestedQuestions.ts), [`suggestionGenerator.ts`](server/lib/suggestionGenerator.ts).
- **File ingestion** — [`fileParser.ts`](server/lib/fileParser.ts), [`largeFileProcessor.ts`](server/lib/largeFileProcessor.ts), [`streamingFileParser.ts`](server/lib/streamingFileParser.ts), [`datasetProfile.ts`](server/lib/datasetProfile.ts), [`metadataService.ts`](server/lib/metadataService.ts).
- **Session context** — [`sessionAnalysisContext.ts`](server/lib/sessionAnalysisContext.ts), [`sessionAnalysisContextGuards.ts`](server/lib/sessionAnalysisContextGuards.ts).
- **External services** — [`openai.ts`](server/lib/openai.ts), [`snowflakeService.ts`](server/lib/snowflakeService.ts), [`blobStorage.ts`](server/lib/blobStorage.ts).
- **Caching** — [`cache/`](server/lib/cache), [`cache.ts`](server/lib/cache.ts).

### Models ([`server/models/`](server/models/))

Cosmos document shapes:

- [`chat.model.ts`](server/models/chat.model.ts) — `ChatDocument` (sessionId, dataSummary, messages, enrichmentStatus, sessionAnalysisContext, agentTrace, etc.).
- [`dashboard.model.ts`](server/models/dashboard.model.ts), [`sharedDashboard.model.ts`](server/models/sharedDashboard.model.ts).
- [`sharedAnalysis.model.ts`](server/models/sharedAnalysis.model.ts).
- [`pastAnalysis.model.ts`](server/models/pastAnalysis.model.ts) — feedback / past analyses.
- [`analysisMemory.model.ts`](server/models/analysisMemory.model.ts) — W56 per-session append-only journal (mirrored to AI Search at W57; replaces FIFO `priorInvestigations` at W60).
- [`domainContextToggles.model.ts`](server/models/domainContextToggles.model.ts) — admin toggles for domain packs.
- [`llmUsage.model.ts`](server/models/llmUsage.model.ts), [`userBudget.model.ts`](server/models/userBudget.model.ts) — cost telemetry.
- [`database.config.ts`](server/models/database.config.ts) — Cosmos init.

### Shared schema (server ↔ client)

[`server/shared/schema.ts`](server/shared/schema.ts) and [`client/src/shared/schema.ts`](client/src/shared/schema.ts) are kept in lockstep — when you add a field to the message envelope, update **both** files.

---

## Agent runtime — the heart of the system

Full inventory in [`docs/agents-architecture-inventory.md`](docs/agents-architecture-inventory.md). Quick orientation:

**Loop entry:** [`runAgentTurn`](server/lib/agents/runtime/agentLoop.service.ts) — Planner → Tools → Reflector → Verifier → Narrator with budgets, working memory, and SSE callbacks.

**Phases:**

1. **Pre-planning** — `inferFiltersFromQuestion` (W1, deterministic), `runHypothesisAndBrief` (W39 merged) or `generateHypotheses` + `maybeRunAnalysisBrief`.
2. **Planning** — [`planner.ts`](server/lib/agents/runtime/planner.ts) emits `PlanStep[]`; `plannerColumnResolve.ts` and `planArgRepairs.ts` repair column names + filter args before dispatch.
3. **Execution** — [`toolRegistry.ts`](server/lib/agents/runtime/toolRegistry.ts) dispatches each step; tools mutate the [`analyticalBlackboard`](server/lib/agents/runtime/analyticalBlackboard.ts) and [`workingMemory`](server/lib/agents/runtime/workingMemory.ts).
4. **Reflection** — [`reflector.ts`](server/lib/agents/runtime/reflector.ts) critiques between steps. Single-flow policy: `replan` is suppressed but emitted as a `flow_decision` SSE row.
5. **Synthesis** — [`narratorAgent.ts`](server/lib/agents/runtime/narratorAgent.ts) reads the blackboard and produces the structured `NarratorOutput` envelope (`tldr`, `findings[]`, `implications[]` grouped by horizon, `magnitudes[]`, `methodology`, `caveats[]`, `domainLens`, `recommendations[]`). Streams field-by-field via [`completeJsonStreaming`](server/lib/agents/runtime/llmJson.ts) when `STREAMING_NARRATOR_ENABLED=true` (W38) — but only on the initial call, not on repair calls. Empty-blackboard fallback: [`synthesisFallback.ts`](server/lib/agents/runtime/synthesisFallback.ts).
6. **Deterministic gates (pre-verifier)** — [`checkEnvelopeCompleteness.ts`](server/lib/agents/runtime/checkEnvelopeCompleteness.ts) (W17, ≥2 implications + ≥2 recommendations + `domainLens`), [`checkMagnitudesAgainstObservations.ts`](server/lib/agents/runtime/checkMagnitudesAgainstObservations.ts) (W35, no fabricated numbers), [`checkDomainLensCitations`](server/lib/agents/runtime/verifierHelpers.ts) (W22, no fabricated pack ids). Multiple failures batch into a single composite `course_correction` (W43) and a single repair narrator call.
7. **Final verifier** — [`verifier.ts`](server/lib/agents/runtime/verifier.ts) returns one of six verdicts: `pass`, `revise_narrative`, `retry_tool`, `replan`, `ask_user`, `abort_partial`. Use `VERIFIER_VERDICT.*` constants from [`schemas.ts`](server/lib/agents/runtime/schemas.ts) — typos become compile errors (W F3).

**Investigation subsystem (under the loop):** [`analyticalBlackboard.ts`](server/lib/agents/runtime/analyticalBlackboard.ts) (shared evidence), [`hypothesisPlanner.ts`](server/lib/agents/runtime/hypothesisPlanner.ts) (decomposition), [`coordinatorAgent.ts`](server/lib/agents/runtime/coordinatorAgent.ts) (decomposeQuestion — currently unwired by the W11–W13 single-flow policy but kept for re-enablement), [`investigationTree.ts`](server/lib/agents/runtime/investigationTree.ts) + [`investigationOrchestrator.ts`](server/lib/agents/runtime/investigationOrchestrator.ts) (BFS over sub-questions), [`contextAgent.ts`](server/lib/agents/runtime/contextAgent.ts) (multi-round RAG), [`priorInvestigations.ts`](server/lib/agents/runtime/priorInvestigations.ts) (W21 carry-over), [`buildInvestigationSummary.ts`](server/lib/agents/runtime/buildInvestigationSummary.ts) (W13 digest persisted to the message), [`buildSynthesisContext.ts`](server/lib/agents/runtime/buildSynthesisContext.ts) (W7 four-block bundle).

**LLM provider abstraction:** [`callLlm.ts`](server/lib/agents/runtime/callLlm.ts) is the single entry; [`anthropicProvider.ts`](server/lib/agents/runtime/anthropicProvider.ts) handles Claude Opus 4.7. Per-role override via `OPENAI_MODEL_FOR_NARRATOR`, `_VERIFIER_DEEP`, `_COORDINATOR`, `_HYPOTHESIS` env vars. Test stub via `__setLlmStubResolver` (W18) — `installLlmStub({ [purpose]: handler })` covers every `LLM_PURPOSE` member.

**Cost telemetry:** [`llmCostModel.ts`](server/lib/agents/runtime/llmCostModel.ts), [`llmUsageEmitter.ts`](server/lib/agents/runtime/llmUsageEmitter.ts), [`llmCallPurpose.ts`](server/lib/agents/runtime/llmCallPurpose.ts) — `purpose` is forwarded through every LLM call; surfaces in the admin Costs page.

---

## Tool registry

Tools live in [`server/lib/agents/runtime/tools/`](server/lib/agents/runtime/tools/) (one file per non-trivial tool). Boot-time registration in [`registerTools.ts`](server/lib/agents/runtime/tools/registerTools.ts); duplicate names throw (W F2). Full arg/return shapes in [`docs/architecture/tool-registry.md`](docs/architecture/tool-registry.md).

| Tool | One-liner |
|---|---|
| `retrieve_semantic_context` | RAG vector search over the session index |
| `get_schema_summary` | Column metadata + top values |
| `sample_rows` | Row-level sampling, capped at `AGENT_SAMPLE_ROWS_CAP` |
| `run_analytical_query` | Structured SQL-like execution over the materialised DuckDB session |
| `execute_query_plan` | Run a planner-emitted query plan (group-by + filters + agg) |
| `derive_dimension_bucket` | On-the-fly bucketing for a categorical dimension |
| `add_computed_columns` | Per-turn derived columns |
| `run_readonly_sql` | Fallback read-only SQL escape hatch |
| `run_correlation` | Correlation matrix + scatter |
| `run_segment_driver_analysis` | Segment driver ranking |
| `breakdown_ranking` | Ranking-style breakdown of a metric across a dimension |
| `two_segment_compare` | Side-by-side comparison of two segments |
| `build_chart` | Chart spec construction (delegates to chart compiler) |
| `clarify_user` | Emit a clarification prompt to the user |
| `run_data_ops` | Bridge into the Data Ops orchestrator (transforms / filters / pivot / models) |
| `run_budget_optimizer` | **W53** — MMM scipy-SLSQP budget reallocation |
| `patch_dashboard` | Phase-2 dashboard patch tool |
| `web_search` | **W14, env-gated** — Tavily web search; surfaces hits in the W7 RAG bundle as `[web:tavily:N]` |

---

## Skills (Phase-1 analytical competencies)

Skills are **composites over the existing tool catalog** — they expand into a stable `PlanStep[]` so the planner doesn't have to improvise the same recipe twice. Full doc: [`docs/architecture/skills.md`](docs/architecture/skills.md).

| Skill | Question shape it serves |
|---|---|
| `varianceDecomposer` | "why did X fall between A and B" |
| `driverDiscovery` | "what drives X" |
| `insightExplorer` | open-ended narrative on a dataset slice |
| `timeWindowDiff` | explicit "period A vs period B" comparisons |
| `parallelResolve` | parallel-step resolver (infrastructure, not user-facing) |

Selection (Wave F1 onwards): `selectSkill` is **priority-ordered** — narrow skills (e.g. `timeWindowDiff` requiring `comparisonPeriods`) carry higher priority and shadow broader ones when their preconditions are met. Pre-F1 it was first-match-wins on import order and broke `timeWindowDiff` in production. Env gate: `DEEP_ANALYSIS_SKILLS_ENABLED`.

To add a new skill: drop a module in `runtime/skills/`, call `registerSkill()` at module top-level, append `import "./yourSkill.js"` to `skills/index.ts`. Tools the skill expands to must already be registered.

---

## MMM pipeline (Marketing Mix Modeling)

Waves W46–W55. Full doc: [`docs/architecture/mmm.md`](docs/architecture/mmm.md). End-to-end:

- **Column tagger:** [`server/lib/marketingColumnTags.ts`](server/lib/marketingColumnTags.ts) heuristically identifies spend / outcome / time columns when the agent doesn't supply them.
- **Python modeling stack:** [`python-service/mmm/`](python-service/mmm/) — `transforms.py` (geometric adstock + Hill saturation), `fit.py` (coordinate-descent grid + ridge + bootstrap CI), `optimize.py` (scipy SLSQP over the fitted response surface).
- **FastAPI route:** `POST /mmm/budget-redistribute` in [`python-service/main.py`](python-service/main.py).
- **Node bridge:** [`server/lib/dataOps/mmmService.ts`](server/lib/dataOps/mmmService.ts) — `runBudgetRedistribute`, ~4 min timeout (W50).
- **Agent tool:** [`server/lib/agents/runtime/tools/budgetOptimizerTool.ts`](server/lib/agents/runtime/tools/budgetOptimizerTool.ts) (`run_budget_optimizer`).
- **Output adapter (W54):** [`server/lib/agents/runtime/budgetOptimizerAdapter.ts`](server/lib/agents/runtime/budgetOptimizerAdapter.ts) builds deterministic `recommendations[]` (≤4 actions), `magnitudes[]` (lift, budget held, top shift), and `domainLens` for the narrator envelope.

The W55 e2e test pins the full pipeline shape against a fixture so the MMM contract doesn't drift.

---

## RAG / retrieval

[`server/lib/rag/`](server/lib/rag/). Two indexes: per-session chunks for analytical context, and a separate past-analyses index for cross-session memory.

- [`config.ts`](server/lib/rag/config.ts) — `RAG_*` env config.
- [`chunking.ts`](server/lib/rag/chunking.ts) — chunk size / overlap, plus the `user_context` chunk that prepends `permanentContext` so planner / reflector retrieval includes user-stated goals.
- [`embeddings.ts`](server/lib/rag/embeddings.ts) — Azure OpenAI embeddings (`AZURE_OPENAI_EMBEDDING_*`).
- [`aiSearchStore.ts`](server/lib/rag/aiSearchStore.ts) — Azure AI Search adapter.
- [`indexSession.ts`](server/lib/rag/indexSession.ts) — index a session's data + context.
- [`retrieve.ts`](server/lib/rag/retrieve.ts) + [`retrieveHelpers.ts`](server/lib/rag/retrieveHelpers.ts) — retrieval (used by `retrieve_semantic_context` tool and by the [`contextAgent`](server/lib/agents/runtime/contextAgent.ts) for multi-round resolution before tool calls).
- [`pastAnalysesStore.ts`](server/lib/rag/pastAnalysesStore.ts) + [`createPastAnalysesIndex.ts`](server/lib/rag/createPastAnalysesIndex.ts) — past-analyses index.
- [`createSearchIndex.ts`](server/lib/rag/createSearchIndex.ts) — used by `npm run create-rag-index`.
- [`ragHit.ts`](server/lib/rag/ragHit.ts) — `RagHit` shape, including `source: "rag_round1" | "rag_round2" | "injected" | "web"` (W16 added the `web` source for `web_search` hits surfaced in the W7 RAG bundle).

Web-search hits format identical to RAG hits (`[web:tavily:N] Title\nContent\n— url`) so synthesis treats them uniformly. RAG section cap bumped 4 000 → 6 000 chars at W16 to fit the third sub-section.

---

## Wide-format ingestion

For spreadsheets where periods / metrics are encoded in column names (common Nielsen / FMCG layout). Doc: [`docs/architecture/wide-format.md`](docs/architecture/wide-format.md).

Pipeline: [`server/lib/wideFormat/`](server/lib/wideFormat/) — `periodVocabulary` (regex library for time tokens) → `metricVocabulary` (regex library for Nielsen metric names) → `tokenize` (header splitter + n-gram helper) → `tagColumn` (per-header verdict: `id` / `period` / `metric` / `compound` / `ambiguous`).

The agent's temporal capabilities ([`agentTemporalCapabilities.ts`](server/lib/agentTemporalCapabilities.ts)) and the `derive_dimension_bucket` / `add_computed_columns` tools consume the tagger output.

---

## Domain context system

[`server/lib/domainContext/`](server/lib/domainContext/). FMCG / Marico domain packs (kebab-case ids like `kpi-and-metric-glossary`, `marico-haircare-portfolio`) provide vocabulary, metric definitions, and brand context. Doc: [`docs/architecture/domain-context.md`](docs/architecture/domain-context.md).

- [`packs/`](server/lib/domainContext/packs) — pack files (kebab-case).
- [`packSchema.ts`](server/lib/domainContext/packSchema.ts) — zod schema.
- [`discoverPacks.ts`](server/lib/domainContext/discoverPacks.ts) — pack discovery.
- [`loadEnabledDomainContext.ts`](server/lib/domainContext/loadEnabledDomainContext.ts) — process-memoised loader respecting [`domainContextToggles.model.ts`](server/models/domainContextToggles.model.ts) (admin can disable per-pack).
- [`generatedPacks.ts`](server/lib/domainContext/generatedPacks.ts) — generated pack support.

Domain context is injected into:
- The narrator + synthesizer prompts (W7 bundle, W8 decision-grade envelope).
- Per-chart `businessCommentary` (W12).
- Per-step insight enrichment (W19).
- The `domainLens` envelope field (W8) — citation-checked against supplied pack ids (W22), preventing hallucinated pack ids.

Per-turn the loader is hoisted into a single `perTurnDomainContext` variable shared by all consumers (W34).

---

## Charting (v1 + the v2 overhaul)

Two layers in flight. Full doc: [`docs/architecture/charting.md`](docs/architecture/charting.md).

**v1 (legacy, still default):** [`client/src/pages/Home/Components/ChartRenderer.tsx`](client/src/pages/Home/Components/ChartRenderer.tsx) (~1 800 LOC, recharts). Marks: `bar`, `line`, `area`, `scatter`, `pie`, `heatmap`. The doc enumerates every prop, state, special case, and downstream side effect — this is the parity checklist for v2 deletion.

**v2 (in progress):** `<PremiumChart>` / `<ChartCanvas>` / `<ChartGrid>` / `<ChatChartCard>` / `<RawDataProvider>` with a `ChartSpecV2` grammar. Routed through `<ChartShim>` per-mark feature flag (`VITE_USE_PREMIUM_<TYPE>` env or `localStorage('chart.premium.<type>', 'true')`). Defaults all `false` until each mark passes parity.

**Auto-attach layers** ([`server/lib/charts/autoAttachLayers.ts`](server/lib/charts/autoAttachLayers.ts)) — on each chat answer, regex over the user question detects intent for `reference-line`, `trend`, `forecast`, `outliers`, `comparison` overlays and emits `_autoLayers` on the v1 spec. Mark-gated (line/area/bar/scatter only). Kill switch: `AUTO_ATTACH_LAYERS_ENABLED=false`. v1 ignores the field; v2 forwards it into `ChartSpecV2.layers`.

**Fork-to-Explorer** — chat charts are read-only; `<ChatChartCard>` ships a `Fork` button that base64-encodes the spec into a `#spec=` hash and navigates to `/explore` (full editing surface with `MarkPicker`, `EncodingShelves`, `SuggestedAlts`, `ExportMenu`).

**Theme bridge** — `next-themes` toggles `class="dark"` on `<html>`. Fix-3 wired a `MutationObserver` on `documentElement` so ECharts re-applies options within ~16 ms (one frame) when the user toggles theme.

---

## Client reference

### Routing — [`client/src/App.tsx`](client/src/App.tsx)

`wouter`. Routes:

- `/analysis` — chat / Home (the main surface).
- `/analysis/:sessionId/memory` — per-session analysis memory page.
- `/dashboard` — dashboards list + editor.
- `/history` — past analyses.
- `/explore` — `<ChartCanvas>` chart editor (Fork-to-Explorer target).
- `/admin/costs` — LLM cost / budget surface.
- `/admin/context-packs` — domain pack toggles.
- catch-all → redirects to `/analysis`. Legacy `/data-ops` and `/modeling` also redirect.

All routes are `React.lazy`-loaded with a `RouteLoadingFallback` Suspense boundary. Auth: `MsalProvider` + `ProtectedRoute` + `AuthCallback`. MSAL singleton via [`createMsalConfig()`](client/src/auth/msalConfig.ts) + `registerMsalInstance` (P-016). TanStack Query `queryClient` is warmed in `App.tsx` by prefetching the user's sessions (P-025).

**Path aliases** ([`client/tsconfig.json`](client/tsconfig.json) + [`client/vite.config.ts`](client/vite.config.ts)): `@/* → src/*`, `@shared/* → src/shared/*`. (The old `@assets/*` alias was removed.)

### Home page (chat surface)

[`client/src/pages/Home/`](client/src/pages/Home/) — orchestrated by [`Home.tsx`](client/src/pages/Home/Home.tsx). State hooks:

- `useHomeState()` — session id, messages, charts, insights, columns metadata.
- [`useHomeMutations()`](client/src/pages/Home/modules/useHomeMutations.ts) — upload / Snowflake / chat SSE; live workbench, streaming narrator preview, spawned sub-questions; intermediate vs final message assembly; auto-navigates to `/dashboard?open=<id>` when the agent auto-creates a dashboard.
- `useHomeHandlers()` — file selection, send, edit, regenerate.

**Components** ([`client/src/pages/Home/Components/`](client/src/pages/Home/Components/)) you'll touch most:

- `ChatInterface.tsx` — message list shell.
- `MessageBubble.tsx` — branches between markdown fallback, `AnswerCard`, dashboard-draft, etc.
- `AnswerCard.tsx` — renders the structured `answerEnvelope` (TL;DR, findings + magnitude badges + confidence borders, implications grouped by horizon `now` / `this_quarter` / `strategic`, collapsible methodology, caveats, recommendations, suggested questions).
- `ThinkingPanel.tsx` + `StepByStepInsightsPanel.tsx` (W11) — live agent workbench / step-insight visibility.
- `StreamingPreviewCard.tsx` (W42) + `StreamingIndicator.tsx` — early "Drafting answer…" preview + elapsed-time chip.
- `InvestigationSummaryCard.tsx` (W13) — compact digest of hypotheses tested, headline findings, open questions.
- `PriorInvestigationsBanner.tsx` (W26 / W37) — collapsed pill above the chat listing prior-turn digests; live-refreshed via `session_context_updated` SSE (W31).
- `MagnitudesRow.tsx`, `SourceDrawer.tsx`, `SourcePillRow.tsx` — provenance surfaces.
- `DashboardDraftCard.tsx` — agent-drafted dashboard preview; one click POSTs to `/api/dashboards/from-spec` and navigates.
- `DatasetEnrichmentLoader.tsx`, `StartAnalysisView.tsx`, `SnowflakeImportFlow.tsx` — upload / enrichment / import surfaces.
- `MessageActionsBar.tsx` + `RegenerateButton.tsx` + `FeedbackButtons.tsx` — copy / regenerate (longer / shorter / more-or-less technical) / thumbs-with-reason feedback.
- `ChartModal.tsx`, `ChartRenderer.tsx`, `InteractiveChartCard.tsx`, `ChatChartCard.tsx` — chart surfaces (see [§ Charting](#charting-v1--the-v2-overhaul)).
- `AnalyticalDashboardResponse.tsx` — agent-emitted DashboardSpec previews and drill-through inside the chat.

### Pivot subsystem

- **Lib:** [`client/src/lib/pivot/`](client/src/lib/pivot/) — `buildPivotModel`, `buildPivotTree`, `flattenPivotTree`, `createInitialPivotConfig`, `normalizePivotConfig`, `filterPivotRows`, `chartRecommendation`, `exportPivotToXlsx`, types.
- **UI:** [`client/src/pages/Home/Components/pivot/`](client/src/pages/Home/Components/pivot/) — `PivotGrid`, `PivotFieldPanel` (dnd-kit drag-to-shelf, capped available zone with internal scroll), `PivotHeaderSliceFilter`.
- **Wiring:** `buildChatPivotNavEntries` wires pivot data into the Home sidebar; `computeAllowPivotAutoShow` gates auto-expansion in chat.
- **Live Key Insight:** in analysis variant, the "Key insight" card atop the pivot table is **live-derived** — not the message-frozen `message.insights[0]`. [DataPreviewTable.tsx](client/src/pages/Home/Components/DataPreviewTable.tsx) holds two parallel insight states: `chartInsight` (chart-view, keyed off `chartPreview` ref + `chartConfigHash`) and `pivotKeyInsight` (pivot-view, keyed off `pivotFlatRows` + `pivotInsightConfigHash`). Both POST to `/api/sessions/:sessionId/chart-key-insight` with the user's original question (`precedingUserQuestion` threaded down through `MessageBubble`); pivot-view builds a synthetic `ChartSpec` from the materialized leaf rows. Display selector at `DataPreviewTable.tsx` precedence: `analysisIntermediateInsight ?? pivotKeyInsight?.text ?? pivotInsight` — frozen prop is boot-state fallback only. Both states use **outcome-aware dedupe** (`{hash, outcome: 'pending' | 'success' | 'empty' | 'error'}`); only `success`/`pending` short-circuits subsequent runs so transient failures stay refetchable. State transitions preserve prior good text (`setX(prev => ...)`) so a failed refresh never erases the previous insight; `ChartKeyInsightCallout` renders a muted "Couldn't refresh" subline alongside the prior text on error.

### Dashboard surface

[`client/src/pages/Dashboard/`](client/src/pages/Dashboard/) — `DashboardProvider` / `useDashboardContext`. Components: `DashboardList`, `DashboardView`, `DashboardTiles` (resizable grid), `ChartContainer`, `EditTableCaptionModal`, `DashboardFilters`, `DashboardHeader`, `DeleteDashboardDialog`, `ShareDashboardDialog`, `ResizableTile`, `InsightRecommendationTile`. Hooks: `useLayoutHistory` (undo/redo), `dashboardGridLogic`. Deep-link via `?open=<dashboardId>`.

### UI theming (from [`client/THEMING.md`](client/THEMING.md))

- **Only** semantic token classes: `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, etc. **No** `text-gray-*`, `bg-white`, raw hex/rgb/hsl in JSX.
- For tables / lists use the shared utilities from [`client/src/index.css`](client/src/index.css): `token-table-frame`, `token-table-head`, `token-table-row`, `surface-hover`, `surface-selected`, `surface-positive`.
- Prefer Radix / shadcn primitives in [`client/src/components/ui/`](client/src/components/ui/) before custom styling.
- Verify changes in **both** light and dark modes, and run `npm run theme:check`.

---

## Deployment + CI

- **Vercel** is the target. [`api/index.ts`](api/index.ts) sets `process.env.VERCEL = '1'` and exports the Express app from `createApp()`; [`server/index.ts`](server/index.ts) skips the local `http.createServer` path when `VERCEL` is set. [`api/data-ops/index.py`](api/data-ops/index.py) exposes the FastAPI `app` as ASGI.
- [`client/vercel.json`](client/vercel.json) rewrites all routes to `index.html` (SPA) and sets immutable cache headers on `/assets/*`.
- See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the two-project Vercel layout.

**CI workflows** ([`.github/workflows/`](.github/workflows/)):

- `ci.yml` — push + PR to `main`/`master`. **Server:** Node 20, `npm ci → build → test`. **Client:** Node 20, `npm ci → build → theme:check → test`. **Python:** Python 3.12, pip install → smoke import → requirements sync gate (P-005).
- `live-llm-replay.yml` (W45) — weekly Monday 08:00 UTC + manual `workflow_dispatch`. Runs the W28 / W33 live-LLM golden replay against real Azure OpenAI. ~$3/run, gated on `LIVE_LLM_REPLAY=true` env + `AZURE_OPENAI_API_KEY` secret. `concurrency: live-llm-replay` so newer runs cancel older queued ones. **Does not block merges** (no branch-protection gate). The `recording_mode` workflow input triggers W33 baseline capture and uploads `<id>.recorded.json` files as a 30-day artefact.

---

## Conventions that bite

- **Agentic-only — no fallback.** `dataAnalyzer.answerQuestion` throws if `AGENTIC_LOOP_ENABLED` is false. The legacy orchestrator and handler chain were deleted in commit `9422bed7` (2026-04-26). Don't reintroduce a fallback path — see [`docs/plans/agentic_only_rag_chat.md`](docs/plans/agentic_only_rag_chat.md) for the invariant.
- **ESM everywhere on the server.** All relative imports use `.js` extensions even from `.ts` source (e.g. `import { x } from "./routes/index.js"`). `tsx` resolves these; `esbuild` bundles with `--format=esm --packages=external`.
- **`loadEnv.ts` must be the first import in `server/index.ts`.** It populates `process.env` from `server/server.env` before any module reads config. Don't reorder.
- **`assertAgenticRagConfiguration()` runs inside `createApp()`** — if agentic is on without RAG configured, startup fails fast. Use `AGENTIC_ALLOW_NO_RAG=true` only in tests.
- **Server `npm test` is an explicit file list, not a glob.** New test files (server-side OR client-side imported via `../client/...`) must be appended there; otherwise CI silently skips them.
- **Client tests can be vitest now.** New `*.vitest.test.ts` files run via `client/npm test` (vitest, env `node`). Legacy `node:test` files still listed in the server script.
- **Two env files have non-standard names** (`server.env`, `client.env`). They're loaded by code, not by tooling defaults — don't rename them without updating `loadEnv.ts` and `vite.config.ts`.
- **Claude Opus 4.7 routing is opt-in per role.** `ANTHROPIC_API_KEY` + `OPENAI_MODEL_FOR_*` env vars route narrator / verifier_deep / coordinator / hypothesis to Anthropic; missing key falls back to Azure OpenAI. Don't hardcode provider — read the role config.
- **Single-flow policy.** Don't silently override the planner: reflector `replan` and verifier `revise_narrative` both **emit `flow_decision` SSE rows but keep the original plan / narrative**. The deep-investigation / coordinator decompose paths exist as standalone code but are not invoked from `answerQuestion`. Re-wiring requires a feature flag.
- **Verifier verdicts are constants.** Use `VERIFIER_VERDICT.*` from [`runtime/schemas.ts`](server/lib/agents/runtime/schemas.ts), never string literals — typos become compile errors (W F3).
- **Tool / skill registry duplicate name = fatal.** Boot-time registration fires once per process. Add new tools in `tools/<name>Tool.ts` + register in `registerTools.ts`; new skills in `skills/<name>.ts` + import in `skills/index.ts`.
- **Dashboard-autogen requires agentic.** `assertDashboardAutogenConfiguration()` enforces the dependency at boot.
- **Per-session mutex (W40).** `persistMergeAssistantSessionContext` serialises per-session writes with an in-process `Map<sessionId, Promise>`. Single-instance correctness only — multi-instance scaling needs Cosmos `ifMatch` ETag or external lock.
- **Boring first.** Upload queue is in-process. Don't add Redis / external queues / WebSockets / worker processes speculatively. Triggers for evolving live in [`docs/architecture/upload_and_enrichment.md`](docs/architecture/upload_and_enrichment.md).
- **`/api/sessions/:sessionId/chart-key-insight` must stay context-hydrated.** [`postChartKeyInsightEndpoint`](server/controllers/sessionController.ts) MUST forward `userQuestion` (request body) plus session-derived `synthesisContext` (`sessionAnalysisContext`, `permanentContext`, memoised `domainContext` via `loadEnabledDomainContext`) and `chatLevelInsights` (from `session.insights`) into [`generateChartInsights`](server/lib/insightGenerator.ts). Passing `undefined`/`undefined` (the pre-fix shape) silently strips the `USER QUESTION`, `SESSION CONTEXT`, `USER NOTES`, `CHAT-LEVEL INSIGHTS`, and `FMCG / MARICO DOMAIN CONTEXT` blocks from the LLM prompt — output then mimics the deterministic fallback. Empty `chart.data` returns `200 { keyInsight: "" }`, **not** `400` — zero-row filters are a valid user state and the client preserves prior text. Parity reference: [`enrichCharts`](server/services/chat/chatResponse.service.ts) at the agent-turn boundary.

---

## Where to look in `docs/`

| Doc | When to read it |
|---|---|
| [`agents-architecture-inventory.md`](docs/agents-architecture-inventory.md) | File-by-file map of every agent module + env flag |
| [`architecture/overview.md`](docs/architecture/overview.md) | Short orientation (overlaps with this file) |
| [`architecture/agent-runtime.md`](docs/architecture/agent-runtime.md) | Detailed runtime flow, verdict vocabulary, extension points (note: capability-gap section is historical) |
| [`architecture/tool-registry.md`](docs/architecture/tool-registry.md) | Tool schemas, ToolExecutor / ToolResult types |
| [`architecture/skills.md`](docs/architecture/skills.md) | Skills selection rules, contracts, how to add one |
| [`architecture/mmm.md`](docs/architecture/mmm.md) | MMM end-to-end (W46–W55) |
| [`architecture/wide-format.md`](docs/architecture/wide-format.md) | Wide-format header tagger |
| [`architecture/upload_and_enrichment.md`](docs/architecture/upload_and_enrichment.md) | Upload queue + enrichment pipeline + "boring first" triggers |
| [`architecture/charting.md`](docs/architecture/charting.md) | v1 ChartRenderer behaviour contract + v2 plan |
| [`architecture/domain-context.md`](docs/architecture/domain-context.md) | Domain pack format and loader |
| [`architecture/schemas.md`](docs/architecture/schemas.md) | Shared zod schemas |
| [`architecture/brand-system.md`](docs/architecture/brand-system.md) | Brand tokens / theming |
| [`architecture/ci-and-env.md`](docs/architecture/ci-and-env.md) | CI workflow + env-flag guidance |
| [`DEPLOY.md`](docs/DEPLOY.md) | Vercel two-project deploy |
| [`plans/agentic_only_rag_chat.md`](docs/plans/agentic_only_rag_chat.md) | Rollout invariants, RAG-required contract |
| [`plans/agentic_analysis_architecture.md`](docs/plans/agentic_analysis_architecture.md) | Verifier / critic / SSE concepts |
| [`plans/phase-1-deep-analysis.md`](docs/plans/phase-1-deep-analysis.md), [`phase-2-dashboard-generation.md`](docs/plans/phase-2-dashboard-generation.md) | Multi-wave plans |
| [`plans/dashboard-ux-collision-fix.md`](docs/plans/dashboard-ux-collision-fix.md) | Dashboard UX fix plan |
| [`plans/enterprise_platform_overhaul.md`](docs/plans/enterprise_platform_overhaul.md) | Long-horizon vision doc |
| [`problems/`](docs/problems/) | Numbered problem write-ups (P-001 … P-NN) — incident postmortems and design debates |

---

## Changelog

- **2026-04-30** — **Waves DWD2-A/B/C · temporal-empties root cause + CSV format + row-cap auto-switch.** Three follow-up waves to the DWD1 download button. (A) [`parseFlexibleDate`](server/lib/dateUtils.ts) now recognises wide-format calendar PeriodIso labels — `2024-Q1` (→ first day of quarter), `2024-Hn` (→ first day of half), `2024-Wnn` (→ Monday of ISO week), `FY2024` / `CY2024` (→ Jan 1), `WE-YYYY-MM-DD` (→ exact date), `MAT-YYYY-MM` (→ first day of anchor month), `YTD-YYYY-MM` and `YTD-YYYY` (→ first day of anchor) — and strips comparative qualifiers (`-TY`, `-YA`, `-2YA`, `-3YA`) before lookup so `MAT-2024-12-YA` resolves the same as `MAT-2024-12`. Rolling / latest_n / bare-comparative shapes (`L12M`, `L12M-YA`, `MAT-TY`, `YTD-2YA`, `MTD-YA`, `XXXX-Q1`) intentionally remain unparseable: anchored to "now", no fixed calendar date — the temporal facet machinery correctly leaves those rows null rather than inventing an anchor. End-to-end value: when the dataset profile pass adds `PeriodIso` to `dataSummary.dateColumns`, `applyTemporalFacetColumns` now derives non-null `Year ·` / `Quarter ·` / `Month ·` facets for calendar rows — directly closing the "some temporal columns just seem empty" complaint the user raised alongside the download button ask. 11 new tests in [`tests/parseFlexibleDateIsoPeriods.test.ts`](server/tests/parseFlexibleDateIsoPeriods.test.ts) (appended to the explicit-file-list `test` script): pin every supported ISO shape, the qualifier-stripping behaviour, the latest_n / bare-comparative null cases, range checks (Q5, H3, W54, month 13 → null), and a `applyTemporalFacetColumns` integration test that proves mixed `PeriodIso` rows produce non-null facets only for calendar values. Adjacent regression sweep: `uploadDateEnrichment` / `dirtyDateEnrichment` / `temporalFacetColumns` / `parseRowDateOpaque` / `createDataSummaryDateInference` / `columnarStorageDateRoundtrip` 66/66 pass — no existing date parser case shifted. (B) `?format=csv` opt-in on `GET /api/data-ops/download-working/:sessionId` (default still xlsx). RFC-4180-ish CSV builder via `buildCsvBuffer` mirrors the inline serialiser in `downloadModifiedDataset`. Filename suffix `_working_<ts>.csv`, `Content-Type: text/csv; charset=utf-8`. Tested: comma-bearing fields quoted, embedded `"` doubled inside surrounding quotes, embedded `\n` preserved inside quoted cells, no trailing newline. Client API helper [`downloadWorkingDatasetXlsx(sessionId, format)`](client/src/lib/api/chat.ts) accepts `'xlsx' | 'csv'` (defaults `'xlsx'`) and returns `{ filename, rowCount }`. (C) Server now sets the `X-Working-Dataset-Row-Count` response header on every working-dataset download (added to [`middleware/cors.ts`](server/middleware/cors.ts) `exposedHeaders` so the browser actually surfaces it cross-origin alongside `Content-Length`). Client gate at [`ChatInterface.tsx:handleDownloadWorkingDataset`](client/src/pages/Home/Components/ChatInterface.tsx) reads `totalRows` (already prop-piped from `useHomeState`) and: stays on xlsx with no warning at <250k rows, stays on xlsx but toasts "Preparing large download — this may take a moment" at 250k–900k rows, and **auto-switches to CSV** at >900k rows with a toast explaining "Excel's per-sheet limit is ~1,048,576 rows" — closes the silent-truncation footgun where a 1.2M-row dataset would have lost rows in xlsx. The CSV switch is automatic; the user doesn't need to know the threshold. **Out of scope, recorded in [`/Users/tida/.claude/plans/follow-up-temporal-and-persist-policy.md`](/Users/tida/.claude/plans/follow-up-temporal-and-persist-policy.md):** (i) auto-promoting `summary.wideFormatTransform.periodIsoColumn` into `summary.dateColumns` at upload time so the Wave-A parser actually fires on every wide-format dataset (Wave A is the building block; deterministic auto-promotion is one more line in `uploadQueue.ts` but needs test-fixture triage across `wideFormatPipeline.test.ts` / `wideFormatShapeBlock.test.ts` / `wideFormatPostMeltPipelineE2E.test.ts` which pin exact `dateColumns` content), (ii) flipping `add_computed_columns` to persist-by-default — recorded as a product decision (Options A/B/C) the user picks explicitly, not a code-only wave, because of blob-storage / Cosmos-doc-size implications and the orthogonality of `derive_dimension_bucket`. Verified: 11/11 Wave-A tests, 5/5 download tests, 66/66 date-subsystem regression, server build clean, server tsc zero new errors over 99-error baseline, client tsc zero new errors over 52-error baseline.
- **2026-04-30** — **Wave DWD1 · Download Working Dataset.** New top-left "Download Dataset" button on the chat surface that streams the latest working dataset as XLSX, regardless of any active filter. Server route `GET /api/data-ops/download-working/:sessionId` ([`dataOpsController.ts:downloadWorkingDataset`](server/controllers/dataOpsController.ts)) reuses [`loadLatestData(chat, undefined, undefined, { skipActiveFilter: true })`](server/utils/dataLoader.ts#L202) so the file is identical to what the agent's tools see — same canonical row source priority chain (chunked → columnar → currentDataBlob → rawData → original blob), same wide-format auto-remelt via [`applyWideFormatMeltIfNeeded`](server/lib/wideFormat/applyWideFormatMeltIfNeeded.ts), same temporal-facet materialization via [`canonicalizeLoadedData`](server/utils/dataLoader.ts#L124-L134), and the Wave-FA non-destructive active filter is intentionally skipped so users always get the canonical unfiltered slice. Per-turn `add_computed_columns` outputs are present iff the agent passed `persistToSession: true` (matches next-turn agent visibility — by design). Client helper [`downloadWorkingDatasetXlsx`](client/src/lib/api/chat.ts) mirrors the existing [`downloadModifiedDataset`](client/src/lib/api/chat.ts) pattern (Content-Disposition filename parse → Blob → `<a download>` click). Button mounts as a third entry in the existing `absolute left-4 top-4` floating cluster at [`ChatInterface.tsx:728`](client/src/pages/Home/Components/ChatInterface.tsx#L728) alongside "Data Summary" and "Give Additional Context"; uses the `Loader2` spinner while the download is in flight. Filename: `<sanitizedFileName>_working_<YYYY-MM-DD_HHmmss>.xlsx` via the existing `sanitizeDownloadFileStem` + `downloadFilenameTimestamp` helpers. 4 new tests in [`tests/downloadWorkingDataset.test.ts`](server/tests/downloadWorkingDataset.test.ts) (appended to the explicit-file-list `test` script per CLAUDE.md): pin (a) ZIP magic bytes on the buffer, (b) Sheet1 with full unfiltered row count, (c) temporal facet columns (`Year · …`, `Month · …`) present in the header when `dataSummary.dateColumns` is non-empty, (d) **`skipActiveFilter:true` regression guard** — when an active filter is set on the chat document, the default `loadLatestData` narrows but the export still returns all canonical rows. Diagnosed-but-deferred (user can authorize separately): some temporal facet cells appear empty because (i) wide-format `latest_n` periods (`L12M`, `YTD-TY`) are unparseable by `parseFlexibleDate` so [`applyTemporalFacetColumns`](server/lib/temporalFacetColumns.ts#L430-L480) leaves Year/Quarter/Month null for those rows (CLAUDE.md WPF6-deferred), (ii) `add_computed_columns` is ephemeral unless `persistToSession:true`, (iii) `dirtyDateEnrichment` LLM batch fall-throughs leave `Cleaned_*` cells null and cascade into null facets. The download button now gives the user concrete evidence to decide which fix to authorize next.
- **2026-04-30** — **Wave WHD1 · domain-aware hypothesis planning.** Closed the only remaining domain-blind site in the agent loop: the hypothesis pre-planner. User asked "where is the FMCG/Marico/internet-search context — is it good enough?" Inventory confirmed packs flow into the planner prompt, the narrator W7 bundle, per-chart `businessCommentary` (W12), the chart-key-insight endpoint, and the `domainLens` envelope with W22 anti-hallucination citation check at [checkEnvelopeCompleteness.ts:117](server/lib/agents/runtime/checkEnvelopeCompleteness.ts#L117) wired at [agentLoop.service.ts:2833](server/lib/agents/runtime/agentLoop.service.ts#L2833) — but [hypothesisPlanner.ts](server/lib/agents/runtime/hypothesisPlanner.ts) and the merged W39 [runHypothesisAndBrief.ts](server/lib/agents/runtime/runHypothesisAndBrief.ts) didn't read `ctx.domainContext` even though it's already populated on the execution context (W34 hoist, [types.ts:175](server/lib/agents/runtime/types.ts#L175)). Hypotheses seed the entire investigation tree downstream, so a domain-blind hypothesis pass meant the agent often wouldn't think to test category seasonality, channel-mix shifts, commodity-cost lag, premiumisation, or sub-brand cannibalisation as candidate explanations even when the relevant pack was loaded into the same turn. Fix mirrors the W12 chart-commentary convention in [insightGenerator.ts:422-428](server/lib/insightGenerator.ts#L422): both `buildUserBlock` (legacy) and the merged W39 user-block now append a `FMCG / MARICO DOMAIN CONTEXT (background only — never numeric evidence; cite pack id when used)` block capped at 2 500 chars (a touch tighter than W12's 3k since the pre-planner is per-turn vs. per-chart). One matching rule line added to each system prompt: "When the FMCG / MARICO DOMAIN CONTEXT block is present, prefer hypotheses that test domain-relevant explanations (category seasonality, channel-mix shifts, commodity/input-cost lag, premiumisation, sub-brand cannibalisation, distribution gains/losses) over generic statistical fishing — but only when the data could plausibly answer them. Do not invent metric names; use only columns from the supplied schema." Cache-friendly: domain block lives in the *user* message (which varies per turn anyway); the system prompt only gets one new rule line, so the `ANALYST_PREAMBLE` static-prefix (>1024 token) cache eligibility is preserved on both paths. Zero plumbing change at call sites — `generateHypotheses(ctx, …)` and `runHypothesisAndBriefMerged(ctx, …)` already take the full execution context. 6 new tests in [`tests/hypothesisPlannerDomainContext.test.ts`](server/tests/hypothesisPlannerDomainContext.test.ts) (appended to the explicit-file-list `test` script per CLAUDE.md): pin (a) domain block in user prompt when set, (b) absent when undefined or whitespace-only — no empty-block leak, (c) cap at 2 500 chars on huge inputs, (d) same three on the merged W39 path. Verified: 6/6 new tests pass; 14/14 adjacent regression tests (existing hypothesis + W39 merged path) pass; 94/94 broader sweep across `agentTurnE2EW20`, `buildSynthesisContext`, `narratorAgent`, `checkDomainLensCitationsW22`, `domainContextWiring`, `synthesisFallback`, `insightGeneratorBusinessCommentaryW12`, `agentRuntimeSchemas`, `llmStubHarnessW18` passes; `npx tsc --noEmit` introduces zero new errors over baseline (the two errors at [hypothesisPlanner.ts:43-44](server/lib/agents/runtime/hypothesisPlanner.ts#L43) on `ctx.sessionAnalysisContext?.sessionContext` are pre-existing — verified by stashing the edit and counting). Out of scope, recorded in the plan: domain-awareness in the coordinator agent (currently dormant under single-flow policy), contextAgent round-2 RAG (data-finding-driven by design), and the mode classifier (orthogonal); a hard-coded FMCG-trigger heuristic for `web_search` (pure LLM judgment is working, hand-rolled keyword triggers tend to misfire); and question-driven pack selection (the 12k token budget + priority sort already handles selection well enough).
- **2026-04-29** — **Wide-format post-melt correctness (Waves WPF1–WPF8).** Closed six structural gaps where parts of the agent pipeline reasoned against stale wide-format mental models on auto-melted datasets (WF1–WF10 baseline). User report: "some answers correct, some wrong on the same wide-format dataset." Three parallel Explore-agent diagnostics confirmed the upload-time pipeline was sound but the planner / narrator / executors had zero awareness of the melt and zero guards against the new long-form schema's special semantics; one fallback data-load path silently re-read the original wide buffer without re-melting. Each gap was independently sufficient to produce wrong answers, fully explaining the "sometimes right, sometimes wrong" pattern.
  - **WPF1 — DATASET SHAPE prompt block.** New `formatWideFormatShapeBlock(summary)` in [`server/lib/agents/runtime/context.ts`](server/lib/agents/runtime/context.ts) emits a labelled block when `summary.wideFormatTransform.detected`. Teaches the LLM: (a) "this dataset arrived in WIDE format and was MELTED to LONG form at upload time", (b) Period (raw label) vs PeriodIso (canonical sortable) — always sort time queries by PeriodIso, (c) for compound shape, NEVER aggregate Value without filtering by Metric (lists distinct metric values from `topValues`), (d) original wide column names that NO LONGER EXIST (capped at 20). Wired into `summarizeContextForPrompt`. Mirrored into the narrator's data-understanding block via [`buildSynthesisContext.ts`](server/lib/agents/runtime/buildSynthesisContext.ts) so the answer envelope phrases magnitudes in metric-aware language ("value sales", "volume") not raw "Value". 6 unit tests in [`tests/wideFormatShapeBlock.test.ts`](server/tests/wideFormatShapeBlock.test.ts).
  - **WPF2 — deterministic compound-shape Metric-filter guard.** New `injectCompoundShapeMetricGuard(step, wideFormatTransform, question, distinctMetricValues)` in [`planArgRepairs.ts`](server/lib/agents/runtime/planArgRepairs.ts), runs in [`planner.ts`](server/lib/agents/runtime/planner.ts) right after `injectRollupExcludeFilters` (mirrors the H3 pattern). For compound-shape datasets, when a step touches `valueColumn` AND no `Metric` filter exists AND `Metric` isn't already in `groupBy`: (a) match the user question against a metric vocabulary (sales/revenue → value-sales family, volume/units → volume family, distribution/price/etc.), (b) inject `dimensionFilter: {column: Metric, op: in, values: [matched]}` for single-metric intent, (c) expand `groupBy` with `Metric` for cross-metric intent ("compare sales vs volume"), (d) fall back to value-sales heuristic when the question is metric-ambiguous (FMCG-pragmatic — better than letting the SUM mix everything). Covers `execute_query_plan`, `breakdown_ranking`, `run_two_segment_compare`, `run_correlation`, `run_segment_driver_analysis`. New `extractDistinctMetricValues(rows, metricColumn)` helper feeds the planner with the dataset's actual metric values; planner.ts hoists this once per turn. 21 unit tests in [`tests/compoundMetricGuard.test.ts`](server/tests/compoundMetricGuard.test.ts).
  - **WPF3 — Period-sort patch (chronological via PeriodIso).** Pre-fix: `dataTransform.applySort` lexicographic-sorted Period values, producing "Q1 24" before "Q2 23" — every trend chart was internally scrambled. Fix: [`applySort`](server/lib/dataTransform.ts) accepts an optional `summary` parameter and remaps Period sort to look up the parallel `PeriodIso` value on each row. The DuckDB SQL builder [`buildQueryPlanDuckdbSql`](server/lib/queryPlanDuckdbExecutor.ts) gets the same treatment: when groupBy includes the wide-format `periodColumn` AND the `periodIsoColumn` exists in the table, also add it to SELECT + GROUP BY (server-side hidden) and emit `ORDER BY periodIsoColumn ASC` by default; explicit Period sorts get rewritten to PeriodIso preserving ASC/DESC direction. Added `hiddenColumns?: string[]` to `BuildQueryPlanDuckdbSqlResult`; `executeQueryPlanOnDuckDb` strips them from result rows so callers see only the planner-requested columns. 9 unit tests in [`tests/wideFormatPeriodSort.test.ts`](server/tests/wideFormatPeriodSort.test.ts).
  - **WPF4 — fallback blob re-parse must re-melt.** Closed the silent-corruption hot path: large wide files (>10 000 rows) had empty `chatDocument.rawData` and no `currentDataBlob`, so [`dataLoader.loadLatestData`](server/utils/dataLoader.ts) re-parsed the original wide buffer via `parseFile`, returning **wide rows** which were then handed to in-memory tools alongside the post-melt `dataSummary.numericColumns: ["Value"]` — silent column-shape mismatch. New shared helper [`applyWideFormatMeltIfNeeded(rows, dataSummary)`](server/lib/wideFormat/applyWideFormatMeltIfNeeded.ts) re-classifies + re-melts when `dataSummary.wideFormatTransform.detected` and the rows look wide. Wired into both `dataLoader.ts` fallback paths (currentDataBlob CSV branch L323 + original blob CSV branch L397) AND the `revert` path in [`dataOpsOrchestrator.ts:5358`](server/lib/dataOps/dataOpsOrchestrator.ts) so "revert to original" returns the post-melt analytical canonical, not the raw wide buffer. Defensive: detects already-long-form rows by header presence (Period+PeriodIso+Value) so currentDataBlob's pre-stored long JSON isn't double-melted. New log line `[dataLoader] re-applied wide-format melt on ... re-parse path` for production grep. 5 unit tests in [`tests/applyWideFormatMeltIfNeeded.test.ts`](server/tests/applyWideFormatMeltIfNeeded.test.ts).
  - **WPF5 — column resolver refuses stale wide-column matches.** Pre-fix: [`columnMatcher.findMatchingColumn`](server/lib/agents/utils/columnMatcher.ts) and [`plannerColumnResolve.resolveToSchemaColumn`](server/lib/agents/runtime/plannerColumnResolve.ts) silently substring-matched agent-emitted "Q1 23 Value Sales" to the live "Value" column — running the analysis on the wrong axis. Fix: both functions accept an optional `wideFormatTransform` parameter; when the requested name matches an entry in `meltedColumns` (case-insensitive), refuse the match and return null (or the raw input passthrough) so downstream Zod / column-allowlist validation surfaces a clear error. Threaded through `normalizeExecuteQueryPlanStepArgs`, `normalizeCorrelationStepArgs`, `normalizeRunSegmentDriverStepArgs` in `planner.ts`. The legacy two-arg `findMatchingColumn` and `resolveToSchemaColumn` signatures still work — backwards-compatible opt-in. 8 unit tests in [`tests/wideFormatColumnResolverGuard.test.ts`](server/tests/wideFormatColumnResolverGuard.test.ts).
  - **WPF6 — PeriodIso surfaced as temporal axis on dateColumns line.** When `wideFormatTransform.detected`, `summarizeContextForPrompt` appends `PeriodIso (canonical period — see DATASET SHAPE block)` to the dateColumns line so the planner doesn't go hunting for a real date column that doesn't exist. Out of scope (deferred): teaching `parseFlexibleDate` to parse ISO period strings like "2023-Q1" / "L12M-2YA" so the existing temporal facet machinery (`Year · …` / `Quarter · …` derived columns) can auto-bucket on PeriodIso — that's a larger refactor and WPF1+WPF3 close the user-visible bug already. Test pinned in [`tests/wideFormatShapeBlock.test.ts`](server/tests/wideFormatShapeBlock.test.ts).
  - **WPF7 — pivot defaults pre-select a Metric for compound shape.** [`mergePivotDefaultRowsAndValues`](server/lib/pivotDefaultsFromExecution.ts) appends the `metricColumn` to `filterFields` with a value-sales-family value pre-selected when compound shape is detected AND the trace plan didn't already pin the Metric column to rows / columns / filters. Without this, the default rendered pivot SUMs Value across mixed metrics — same root cause as gap #2 but in pivot land. Heuristic prefers value-sales family; falls back to first distinct metric alphabetically. 5 unit tests in [`tests/wideFormatPivotDefaults.test.ts`](server/tests/wideFormatPivotDefaults.test.ts).
  - **WPF8 — golden e2e on compound-shape fixture.** New [`tests/wideFormatPostMeltPipelineE2E.test.ts`](server/tests/wideFormatPostMeltPipelineE2E.test.ts) parses an inline 2-brand × 4-quarter × 2-metric wide CSV through the full pipeline (parseFile → classifyDataset → meltDataset → applyWideFormatTransformToSummary → injectCompoundShapeMetricGuard → buildQueryPlanDuckdbSql → applyWideFormatMeltIfNeeded), asserts the contract end-to-end. Pins: (a) compound shape detected, (b) 16 long rows after melt with VND-tagged Value column, (c) compound guard injects `Metric IN ['Value Sales']` for sales-intent question, (d) DuckDB SQL adds `PeriodIso` to GROUP BY + `ORDER BY PeriodIso ASC` + strips it via `hiddenColumns`, (e) fallback re-parse helper restores 16 long rows from the wide buffer.
  - **Conventions added.** (1) **Wide-format awareness flows through three signals**, all gated on `summary.wideFormatTransform.detected`: the `formatWideFormatShapeBlock` prompt block (WPF1), the `injectCompoundShapeMetricGuard` planner repair (WPF2), and the executor-side hidden ISO column (WPF3). New tools that read the dataset shape should consume the same signal — never re-derive shape from heuristics. (2) **`Period` is for human display, `PeriodIso` is for sorting/joining.** This split is now load-bearing across the planner prompt (WPF1), in-memory `applySort` (WPF3), DuckDB ORDER BY (WPF3), and the dateColumns-line surfacing (WPF6). Don't sort by `Period` — always remap to `PeriodIso`. (3) **Compound-shape SUM(Value) without a Metric filter is forbidden.** The deterministic guard fails closed (heuristic value-sales fallback) rather than letting mixed-metric aggregation through. New tools that aggregate the value column on a compound dataset must check `wideFormatTransform.metricColumn` and either filter by Metric or expand groupBy to include it. (4) **All blob-re-parse paths must run `applyWideFormatMeltIfNeeded`.** Direct `parseFile` of the original blob returns wide rows; the post-melt `dataSummary` describes long form. New code reading from `chatDocument.blobInfo.blobName` outside the upload pipeline must call the helper or the analytical caller will silently see the wrong shape.
  - **Out of scope for this stream** (recorded so future-Claude doesn't reopen them): (a) `dataset.shape: 'long' | 'wide-melted'` field on `SessionAnalysisContext` — WPF1's prompt block carries the same information without a schema migration. (b) Snowflake-import auto-melt detection — Snowflake views are typically already long; pivoted views are out-of-scope edge case. (c) `parseFlexibleDate` understanding of ISO period strings (`2023-Q1`, `L12M-2YA`) so the temporal facet machinery can derive `Year · PeriodIso` / `Quarter · PeriodIso` buckets — WPF1+WPF3+WPF6 close the user-visible sort bug already; auto-buckets on PeriodIso would need a larger refactor of date inference. (d) RAG re-indexing for sessions uploaded before WF7 (2026-04-29) — fresh uploads since then index post-melt schema correctly; stale sessions need a one-shot migration script, not a code fix. Verified: all 1953 server tests pass (1862 baseline + ~91 new across WPF1–8); zero new TypeScript errors over baseline (8 pre-existing errors in `scripts/` and `services/chat/` unchanged); `tests/wideFormatPipeline.test.ts` (WF10 golden) still passes — upload pipeline shape was untouched.
- **2026-04-29** — **Dimension hierarchies — full v2 (Waves H6, AD1, EU1, RD1, ML1).** Closed all five deferred items from the H1–H5 stream so the rollup-aware analysis story is complete end-to-end.
  - **H6 · UI banner.** New [`DimensionHierarchiesBanner.tsx`](client/src/components/DimensionHierarchiesBanner.tsx) renders above the Dataset Columns chips when any hierarchy is declared. Collapsed default with a one-line summary; expanded shows column · rollup · `auto` badge (when `source: "auto"`) · children · description. Threaded via [`Home.tsx`](client/src/pages/Home/Home.tsx) (derives from lifted SAC) → [`ChatInterface.tsx`](client/src/pages/Home/Components/ChatInterface.tsx) → [`MessageBubble.tsx`](client/src/pages/Home/Components/MessageBubble.tsx) → [`DataPreview.tsx`](client/src/pages/Home/Components/DataPreview.tsx) → [`ColumnsDisplay.tsx`](client/src/pages/Home/Components/ColumnsDisplay.tsx). The H5 SSE handler in [`useHomeMutations.ts`](client/src/pages/Home/modules/useHomeMutations.ts) was widened to also push `dimensionHierarchies` into the lifted SAC, so the banner refreshes the same turn the user declares "X is the category" — no page reload needed.
  - **AD1 · upload-time auto-detection.** New [`detectRollupHierarchies.ts`](server/lib/detectRollupHierarchies.ts) runs after the SAC seed in [`uploadQueue.ts`](server/utils/uploadQueue.ts). For each (dimension, measure) pair it computes per-value sums and checks two strict thresholds — top value's share ≥ 70 % of column total AND top value ≥ 4× the runner-up — to reject false positives like 60 %-share market leaders or 80/20 splits. Picks the strongest measure when several exist. Stamps results onto `sessionAnalysisContext.dataset.dimensionHierarchies` with `source: "auto"`. The H2 immutability guard was simplified in lockstep: `withImmutableUserIntentFromPrevious` in [`sessionAnalysisContextGuards.ts`](server/lib/sessionAnalysisContextGuards.ts) now preserves ALL prior hierarchies (user + auto) across assistant merges — assistants never mutate dimension structure; only the user-merge LLM and the EU1 endpoint can change it. The pre-AD1 H2 logic dropped previous-auto entries on the first assistant merge, which would have wiped upload-time detections; the existing H2 test was rewritten to pin the new contract.
  - **EU1 · in-banner remove + PUT endpoint.** New `PUT /api/sessions/:sessionId/hierarchies` ([`sessions.ts`](server/routes/sessions.ts) + [`putSessionHierarchiesEndpoint`](server/controllers/sessionController.ts)) replaces the entire hierarchies array atomically via a new helper [`updateSessionDimensionHierarchies`](server/lib/sessionAnalysisContext.ts) that uses the same per-session mutex chain as the assistant merge. Body validated with `dimensionHierarchySchema`, capped at 20 entries. New client API [`sessionsApi.updateSessionHierarchies`](client/src/lib/api/sessions.ts). The banner shows a ✕ button per entry (mirrors the `wideFormatTransform` pattern); click → optimistic `onChange` callback updates the lifted SAC, banner re-renders without a refetch. Spinner during the network round-trip; inline error line with the failure reason if the PUT rejects. To ADD a hierarchy, the user re-states it in chat — the H5 chat-flow path extracts and persists it. The footer hint inside the banner tells the user this explicitly.
  - **RD1 · share-of-category denominator intent.** Extended H3's "skip rollup-exclude" check beyond the existing rollup-value mention. New [`shouldSkipRollupExclude`](server/lib/agents/runtime/planArgRepairs.ts) recognises share/contribution/%/fraction/portion/proportion patterns combined with EITHER the column name OR a generic category keyword (`category`/`total`/`overall`/`whole`/`entire`). When matched, the not_in filter is suppressed so the rollup row stays in the data, and a new `DETECTED INTENT — share-of-category` block is appended to the H4 hierarchy prompt instructing the LLM to use the rollup AS the denominator (`MARICO 6000 / FSG 68751 = ~9 %`, NOT `MARICO / sum-of-others`). Fix-along: an early version used `\b%\b` which fails because `%` is a non-word char (no word boundary between two non-word chars in `" % of"`); rewrote to `(?:\b(?:share|...)\b|%)\s+(?:of|...)\b`. Narrator system prompt got one matching guidance line. New [`classifyHierarchyIntent`](server/lib/agents/runtime/planArgRepairs.ts) reports per-hierarchy intent (`share-of-category` / `rollup-mention` / `peer-comparison`) used by the H4 block.
  - **ML1 · multi-level same-column hierarchies.** The schema already allowed multiple entries per column (`z.array(...).max(20)`), but H3's `find()` returned only the first match — so a 3-level Geography hierarchy (`World` → `Asia` → `India`) had only the top level excluded, the inner levels still polluted breakdowns. Switched to `filter()` that collects ALL rollup values for the groupBy column, applies per-value override checks (mention or share-of-category), and emits ONE consolidated `not_in` filter with all surviving values. Override-by-mention works at the level the user names: "show me Asia by country" excludes World + India but keeps Asia. Existing rollup values already in a `not_in` filter are detected and not double-added. Extended `MERGE_USER_SYSTEM` prompt with a multi-level example so the user-merge LLM emits one entry per nested rollup. The H4 banner already rendered each entry on its own line; no template change needed.
  - **Conventions added / changed.** (1) **`source: "user"` AND `source: "auto"` are both immutable across assistant merges.** Only the user-merge LLM (chat-flow extraction or PATCH endpoint) and the EU1 PUT endpoint can change `dimensionHierarchies`. The pre-AD1 distinction (user immutable, auto mutable) was a latent bug — once auto-detection landed, assistant merges would silently drop them. (2) **Auto-detection thresholds are intentionally strict.** Heuristic minimums of 70 % column share AND 4× runner-up ratio are tuned to reject market leaders and Pareto distributions. False negatives (heuristic misses a real category total) are acceptable because the user can always declare it in chat. False positives are unacceptable because they silently exclude the row from breakdowns and degrade the answer without explanation. (3) **Multi-level hierarchies are flat in storage, hierarchical in semantics.** No tree structure in the schema — multiple entries per column with independent `rollupValue` strings. The H3 logic treats them as a flat set during exclude-filter computation, which is correct for "give me peers" intent; the LLM handles the implicit nesting in narrative. Verified: 1862/1862 server tests pass (full suite, no flake this time); 198/198 client vitest pass; client tsc 52-error baseline preserved (zero new errors); both production builds OK.
- **2026-04-29** — **Excel-style non-destructive Filter Data overlay (Waves FA1–FA5).** The legacy "Filter Data" button mounted a 3-step modal (column → operator → value) that built a chat message like `"filter data where Products != FEMALE SHOWER GEL"` and routed through the data-ops orchestrator's `case 'filter'`, which called `saveModifiedData` — every filter wrote a new blob version, replaced `rawData`, regenerated `dataSummary` + `columnStatistics`, scheduled RAG reindex, and pushed an entry into `dataVersions`. The original was preserved in `blobInfo` (only used by `revert`), but each filter was a heavyweight blob round-trip with side-effects. Two visible problems: (a) the UI was a builder, not Excel; (b) once the chat scrolled, the user had no idea they were on a filtered slice.
  - **FA1** — schema + pure fns. Added `activeFilterSpecSchema` to [`server/shared/schema.ts`](server/shared/schema.ts) (`{conditions: ({kind:"in"|"range"|"dateRange", column, …})[], version, updatedAt}`) and `activeFilter?: ActiveFilterSpec` on `ChatDocument`. New [`server/lib/activeFilter/applyActiveFilter.ts`](server/lib/activeFilter/applyActiveFilter.ts) (in-memory predicate, reuses `pivotDimensionStringKeyForChartFilter` for value normalization) and [`server/lib/activeFilter/buildActiveFilterSql.ts`](server/lib/activeFilter/buildActiveFilterSql.ts) (composes existing `quoteIdent` / `escapeSqlStringLiteral` from [`pivotFilterSql.ts`](server/lib/pivotFilterSql.ts) — never hand-rolled escapes). 21 unit tests in [`tests/applyActiveFilter.test.ts`](server/tests/applyActiveFilter.test.ts) and [`tests/buildActiveFilterSql.test.ts`](server/tests/buildActiveFilterSql.test.ts) cover in / range / dateRange / SQL injection / multi-condition AND / empty result.
  - **FA2** — read-side enforcement. `loadLatestData` in [`server/utils/dataLoader.ts`](server/utils/dataLoader.ts) gained a `skipActiveFilter?: boolean` option; when not set, every analytical caller (chat turn, dashboard chart load, chart-key-insight refresh, data-ops bridge, public sessions endpoints) automatically receives filtered rows. The DuckDB rematerialize path (`ensureSessionDuckdbMaterialized`) opts out via `skipActiveFilter: true` so the canonical `data` table is never destroyed by filter changes. New [`resolveSessionDataTable`](server/lib/activeFilter/resolveSessionDataTable.ts) issues `CREATE OR REPLACE VIEW data_filtered AS SELECT * FROM data WHERE <expr>` (idempotent on `activeFilter.version`) and returns the right table name. [`queryPlanDuckdbExecutor`](server/lib/queryPlanDuckdbExecutor.ts), [`pivotQueryService`](server/lib/pivotQueryService.ts), [`duckdbPlanExecutor`](server/lib/duckdbPlanExecutor.ts), and the `pivot/drillthrough` endpoint in [`dataApi.ts`](server/routes/dataApi.ts) all route through it. The pivot `cacheKey` now includes `activeFilterVersion` so changing the filter invalidates pivot results without manual flushing. The pivot/fields distinct-values endpoint accepts `?excludeColumn=` so opening the Region filter shows all Regions narrowed only by *other* active conditions (Excel cross-column behavior).
  - **FA3** — controller + UI panel + API client. New [`activeFilterController.ts`](server/controllers/activeFilterController.ts) with `GET / PUT / DELETE /api/sessions/:sessionId/active-filter`, mutex-serialized per session (W40 pattern), wired in [`routes/sessions.ts`](server/routes/sessions.ts). The PUT/DELETE response includes the filtered row count + 50-row preview so the client doesn't need a second round-trip. Replaced the legacy modal with [`client/src/components/FilterDataPanel.tsx`](client/src/components/FilterDataPanel.tsx) — a right-side slide-in `Sheet` listing every column with per-column expand-to-filter (multi-select for categorical via `fetchPivotColumnDistincts(..., { excludeColumn })`, min/max range for numeric, date range for dates). Filter changes debounce ~250 ms and POST automatically; closing the panel does not clear the filter. New API client methods: `sessionsApi.getActiveFilter / setActiveFilter / clearActiveFilter`.
  - **FA4** — chip strip + button highlight + chat-input reroute + revert. New [`client/src/components/ActiveFilterChips.tsx`](client/src/components/ActiveFilterChips.tsx) renders above the chat scroll area when conditions are set; each chip has a ✕ to remove that one condition, plus a "Clear all" button. The "Filter Data" button in [`ChatInterface.tsx`](client/src/pages/Home/Components/ChatInterface.tsx) becomes solid-primary with a count badge when active. The natural-language `'filter'` data-op intent in [`dataOpsOrchestrator.ts`](server/lib/dataOps/dataOpsOrchestrator.ts) now translates to `ActiveFilterSpec` when all operators are representable (`=`, `in`, `>=`, `<=`, `>`, `<`, `between`) and writes via [`persistActiveFilter.ts`](server/lib/activeFilter/persistActiveFilter.ts) — no more `saveModifiedData`, no more blob/`rawData` mutation. Operators not modelable as active filter (`!=`, `contains`, `startsWith`, `endsWith`) keep the legacy destructive path with a console warning so we know which sessions still hit it. The `revert` data-op now also clears the active filter so users return to a clean canonical state in one operation.
  - **FA5** — direct-rawData reads + chartResponse + cache audit. Three places that bypass `loadLatestData` were wrapped in `applyActiveFilter`: the data-preview endpoints in [`dataRetrievalController.ts`](server/controllers/dataRetrievalController.ts) (so the preview matches what analyses see), the chart enrichment fallback at `chatResponse.service.ts:50` (so chart insights derive from the filtered slice), and `runDataOpsFromAgent` (so agent-routed data ops also see the slice). The `getAnalysisData*` endpoints now also return `activeFilter` so clients hydrate state on session load. Deleted dead `client/src/components/FilterDataModal.tsx`; slimmed `ColumnFilterDialog.tsx` to a type-only export consumed by `FilterAppliedMessage` and `MessageBubble` for rendering historical chat bubbles.
  - **FA6** — dashboard provenance capture. Added `capturedActiveFilter?: ActiveFilterSpec` to both `dashboardSchema` and `dashboardSpecSchema`. The agent-loop auto-create site at [`agentLoop.service.ts`](server/lib/agents/runtime/agentLoop.service.ts) and the `POST /api/dashboards/from-spec` controller both snapshot `chatDocument.activeFilter` onto the spec at creation time (controller falls back to looking up the session if the client didn't include it). [`createDashboardFromSpec`](server/models/dashboard.model.ts) persists the snapshot. The chart data inside the dashboard is already filtered (it was loaded via `loadLatestData` before being snapshotted), so the captured filter is **provenance metadata, not a re-applied predicate** — chart numbers don't change at view time. New [`CapturedFilterBanner.tsx`](client/src/pages/Dashboard/Components/CapturedFilterBanner.tsx) renders below the dashboard header when present ("Captured with filter: Region ∈ {North}. Numbers reflect the filtered slice at the time this dashboard was created."). Client `DashboardData` shape and `normalizeDashboard` in [`useDashboardState.ts`](client/src/pages/Dashboard/modules/useDashboardState.ts) carry the field through. Dashboards created without an active filter behave exactly as today.
  - **Conventions added.** (1) **The canonical `data` table is inviolate.** Filters create the `data_filtered` view via `CREATE OR REPLACE VIEW`; `data` is rebuilt only by upload / data-ops `revert`. Tests that materialize tables directly should call the rematerialize path with `skipActiveFilter: true` (already the default for `ensureAuthoritativeDataTable`). (2) **All analytical reads go through `loadLatestData` or `resolveSessionDataTable`.** New tools that read row data must pick one — never `chatDocument.rawData` directly, otherwise the filter silently bypasses (the three known direct-read sites are wrapped explicitly; new direct reads will fail to honor the filter and surprise users). (3) **RAG retrieval is unaffected by the active filter** — `retrieve_semantic_context`, the contextAgent multi-round, and `indexSession.ts` continue to embed canonical chunks. Documented in `applyActiveFilter`'s JSDoc to prevent a future "fix" from narrowing it. (4) **Cache keys must include `activeFilter.version`** — pivot cache already does; future caches around filtered data must follow suit, otherwise the agent will return yesterday's pre-filter aggregates.
- **2026-04-29** — **User-told dimension hierarchies (Waves H1–H5).** When a user uploads data where one row in a dimension column is a category total that rolls up the other rows in the same column (e.g. Marico-VN: `FEMALE SHOWER GEL` totals `MARICO + PURITE + OLIV + LASHE` in the `Products` column), the agent used to treat the parent and children as siblings, so every breakdown was dominated by the category at ~88% — mathematically just "the parent always wins". Now the user can tell the system once ("FEMALE SHOWER GEL is the entire category. Marico, Purite, Oliv, Lashe are products within it.") and that fact persists for the rest of the session: peer-comparison aggregations on `Products` deterministically exclude the rollup row, and the planner + narrator are explicitly told to frame the rollup as a category, not a competing item.
  - **H1** — schema. Added `dimensionHierarchySchema` and `dataset.dimensionHierarchies?: DimensionHierarchy[]` to [`sessionAnalysisContextSchema`](server/shared/schema.ts) (re-exported through [`client/src/shared/schema.ts`](client/src/shared/schema.ts)). Shape: `{ column, rollupValue, itemValues?, source: "user" | "auto", description? }`. Optional with no default — pre-existing Cosmos docs parse unchanged.
  - **H2** — capture. Extended `MERGE_USER_SYSTEM` in [`sessionAnalysisContext.ts`](server/lib/sessionAnalysisContext.ts) so the existing user-merge LLM populates `dimensionHierarchies` from "X is the category / Y is rolled up / are products within …" phrasings. Tightened [`sessionAnalysisContextGuards.ts`](server/lib/sessionAnalysisContextGuards.ts) `withImmutableUserIntentFromPrevious` to also pin `source: "user"` hierarchies across assistant merges (assistant-introduced `source: "auto"` entries can still be replaced — that's the H6+ auto-detect seam). The H5 chat-flow wiring (below) calls `extractAndPersistUserHierarchies`, which gates on a deterministic regex pre-check (`shouldExtractUserHierarchies`) before paying for the user-merge LLM call — routine analytical questions don't fire it.
  - **H3** — deterministic filter injection. New [`injectRollupExcludeFilters`](server/lib/agents/runtime/planArgRepairs.ts) is called from [planner.ts](server/lib/agents/runtime/planner.ts) right after `ensureInferredFiltersOnStep`. For every step with `groupBy` / `breakdownColumn` matching a declared hierarchy column, it appends a `not_in` filter against the rollup value (`match: "case_insensitive"`). Three skip cases: (a) the user's question text mentions the rollup value (override-by-mention — they're asking *about* the rollup), (b) an existing `in`-filter on that column already includes the rollup value (explicit user-driven inclusion wins), (c) an existing `not_in`-filter already excludes it. Targets `execute_query_plan.plan.groupBy` and `breakdown_ranking.breakdownColumn`; the executor's `not_in` op was already supported, so no SQL/exec changes were needed.
  - **H4** — prompt awareness. New [`formatDimensionHierarchiesBlock`](server/lib/agents/runtime/context.ts) emits a labelled `DIMENSION HIERARCHIES (declared by the user — treat as ground truth):` block listing each hierarchy with its column, rollup value, optional children, and a footer reminder about peer-comparison exclusion. Threaded into `summarizeContextForPrompt` for the planner and into the narrator user message in [`narratorAgent.ts`](server/lib/agents/runtime/narratorAgent.ts). The narrator system prompt also gets one new static rule line ("when the user message includes a DIMENSION HIERARCHIES block, treat the listed rollup values as category totals — never as competing items …") — kept static so the system prefix stays cache-stable.
  - **H5** — chat-input extraction + SSE + RAG. The user's clarification was typed into the chat input box (not the "Add context" PATCH endpoint), so the existing user-merge LLM never ran on it. Added `extractAndPersistUserHierarchies` to [`sessionAnalysisContext.ts`](server/lib/sessionAnalysisContext.ts) (regex-gated user-merge LLM call, persists via the same per-session mutex chain as `persistMergeAssistantSessionContext`, returns the new SAC only when `dimensionHierarchies` actually changed). Wired into [`chatStream.service.ts`](server/services/chat/chatStream.service.ts) right after mode classification — runs before the agent loop so the planner sees the hierarchy on the same turn the user declares it. The `session_context_updated` SSE event fires immediately with the new `dimensionHierarchies` field; the post-turn emit was widened to also include hierarchies. The RAG `user_context` chunk in [`rag/chunking.ts`](server/lib/rag/chunking.ts) appends a "Declared dimension hierarchies (treat as ground truth …)" section so retrieval-side context picks them up too; `buildChunksForSession` now emits the chunk when EITHER `permanentContext` OR hierarchies exist (was: only when permanentContext).
  - **H6 deferred (UI chip).** Plan flagged this as "polish, defer if tight". The end-to-end behavior change is visible in the analysis output (FEMALE SHOWER GEL no longer dominates the breakdown; the narrator phrases findings as "within the FEMALE SHOWER GEL category, MARICO leads at …"). A read-only "Defined hierarchies" chip in [`ColumnsDisplay.tsx`](client/src/pages/Home/Components/ColumnsDisplay.tsx) — mirroring the `wideFormatTransform` deep prop-drill through `useHomeState` → `useHomeMutations` → `Home.tsx` → `ChatInterface` → `MessageBubble` → `DataPreview` → `ColumnsDisplay` — is the natural follow-up wave.
  - **Out of scope for this stream**, recorded explicitly in [the plan](/Users/tida/.claude/plans/letting-the-app-know-bright-haven.md): (a) auto-detection of rollup rows at upload time (heuristic `max(value) ≈ sum(others)` plus an LLM check inside [`datasetProfile.ts`](server/lib/datasetProfile.ts) — would set `source: "auto"`); (b) rewriting share/contribution questions to use the rollup row as denominator (needs intent classification that can misfire); (c) multi-level hierarchies and cross-column hierarchies (e.g. `Region → All Regions`); (d) editable add/remove UI for hierarchies. v1 ships one user-told rollup per column, deterministically excluded from peer comparisons.
  - **Conventions added.** (1) **`source: "user"` SAC fields are immutable across assistant turns.** The `withImmutableUserIntentFromPrevious` guard now pins user hierarchies in addition to user intent — assistant-merge prompts that try to drop them get overridden. Auto-detected entries (H6+) will use `source: "auto"` and remain mutable. (2) **Deterministic filter injection runs in `planner.ts` after `ensureInferredFiltersOnStep`, never inside individual tools.** This keeps the rollup-exclude logic in one place and uniform across all `dimensionFilters`-aware tools. (3) **The user-merge LLM call is regex-gated for chat-input messages.** `shouldExtractUserHierarchies(text)` checks for hierarchy keywords ("category", "rollup", "are products within …", etc.) before paying for an LLM call — routine analytical questions like "what are sales by region?" don't trigger it. The PATCH `/api/sessions/:id/context` endpoint still runs the user-merge unconditionally because that flow is explicitly user-initiated for context updates. Verified: 250/250 pass across the new tests + adjacent regression sweep (schema, planArgRepairs, planner/narrator prompts, chunking, SSE, agent E2E); full server suite at 1776/1777 with one unrelated flake in `streamingNarratorW38.test.ts` ("Unable to deserialize cloned data" — node:test worker serialization hiccup that passes deterministically in isolation).
- **2026-04-29** — **Wave PF3 · pivot FILTERS shelf — strip paging/server-search complexity, always fetch full distincts.** User clarified that the FILTERS popover should access the full dataset's distinct values for any column — same authoritative DuckDB `data` table the agent's tools see — and that there's no need for the `hasMore`/paged-dimension/server-search-typeahead complexity introduced in PF1/PF2 ("the app should get access to the entire dataset like all the other internal tools and agents, and then choose the values to be filtered from there"). They also confirmed that the agent's final answer was always correct in production — the bug was strictly in the pivot section's chart and pivot UI rendering, never in the agent path. PF3 simplifies accordingly. (1) [`fetchPivotColumnDistincts`](client/src/lib/api/data.ts) signature collapsed back to `(sessionId, column, limit?) => Promise<string[]>` (dropped `q` parameter and the `PivotColumnDistinctsResult` envelope with `hasMore`/`cardinality`); default `limit` bumped 2000 → **100 000** (defensive ceiling, not a paging window — any realistic FMCG dimension is well below it). (2) [`syncFilterSelectionsWithFilters`](client/src/lib/pivot/buildPivotModel.ts) `hasMoreByField` parameter removed; restored the simple "no hint → auto-fill all loaded distincts" behavior, with a stale-hint guard (hint that doesn't intersect distincts → fall back to all) since distincts are now always authoritative. (3) [`DataPreviewTable.tsx`](client/src/pages/Home/Components/DataPreviewTable.tsx): dropped `sessionFilterDistinctsHasMore` state + `handleSearchPivotDistincts` callback (the server-search round-trip); restored the unconditional `isAll → omit field from payload` optimization (the snapshot is always the full set now, so `selected == snapshot` truly means "no filter applied"). The `sessionFilterDistinctsErrors` state, `filterDistinctsRetryNonce`, and the render-time-derived `filterDistinctsResolution: Record<string, 'loading' | 'loaded' | 'error'>` map all stay — those are the right guarantees regardless of paging. (4) [`PivotFieldPanel.tsx`](client/src/pages/Home/Components/pivot/PivotFieldPanel.tsx) `FilterFieldRow`: dropped `hasMore`, `onSearch`, the search-debounce `useEffect` + seq ref, and the `isPagedNoSelection` branch. Replaced the conditional "Showing partial list — type to search the full dataset" hint with a simple client-side substring filter `Input` (no network, no debounce) shown only when the loaded list has > 8 values. (5) [`PivotHeaderSliceFilter.tsx`](client/src/pages/Home/Components/pivot/PivotHeaderSliceFilter.tsx) updated for the new `string[]` return shape. (6) Tests: rewrote [`syncFilterSelections.vitest.test.ts`](client/src/lib/pivot/syncFilterSelections.vitest.test.ts) (6 tests now pinning the simpler contract: no-hint auto-fill, hint intersection, stale-hint fallback, sample-row fallback, field removal, selection preservation); rewrote [`agentFilterAutoApply.vitest.test.ts`](client/src/lib/pivot/agentFilterAutoApply.vitest.test.ts) (3 tests pinning the "show FEMALE SHOWER GEL only" → chip flow + the snapshot-equals-selection round-trip contract). Verified: `cd client && npm test` 198/198 pass; `npx tsc --noEmit` 52 errors total (identical to post-PF2 baseline — zero new errors). No server changes — the existing `/api/data/:sessionId/pivot/fields` endpoint already supports any limit value via the query string. Agent path (planner / executor / narrator / synthesis) untouched, as PF1/PF2/PF3 only ever modified client-side pivot rendering files.
- **2026-04-29** — **Wave PF2 · pivot FILTERS shelf — flicker fix, paged-dimension semantics, error retry, and auto-apply tests.** Critical follow-up to PF1 closing three real defects in PF1 plus locking in the agent-filter auto-apply contract. (1) **Sub-frame flicker** in [`PivotFieldPanel.tsx`](client/src/pages/Home/Components/pivot/PivotFieldPanel.tsx) `FilterFieldRow`: the `loading` flag was set inside the `useEffect` that fires *after* React commits, so the popover briefly rendered "No values to filter" before the loader appeared. Replaced the effect-derived `loading` boolean with a render-time-derived `filterDistinctsResolution: Record<string, 'loading' | 'loaded' | 'error'>` map computed in [`DataPreviewTable.tsx`](client/src/pages/Home/Components/DataPreviewTable.tsx) from `pivotSyncFields` membership minus `sessionFilterDistincts` keys minus the new `sessionFilterDistinctsErrors` keys — fields appear "loading" by construction the moment they enter the FILTERS shelf, no race window possible. (2) **Silent narrowing regression for paged dimensions** introduced by PF1: [`syncFilterSelectionsWithFilters`](client/src/lib/pivot/buildPivotModel.ts) auto-fills `selected = new Set(distinctNow)` when no agent-hint exists; pre-PF1 this paired with the "isAll → omit" optimization (auto-fill all + snapshot==selected → omit field from payload → server returns everything). PF1 correctly disabled isAll-omit for `hasMore=true` to avoid omitting based on a partial snapshot, but did NOT touch the auto-fill — net effect: for a 5000-product Markets column the loaded 2000 became the explicit payload, and the server filtered out the other 3000 silently. Fixed: `syncFilterSelectionsWithFilters` now takes `hasMoreByField` and for paged fields with no hint, leaves `next[f] = undefined` (server gets no filter, returns all). For paged fields with an agent hint, honors the hint as-is even when none of the hinted values made it into the loaded subset (the hint IS the explicit include-list intent — e.g. agent `dimensionFilters: [{column: 'Products', op: 'in', values: ['FEMALE SHOWER GEL']}]` survives even when 'FEMALE SHOWER GEL' is alphabetically beyond the 2000-row distincts cap). `FilterFieldRow` renders no checkboxes checked when `selected === undefined && hasMore`, with a clarifying line "All values included. Search and check to narrow." — matches Excel pivot semantics for paged dimensions. (3) **Error state with retry**: PF1's catch block silently swallowed `/pivot/fields` failures, which combined with the new flicker fix would leave the field stuck "Loading…" forever. Added `sessionFilterDistinctsErrors: Record<string, string>` state, a `handleRetryFilterDistincts` callback, and a `filterDistinctsRetryNonce` counter that re-fires the fetch effect. The popover now renders an inline error block with a Retry button when the resolution is `'error'`. (4) **Search seq-ref guard**: per-row search-debounce in `FilterFieldRow` now tracks an internal seq ref so fast-typing supersedes prior fetches and a late-arriving response can't clobber the active query's spinner. (5) **Tests**: confirmed end-to-end via the Explore subagent that the agent-dimensionFilters → `pivotSliceDefaultsFromDimensionFilters` → `mergePivotDefaultsForResponse` → message envelope `pivotDefaults.filterFields`/`filterSelections` → `createInitialPivotConfig` (adds field to `config.filters`) → `syncFilterSelectionsWithFilters` (hydrates the `Set`) → `PivotFieldPanel` chip pipeline is wired end-to-end with no env-flag gating; pinned the contract with two new vitest files: [`syncFilterSelections.vitest.test.ts`](client/src/lib/pivot/syncFilterSelections.vitest.test.ts) (7 tests covering paged/non-paged auto-fill semantics) and [`agentFilterAutoApply.vitest.test.ts`](client/src/lib/pivot/agentFilterAutoApply.vitest.test.ts) (3 tests pinning the "show FEMALE SHOWER GEL only" → chip flow). Verified: `cd client && npm test` 199/199 pass (was 189 → 10 new tests); `npx tsc --noEmit` 52 errors total (identical to post-PF1 baseline — zero new errors). No server changes.
- **2026-04-29** — **Wave PF1 · pivot FILTERS shelf — full-distincts + remove sample-based fallback.** Closed two linked bugs the user reported as "the pivot section is unable to apply filters correctly." (1) The FILTERS shelf popover in [`PivotFieldPanel.tsx`](client/src/pages/Home/Components/pivot/PivotFieldPanel.tsx) silently fell back to `distinctPivotFilterKeysFromRows(data, …)` over the agent's narrow output sample (50–200 rows) whenever `sessionFilterDistincts[field]` hadn't loaded yet — so users saw an incomplete value list and could not deselect values like `FEMALE SHOWER GEL` that exist in the full DuckDB session but not in the sample. (2) [`DataPreviewTable.tsx`](client/src/pages/Home/Components/DataPreviewTable.tsx)'s `effectivePivotModel = serverPivotModel ?? pivotModel` selector silently rendered a sample-based `buildPivotModel(pivotRows, …)` whenever the server pivot was loading or errored; selections for values not in the sample collapsed every row → "No data points produced." Fixes: in analysis variant (with `sessionId`), `FilterFieldRow` now sources values **only** from `filterDistinctsFromSession`, shows a "Loading values…" spinner until the fetch resolves, and surfaces a "Search values…" `Input` when the response carries `hasMore: true` (debounced 200 ms, calls `/pivot/fields?column=&q=&limit=200` and merges results). [`fetchPivotColumnDistincts`](client/src/lib/api/data.ts) was extended to return `{values, hasMore, cardinality}` and accept an optional `q` substring (server endpoint already supported it via the `q` query param at [`dataApi.ts`](server/routes/dataApi.ts#L354-L358), so no server change). `DataPreviewTable` now tracks per-field `sessionFilterDistinctsLoading` / `sessionFilterDistinctsHasMore` state and pipes them down. The `effectivePivotModel` selector now skips the client `pivotModel` entirely when in analysis variant with a sessionId — `serverPivotModel` is the sole source of truth, and existing `serverPivotError` / `serverPivotLoading` UI surfaces handle the loading/failure paths. Added a defensive guard on the "isAll → omit field from payload" optimization (lines 737-748 and 781-790): only short-circuits when `sessionFilterDistinctsHasMore[f] === false`, otherwise sends the explicit selection list (paged snapshots are not authoritative). Verified: `cd server && npm test` 1737/1737 pass; `cd client && npm test` 189/189 pass; `npx tsc --noEmit` introduces zero new errors in any file I touched (pre-existing baseline errors unchanged); theme:check pre-existing violations unchanged. Files touched: [`client/src/lib/api/data.ts`](client/src/lib/api/data.ts), [`client/src/lib/api/index.ts`](client/src/lib/api/index.ts), [`client/src/pages/Home/Components/pivot/PivotHeaderSliceFilter.tsx`](client/src/pages/Home/Components/pivot/PivotHeaderSliceFilter.tsx), [`client/src/pages/Home/Components/pivot/PivotFieldPanel.tsx`](client/src/pages/Home/Components/pivot/PivotFieldPanel.tsx), [`client/src/pages/Home/Components/DataPreviewTable.tsx`](client/src/pages/Home/Components/DataPreviewTable.tsx). Out of scope: the chart preview's "No data points produced for this chart configuration" copy when Line is paired with a non-temporal `Products`-on-COLUMNS layout — that's a `recommendPivotChart` validity issue, not a filter bug; leave for a separate wave.
- **2026-04-29** — **Wave W56 · thinking-panel coverage for silent agent phases.** Closed the long pause after the "Detecting query type" thinking row. The agent loop was doing 8–20 s of real work (data load, analysis brief, hypothesis generation, upfront RAG, planner LLM, narrator setup) before the first `plan` SSE event fired, and none of it surfaced — users perceived a freeze. Fix is pure instrumentation: emit `thinking` SSE events at each silent-phase boundary, reusing the existing `onThinkingStep` → `ThinkingPanel.StepRow` pipeline (no new event types, no schema change, no client-side changes). New active/completed step pairs added: **"Loading dataset"** (wraps `resolveAnswerQuestionDataLoad` in [chatStream.service.ts](server/services/chat/chatStream.service.ts) — completes with `"{N} rows · {M} columns"`); **"Generating hypotheses"** or **"Drafting analysis brief & hypotheses"** when `MERGED_PRE_PLANNER` is on (wraps `generateHypotheses` / `runHypothesisAndBriefMerged` in [agentLoop.service.ts](server/lib/agents/runtime/agentLoop.service.ts) — completes with hypothesis count); **"Retrieving session context"** (wraps the upfront RAG block — completes with `{N} hits`); **"Planning approach"** (wraps `runPlannerWithOneRetry` — completes with step count, before the existing `plan` SSE event flips "Agent plan" to completed); **"Synthesizing answer"** (wraps the narrator call — completes on first `answer_chunk` arrival, falling back to post-narrator on non-streaming repairs). The agent loop emits via `safeEmit("thinking", …)`; `chatStream.service.ts onAgentEvent` already falls through unknown events to `sendSSE`, so loop-emitted `thinking` events reach the existing client dispatcher unchanged. The client's `onThinkingStep` reducer dedupes by `step` name — `active → completed` updates the row in place rather than appending. Verified: `cd server && npm test` 1715/1715 pass; `cd client && npm test` 189/189 pass; `npx tsc --noEmit` introduces zero new errors over baseline (the lone remaining error at chatStream.service.ts:1365 is pre-existing, unrelated `spawnedQuestions` cast).
- **2026-04-29** — **Wide-format auto-melt + currency-aware parsing (Waves WF1–WF10).** Marico-VN Nielsen-style spreadsheets (period-as-column, đồng-prefixed cells) are now auto-transformed at upload time. The dormant [`server/lib/wideFormat/`](server/lib/wideFormat/) tagger is finally wired in.
  - **WF1** — extended [`periodVocabulary.ts`](server/lib/wideFormat/periodVocabulary.ts) to cover the Marico-VN shapes the screenshot exposed: `Latest 12 Mths` / `Latest 12 Mths YA` / `Latest 12 Mths 2YA` (new `latest_n` kind), `YTD TY` / `YTD YA` / `YTD 2YA`, and the `w/e DD/MM/YY` slash-DMY week-ending date format. Added a trailing-`w/e` decoration stripper so compound headers like `Q1 23 - w/e 23/03/23` and `Latest 12 Mths 2YA - w/e 23/12/23` resolve to the leading period token. New ISO labels: `L12M`, `L12M-YA`, `L12M-2YA`, `YTD-TY`, `YTD-YA`, `YTD-2YA`. 11 new test cases.
  - **WF2** — new [`currencyVocabulary.ts`](server/lib/wideFormat/currencyVocabulary.ts). `stripCurrencyAndParse(value)` peels leading/trailing currency symbols (đ→VND, R$→BRL, S$→SGD, HK$→HKD, RM→MYR, Rp→IDR, kr→SEK, plus 14 single-character symbols `$ € £ ¥ ₹ ₩ ₪ ₺ ฿ …`) and parses the remainder. `detectCurrencyInValues(samples)` votes the dominant `{symbol, isoCode, position}` over up to 200 sample strings (≥80% threshold). `AMBIGUOUS_SYMBOLS = {$, kr, ¥}` flags symbols the LLM must disambiguate. 35 unit tests.
  - **WF3** — new [`classifyDataset.ts`](server/lib/wideFormat/classifyDataset.ts). Tags every header via `tagColumn`; returns `{isWide, shape: 'pure_period'|'compound'|'pivot_metric_row', idColumns, periodColumns, …}`. Wide iff (a) period+compound cols ≥ max(3, 30%), (b) ≥2 distinct period ISOs, (c) ≥1 id column. Tests pin the screenshot's 21-column header list to `pure_period`.
  - **WF4** — new [`meltDataset.ts`](server/lib/wideFormat/meltDataset.ts). Pure fn that reshapes wide rows to `{...idCols, Period, PeriodIso, PeriodKind, Value}` (or `{…, Metric, Value}` for compound shape). Round-trip property test included.
  - **WF5** — [`fileParser.ts`](server/lib/fileParser.ts) string→number coercion now uses `stripCurrencyAndParse` (replaced the legacy `[%,$€£¥₹\s]` regex). Module-level `currencyTallyByColumn` captures the symbol per column during coercion; `finaliseCurrencyForColumn(name)` (exported) finalises votes into a `ColumnCurrency` annotation. `createDataSummary` attaches the resulting `currency` field to numeric `ColumnInfo`s and bypasses the `isIdentifierLikeNumericColumn` heuristic for currency-tagged columns (so 24 unique đX,XXX,XXX,XXX cells aren't misclassified as IDs).
  - **WF6** — extended [`server/shared/schema.ts`](server/shared/schema.ts) (client re-exports it via [`client/src/shared/schema.ts`](client/src/shared/schema.ts)). New optional fields: `ColumnInfo.currency: { symbol, isoCode, position, confidence }` and `DataSummary.wideFormatTransform: { detected, shape, idColumns, meltedColumns, periodCount, periodColumn, periodIsoColumn, periodKindColumn, valueColumn, metricColumn?, detectedCurrencySymbol }`.
  - **WF7** — wired the auto-melt into [`server/utils/uploadQueue.ts`](server/utils/uploadQueue.ts) right after `parseFile()` (the seam at the original L411). When `classifyDataset(headers).isWide`, `data` is replaced with the melted long form before profile inference, summary creation, and DuckDB materialisation. New [`applyWideFormatToSummary.ts`](server/lib/wideFormat/applyWideFormatToSummary.ts) helper votes the dominant currency across the original wide source columns and stamps it on the new long `Value` column. Feature-flag escape hatch: `WIDE_FORMAT_AUTO_MELT_ENABLED=false`.
  - **WF8** — extended the LLM dataset profile prompt in [`datasetProfile.ts`](server/lib/datasetProfile.ts) with `ambiguousCurrencyColumns` input (only set when `$`/`kr`/`¥` is detected). New `currencyOverrides: { columnName, isoCode }[]` output field — the pipeline applies overrides to `dataSummary.columns[i].currency.isoCode`. Enables Vietnam-context detection (`Markets="Off VN"` → VND) without hardcoding regional defaults.
  - **WF9** — client UI surfaces. New [`client/src/lib/currency.ts`](client/src/lib/currency.ts) (`formatCurrency`, `formatCurrencyCompact`). New [`client/src/components/WideFormatBanner.tsx`](client/src/components/WideFormatBanner.tsx) renders above the Dataset Columns card when `dataSummary.wideFormatTransform.detected` — collapsible "View original wide-format columns" lists the headers that were melted. [`ColumnsDisplay.tsx`](client/src/pages/Home/Components/ColumnsDisplay.tsx) accepts `currencyByColumn` + `wideFormatTransform` and renders `numeric · VND (đ)` chips on currency columns. Threaded through `DataPreview` → `MessageBubble` → `ChatInterface` → `Home` via new state on [`useHomeState`](client/src/pages/Home/modules/useHomeState.ts) populated by [`useHomeMutations`](client/src/pages/Home/modules/useHomeMutations.ts) from `dataSummary.columns[].currency` and `dataSummary.wideFormatTransform`.
  - **WF10** — end-to-end golden fixture in [`tests/wideFormatPipeline.test.ts`](server/tests/wideFormatPipeline.test.ts) pins the Marico-VN shape: parse → classify → melt → applyWideFormatTransformToSummary → 24 long rows, VND-tagged Value column, period ISOs `[2023-Q1, …, 2023-Q4, L12M-2YA, YTD-2YA]`. Five new test files appended to [`server/package.json`](server/package.json) `test` script (per the explicit-file-list rule). All 1642 server tests pass; all 171 client vitest tests pass; client TS error count went from 62 → 51 (no new errors introduced).
  - **Conventions added.** (1) **Wide-format detection is unconditional at upload (env-gated, default on).** Once a dataset trips `classifyDataset.isWide`, the long form is the canonical analysis surface — `dataSummary.columns`, `sampleRows`, `rawData`, the DuckDB `data` table, and RAG chunks all see the long shape. The original wide buffer survives in blob storage for download but is never re-parsed at chat time. (2) **Currency tags are heuristic-with-LLM-override.** `fileParser.currencyTallyByColumn` captures symbols at parse time (lossy — the symbol is stripped from numeric cells); `finaliseCurrencyForColumn` votes per column; the LLM dataset-profile pass overrides ambiguous symbols (`$`/`kr`/`¥`) using market/dataset context. Multi-currency columns return null and fall back to plain number formatting. (3) **DuckDB table name unchanged (`data`).** No agent-runtime changes were required — tools see a normal long-format table; the planner doesn't know a melt happened.
- **2026-04-28** — **Pivot Key Insight live-refetch fix.** Closed two bugs the user reported around stale / "basic" insights when pivot fields are mutated.
  - **Bug 1 (pivot view, frozen):** the "Key insight" card read from `message.insights[0]` (agent-turn-frozen) and never re-derived when the user dragged fields. Fix: new `pivotKeyInsight` state in [`DataPreviewTable.tsx`](client/src/pages/Home/Components/DataPreviewTable.tsx) drives a live refetch keyed off `pivotFlatRows` + a `pivotInsightConfigHash` (rows / columns / values / filter payload). Display selector becomes `analysisIntermediateInsight ?? pivotKeyInsight?.text ?? pivotInsight` (frozen → boot-state only). Loading affordance ("Re-deriving insight…") under the Lightbulb header.
  - **Bug 2a (chart view, "feels basic"):** `postChartKeyInsightEndpoint` passed `undefined`/`undefined` for `chatInsights` and `synthesisContext`, stripping all five context blocks from the LLM prompt; output mimicked the deterministic fallback. Fix: hydrate from session fields and the request body's `userQuestion` — parity with `enrichCharts`. See the new Conventions-that-bite entry.
  - **Bug 2b (chart view, sometimes missing):** empty pivot data returned `400` and wiped state; hash dedupe advanced on **all** outcomes so transient empty/error poisoned future refetches; optimistic `setChartInsight({ text: null, loading: true })` blanked prior text before the new fetch resolved. Fix: server returns `200 { keyInsight: "" }` on zero rows; outcome-aware dedupe ref (`{hash, outcome}`) only short-circuits on `success`/`pending`; functional setState preserves `prev?.text` across loading/error/empty transitions; `ChartKeyInsightCallout` keeps prior text with a muted "Couldn't refresh" subline on error.
  - **Conflicts and how they were resolved.** (1) **Hash-vs-data race** — `pivotInsightConfigHash` advances synchronously with the user's drag, but `pivotFlatRows` only updates after the server pivot query completes (~500ms). Resolution: effect deps include both; the React cleanup-on-rerender clears the stale-data timer before it fires, and a `pivotInsightSeqRef` aborts in-flight responses keyed to a superseded hash. (2) **Loading-overwrites-prior-text** — the existing `chartInsight` effect blanked text to null at the start of every fetch; if the new fetch failed, the prior good insight was lost. Resolution: every state setter uses `setX(prev => ({ ..., text: prev?.text ?? null }))`. (3) **Hash-poisoning** — pre-fix `lastInsightHashRef` was just `string` and advanced on empty/error too; once a hash had a transient failure, the same hash short-circuited forever. Resolution: outcome-aware ref `{hash, outcome}`; only `success`/`pending` short-circuit. (4) **`ChartKeyInsightCallout` UX** — old code unmounted the card on `loading: true`, which collapsed the card on every refresh. Resolution: pure-spinner only on first-load (`!insight.text`); when prior text exists, render it with an inline "Refreshing…" badge. (5) **Endpoint context starvation vs cost** — the lightweight chart-key-insight endpoint was deliberately stripped of context to be cheap, but the cost was the user-visible "feels basic" output. Resolution: hydrate via the process-memoised `loadEnabledDomainContext` (no measurable extra cost) and session fields already in scope. Verified: server build OK, `cd server && npm test` 1530/1530 pass; `cd client && npm test` 152/152 vitest pass; `cd client && npx tsc --noEmit` introduces zero new errors over baseline.
- **2026-04-28** — Promoted `CLAUDE.md` to comprehensive single-source-of-truth ("holy bible") with full server / client / agent-runtime / tool / skill / MMM / RAG / wide-format / domain-context / charting / deployment reference and a `docs/` index. Removed the legacy orchestrator description (deleted in commit `9422bed7`); added MMM pipeline (Waves W46–W55), narrator / AnswerEnvelope synthesis, investigation / blackboard subsystem, single-flow policy, Claude Opus 4.7 routing env vars, pivot subsystem, admin pages, expanded tool registry, new env flags, vitest convention. Fixed [`docs/agents-architecture-inventory.md`](docs/agents-architecture-inventory.md) in lockstep — removed the legacy-layer §3 and updated env-var defaults / counts. Added the "Last updated" header banner and this changelog. Removed the now-defunct `@assets/*` path alias.
- **2026-04-21** — Added the "tiny waves" working cadence (Wave W0.5).
- **earlier** — Initial repo layout, dev loop, and agent-architecture notes.
