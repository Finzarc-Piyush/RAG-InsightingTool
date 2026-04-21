# 02 — Data-corruption & silent-drop bugs

Wave 1. These are the "quiet killers" — each hour they remain live, user data is being
recorded wrong or dropped invisibly.

---

### P-003 — `Infinity` leaks into JSON via `Math.min(existingValue || Infinity, newValue)`

- **Severity:** critical
- **Category:** correctness / bug
- **Location:** `server/lib/dataTransform.ts:1181`
- **Evidence:** When `existingValue` is `null`/`undefined`/`0`, the expression stores `Infinity` in the merged map. JSON serialization of `Infinity` yields `null` (non-spec, per-runtime), breaking downstream chart + table renderers that expect a real number.
- **Fix:** Seed with the first real `newValue` when the slot is empty, or collapse `Infinity`/`-Infinity` → `null`/sentinel before persisting. Add a unit test that round-trips through `JSON.stringify`.
- **Status:** todo

### P-006 — Silent row drop via `pd.to_numeric(errors='coerce')`

- **Severity:** critical
- **Category:** correctness
- **Location:** `python-service/data_operations.py:333, 533, 1054, 1067, 1256, 1276, 1387, 1683, 1696`; `python-service/ml_models.py:113, 116`
- **Evidence:** 9 sites in data_operations + 2 in ml_models silently coerce non-numeric strings to `NaN`. ML training then drops those rows with no warning.
- **Fix:** Before each coerce, count how many values would become NaN. If > 0, return a structured `warnings: [{column, droppedCount}]` list in the response so the Node side can surface it in the chat. For training, refuse if dropped > threshold.
- **Status:** todo

### P-007 — Embedding-dimension mismatch only warns, wrong-dim vectors still upserted

- **Severity:** high
- **Category:** correctness (silent retrieval corruption)
- **Location:** `server/lib/rag/embeddings.ts:20-24`
- **Evidence:** `if (v.length !== dim) { console.warn(…) }` — then vector is still used.
- **Fix:** Throw on mismatch. At startup, fetch the index schema and cross-check `AZURE_OPENAI_EMBEDDING_DIMENSIONS` against the Azure Search index's vector field size; refuse boot if they disagree.
- **Status:** todo

### P-022 — `deleteRagDocumentsBySessionId` ignores per-batch failures → orphan chunks

- **Severity:** medium
- **Category:** correctness (RAG staleness)
- **Location:** `server/lib/rag/aiSearchStore.ts:44-75`
- **Evidence:** Paginated deletion loops but does not inspect each `deleteDocuments` response for failed items. Partial failures leave orphan chunks indexed; next retrieval mixes stale content with fresh.
- **Fix:** Inspect each result; collect failures; retry with backoff for transient; throw once retries exhausted so the caller can escalate.
- **Status:** todo

### P-058 — CSV parser is relaxed by default, hides malformed data

- **Severity:** low
- **Category:** correctness
- **Location:** `server/lib/fileParser.ts:104-105`
- **Evidence:** `relax_column_count: true, relax_quotes: true` — silently tolerates missing columns and bad quoting.
- **Fix:** Try strict parse first; on fail, re-run relaxed and attach a `parseWarnings` array to the dataset metadata so the assistant can mention it. Don't silently accept.
- **Status:** todo

### P-061 — Per-batch CSV schema drift not revalidated

- **Severity:** low
- **Category:** correctness
- **Location:** `server/lib/fileParser.ts:145-150`
- **Evidence:** Batches are sliced and transformed; column-count/type-consistency against batch 0 is not asserted on subsequent batches.
- **Fix:** After transforming each batch, assert the column set matches the first batch; log + attach a warning if not.
- **Status:** todo
