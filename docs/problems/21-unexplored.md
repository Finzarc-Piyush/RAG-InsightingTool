# 21 — Unexplored / follow-up audits

Wave 6 (optional). These are **flags, not confirmed findings** — areas where the
audit ran out of budget or the code was complex enough that a dedicated pass is
warranted before claiming a defect exists.

Each entry is a scoped Explore task. Do not fix until verified.

---

### P-079 — Query plan executor error paths

- **Location:** `server/lib/queryPlanDuckdbExecutor.ts`, `server/lib/duckdbPlanExecutor.ts`
- **Question:** Do column-not-found / type-coercion errors from DuckDB surface cleanly? Are partial results ever returned when a query aborts?
- **Status:** todo (audit)

### P-080 — Cosmos consistency under concurrent session-context merges

- **Location:** `server/lib/sessionAnalysisContext.ts`, `server/models/chat.model.ts`
- **Question:** Mid-turn session merges fire throttled in parallel with user-message writes. Under `AGENT_MID_TURN_CONTEXT=true`, is there a lost-update scenario where two concurrent PATCHes race?
- **Status:** todo (audit)

### P-081 — Chart enrichment row selection on very large tables

- **Location:** `server/lib/chartEnrichmentRows.ts`, `server/services/chat/*`
- **Question:** On datasets of 1M+ rows, how are enrichment rows picked? Is the sample deterministic? Does it skew under filter combinations?
- **Status:** todo (audit)

### P-082 — Pivot-slice defaults × user filters

- **Location:** `server/lib/pivotSliceDefaultsFromDimensionFilters.ts` and friends
- **Question:** When a user supplies dimension filters, do the computed slice defaults align with the applied filters or contradict them?
- **Status:** todo (audit)

### P-083 — Temporal facet column injection into RAG chunks

- **Location:** `server/lib/temporalFacetColumns.ts`, `server/lib/rag/chunking.ts`
- **Question:** Temporal facet columns are injected into chunk metadata. Does that create a circular embedding feedback loop at index time?
- **Status:** todo (audit)

### P-084 — Large intermediate pivot flush ordering

- **Location:** `server/services/chat/intermediatePivotPolicy.ts`, `server/services/chat/chatStream.service.ts`
- **Question:** Under `AGENT_INTERMEDIATE_PIVOT_COALESCE=true`, is the ordering between the "richer multi-row intermediate" and the "≤1-row preview" guaranteed? What if they arrive out of order from the tool?
- **Status:** todo (audit)

### P-085 — Agent-workbench 12k-char truncation

- **Location:** `server/services/chat/agentWorkbench.util.ts`
- **Question:** Does the truncation preserve critical artifacts (JSON structure, tool output keys), or can it cut mid-token and render garbled entries to the client?
- **Status:** todo (audit)

### P-086 — Admin key rotation for Azure Search

- **Location:** `server/lib/rag/aiSearchStore.ts`, ops docs (absent)
- **Question:** How is the admin key rotated without downtime? Is there a dual-key grace window pattern?
- **Status:** todo (documentation, not code)
