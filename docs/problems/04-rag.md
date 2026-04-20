# 04 — RAG pipeline

Wave 1 (P-007) + Wave 2 (P-023). P-022 lives in area 2 (data corruption) but is
cross-referenced here.

---

### P-007 — Embedding-dim mismatch only warns (carried forward from area 2)

See `02-data-corruption.md` — fix at `server/lib/rag/embeddings.ts:20-24`.

### P-022 — Orphan chunks on partial delete (carried forward from area 2)

See `02-data-corruption.md` — fix at `server/lib/rag/aiSearchStore.ts:44-75`.

### P-023 — No retry/backoff on Azure Search 429/5xx

- **Severity:** medium
- **Category:** resilience
- **Location:** `server/lib/rag/aiSearchStore.ts:33, 77`; `server/lib/rag/retrieve.ts:26`
- **Evidence:** Direct calls to `vectorSearchSession` and `upsertRagDocuments` with no retry. A transient 429 (throttling) or 5xx (Azure outage) fails the whole chat turn.
- **Fix:** Wrap in a small retry helper (exponential backoff + jitter, max 3 attempts). Only retry idempotent reads by default; for upserts, dedupe by chunk ID on retry.
- **Status:** todo
