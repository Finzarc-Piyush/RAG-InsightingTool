# Upload pipeline and enrichment (architecture)

## Default (v1)

- **In-process** upload queue (`server/utils/uploadQueue.ts`): jobs live in memory on the API process; Cosmos chat documents hold session state (including `enrichmentStatus`, messages, data summary, sample rows).
- **Ordering:** Persist **preview** first (heuristic `dataSummary`, sample rows capped at 50, column metadata), then run **enrichment** (LLM profile, session context seed, optional initial assistant content depending on flags). Chat answers are **deferred** until `enrichmentStatus` is terminal (`complete` or `failed`); the server may queue the user’s message and flush after enrichment (answer + `suggestedQuestions`, or suggestions-only).
- **Client:** Poll `GET /api/upload/status/:jobId` for job phase. The response sets `previewReady` true from the moment preview is persisted through `analyzing`, `saving`, and `completed` (so polling does not miss the short `preview_ready` job state). Combine with session `enrichmentStatus` for the enrichment banner vs full-screen preview. No extra infrastructure required for a single API instance.

## When to evolve (explicit triggers)

Do **not** add external queues or workers until there is a concrete signal:

| Signal | Interpretation | Typical upgrade |
|--------|----------------|-----------------|
| Multiple API instances | In-memory job map is not shared; jobs appear lost or duplicated | External queue (e.g. Redis + BullMQ, Azure Queue) + stateless workers; durable job row keyed by `jobId` in Cosmos or Redis |
| Long enrichment blocks the event loop | CPU or I/O saturation on the API | Dedicated **worker process** for the upload pipeline; API only enqueues |
| Chat flush lost or inconsistent | Upload completion hook fails or times out | **Outbox** pattern: persist `pendingPostEnrichment` in Cosmos; reconciler/cron retries flush |
| Polling `/upload/status` too chatty | Measurable cost or UX lag | Prefer existing **SSE** for chat where already used; add a **narrow** one-shot SSE for “enrichment complete” only if needed; **WebSockets** only if bidirectional streaming is required |

## Anti-patterns

- Adding Redis, a second service, or WebSockets **before** observing multi-instance job loss, horizontal scale need, or failed flushes.
- Blocking HTTP until enrichment completes (timeouts and poor UX); the product uses **persist + defer** instead.

## Principle

**Boring first:** prove single-node preview → enrichment → flush under realistic load; externalize jobs only when an observed failure mode justifies it.

## `enrichmentStatus` writers (v1 — single function)

The field has **one writer** in practice: `processUploadJob` inside
[`server/utils/uploadQueue.ts`](../../server/utils/uploadQueue.ts).
The transitions inside that function are:

| Stage | Line ≈ | Target status | What else is written |
|---|---:|---|---|
| Preview persisted | 451 | `in_progress` | `dataSummary`, `sampleRows`, `selectedSheetName` |
| Understanding checkpoint | 573 | `complete` | `dataSummary`, `datasetProfile`, `sessionAnalysisContext` |
| Full enrichment (update path) | 830 | `complete` | ~15 fields: rawData, sampleRows, profile, blob info, analysisMetadata, etc. |
| Full enrichment (create path fixup) | 867 | `complete` | `selectedSheetName`, `columnarStoragePath` |
| Failure | 938 | `failed` | only the status + `lastUpdatedAt` |

Plus one creation writer at `server/models/chat.model.ts:434` which
initialises new chats at `enrichmentStatus: "pending"`.

### Why no single-writer helper (Wave F9 retracted)

A naive `setEnrichmentStatus(sessionId, status)` helper using a
Cosmos patch would **either** drop the rich business state each
writer carries **or** add a second round-trip per transition. The
current layout keeps all mutations inside one function that already
runs serially in-process, so there is no concurrent-writer race to
eliminate. The real risk is forgetting which transition is legal at
which stage; the table above is the canonical reference.

If a future change introduces a writer OUTSIDE `processUploadJob`,
revisit this decision: the moment two functions mutate the field
independently is when the single-writer helper earns its keep.

## Recent changes

- **Initial-message robustness** —
  `buildInitialAssistantContentFromContext`
  ([`server/lib/sessionAnalysisContext.ts`](../../server/lib/sessionAnalysisContext.ts))
  now synthesises a deterministic "Columns at a glance" section directly
  from `DataSummary` (numeric / date / categorical groupings, capped at six
  names per group with a `+N more` suffix) when `dataset.columnRoles` is
  empty. Date columns are annotated with their available temporal grains
  (e.g. `order_date *(can group by year, quarter, month)*`) read from
  `summary.temporalFacetColumns`, so the welcome message advertises the
  same aggregation surface the agent uses (the agent prompt at
  [`dataOpsOrchestrator.ts:1755-1764`](../../server/lib/dataOps/dataOpsOrchestrator.ts)
  groups by the hidden `__tf_*` columns for "by year/quarter/month"
  requests). Internal `__tf_*` column names are never exposed in the
  user-facing message. Previously a fresh upload with a sparse heuristic
  context would produce a one-line message because `columnRoles` is
  populated by the fire-and-forget `seedSessionAnalysisContextLLM`, which
  often hasn't landed by the time the understanding checkpoint persists
  the welcome message. The richer fallback aligns with the
  non-blocking-startup invariant: initial artifacts must be useful from
  automatic understanding alone. Covered by
  [`server/tests/buildInitialAssistantContent.test.ts`](../../server/tests/buildInitialAssistantContent.test.ts).
- **Context-first modal + regeneration** — The "Add Context" modal now
  opens immediately after the upload returns a `sessionId`, not after
  the preview loads. Background preview + enrichment continue behind the
  modal. The initial welcome message is generated from dataset
  understanding alone (`seedSessionAnalysisContextLLM`, unchanged
  signature) so the app is usable even if the user skips. When the user
  saves context, `updateSessionPermanentContext` re-reads the doc after
  the slow LLM merge (to avoid clobbering the upload pipeline's
  understanding-checkpoint write), calls the new
  `regenerateStarterQuestionsLLM` helper, and rewrites
  `messages[0].suggestedQuestions` + `content` when the initial
  welcome is still the sole assistant message. The fire-and-forget seed
  at [`server/utils/uploadQueue.ts:554-578`](../../server/utils/uploadQueue.ts)
  no-ops when `permanentContext` is now set.
- **`user_context` RAG chunk** — `ChatDocument.permanentContext` is now
  indexed into Azure AI Search as a dedicated `user_context` chunk
  (prepended by [`buildChunksForSession`](../../server/lib/rag/chunking.ts)).
  `scheduleUpsertUserContextChunk` in
  [`server/lib/rag/indexSession.ts`](../../server/lib/rag/indexSession.ts)
  performs a targeted single-doc upsert on context save (no full
  re-index unless the initial index isn't ready yet).
- **LLM-first starter questions** — `mergeSuggestedQuestions`
  ([`server/lib/suggestedQuestions.ts`](../../server/lib/suggestedQuestions.ts))
  now uses strict `primary`/`fallback` semantics: when the LLM-generated
  list is non-empty, the hardcoded column-name template list is
  ignored entirely (no padding). Templates only surface in the fast/skip
  path when LLM output is empty.
