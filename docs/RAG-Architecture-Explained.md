# RAG & Retrieval Architecture — Explained

> A plain-English briefing for answering technical due-diligence questions about how this tool retrieves and reasons over data.
> Every claim below is grounded in the actual source code — file references are at the bottom so you (or an engineer) can verify each one.
> Written 2026-06-03.

---

## 0. The ONE thing to understand first (read this before anything else)

The most common assumption people make about a "RAG tool" is:

> *"You embed the data into vectors, retrieve the most similar rows for each question, stuff them into the LLM's context, and the LLM reads them to produce an answer."*

**That is NOT how this product answers analytical questions.** If you only remember one thing, remember this:

This tool has **two separate engines**, and they do different jobs:

| Engine | What it is | What it's for | Where the answer's *numbers* come from |
|---|---|---|---|
| **1. DuckDB (SQL engine)** | An embedded columnar analytics database holding the **entire** dataset, every row | Doing the actual math — counts, sums, averages, group-bys, correlations, trends | ✅ **Here.** The LLM writes SQL; DuckDB computes exact answers over the full table. |
| **2. RAG (vector search)** | Azure AI Search holding embeddings of **metadata** (schema, samples, your notes, past Q&A) | Understanding *what you mean*, suggesting the right columns, recalling prior analysis | ❌ **Never here.** RAG provides *context and wording only* — it is explicitly forbidden from being used as numeric evidence. |

**Why this matters for due diligence:** Several of the questions you were asked ("retrieval dilution in large datasets", "context window limits", "how much data before performance degrades") are built on the assumption that we retrieve rows via embeddings to answer questions. **We don't.** Numbers come from SQL over the complete dataset. That single design decision reframes — and largely neutralizes — the hardest questions. We'll come back to this for each one.

> In the synthesis prompt, the retrieved RAG text is literally labelled: *"Use for grounding and citation only — never as numeric evidence."* That's the architecture in one sentence.

---

## 1. The 30-second answers (cheat sheet)

| # | Question | Short answer |
|---|---|---|
| 1 | Vector-only or hybrid? | **Hybrid** — vector (semantic) search is primary, with an automatic keyword/BM25 fallback when vector confidence is low. No reranker (honest caveat). |
| 2 | Which embedding models? | **Azure OpenAI `text-embedding-3`** — `-small` (1536-dim) by default in code, `-large` (3072-dim) in production config. Fully env-configurable. |
| 3 | Chunking strategy? | **Tabular-aware, not naive text-splitting.** Schema summary + sample rows + bounded row-windows (50 rows/chunk) + your context notes. No blind 512-token chunking. |
| 4 | Preventing retrieval dilution? | **Three hard filters** (per-session, per-data-version, per-chunk-type) + top-k cap — *and* the architectural answer: **we don't retrieve rows for numbers at all**, so dilution can't corrupt analytical results. |
| 5 | Context window limits? | **The full dataset never enters the LLM context.** Only aggregated SQL *results* do. A central budget module caps and trims every prompt block, with default 2048-token completions. |
| 6 | How much data before it degrades? | Bound by **DuckDB**, an OLAP engine that handles **millions of rows** on one node — not by embedding retrieval. The in-memory path switches to columnar/DuckDB above 50,000 rows. |
| 7 | Whiteboard the architecture? | See the two diagrams in §3. Two engines: SQL for numbers, vectors for meaning. |

---

## 2. Glossary (so the rest of this doc is readable)

- **RAG** — Retrieval-Augmented Generation. Fetch relevant text and give it to the LLM as context.
- **Embedding** — turning text into a list of numbers (a "vector") so that similar meanings end up close together. Used for semantic search.
- **Vector search** — find the stored chunks whose embeddings are closest to the question's embedding (here, by *cosine* distance).
- **BM25 / keyword search** — classic word-overlap search (like a search engine). Good when exact terms matter.
- **Hybrid retrieval** — combining vector + keyword search.
- **Reranker** — a second model that re-orders search results for relevance. *We don't have one* (see caveats).
- **HNSW** — the index algorithm Azure AI Search uses to make vector search fast.
- **DuckDB** — an embedded, in-process **columnar OLAP database** (think "SQLite for analytics"). Runs SQL over millions of rows fast, on one machine.
- **Chunk** — a unit of text that gets embedded and indexed.
- **Agentic plan/act loop** — the LLM plans steps, calls tools (SQL, correlation, etc.), reads results, and iterates until it can answer.

---

## 3. The whiteboard (Question 7)

Two diagrams. The first shows what happens when data is uploaded; the second shows what happens when a question is asked. These are deliberately simple enough to redraw on a whiteboard from memory.

### Diagram A — Ingestion: what gets stored where

```
        Upload  (CSV / Excel / Snowflake)
                      │
                      ▼
            Parse  +  LLM enrichment
                      │
        ┌─────────────┴──────────────────┐
        ▼                                 ▼
 ┌───────────────────┐         ┌──────────────────────────────┐
 │  DuckDB           │         │  Build RAG "chunks":          │
 │  `data` table     │         │   • schema / column summary   │
 │  ─ EVERY ROW ─    │         │   • up to 30 sample rows      │
 │  (full dataset)   │         │   • bounded row windows OR    │
 │                   │         │     a 3,000-row sample        │
 │  ► numbers        │         │   • your analysis notes       │
 │    live here      │         │   • dimension hierarchies     │
 └───────────────────┘         └───────────────┬──────────────┘
                                                ▼
                                  embed (text-embedding-3-*)
                                                ▼
                                  ┌──────────────────────────┐
                                  │  Azure AI Search (HNSW)  │
                                  │  vector + keyword index  │
                                  │  ► meaning lives here    │
                                  └──────────────────────────┘
```

Key insight from Diagram A: **the full table goes to DuckDB; only metadata + samples go to the vector index.** The vector index is intentionally small — it's a "table of contents and meaning," not a copy of the data.

### Diagram B — Query time: the two paths

```
                          User question
                                │
                                ▼
                  ┌──────────────────────────────┐
                  │   Agentic plan / act loop     │
                  │        (the planner)          │
                  └───────────────┬───────────────┘
              ┌───────────────────┴───────────────────┐
              ▼  (for NUMBERS)                         ▼  (for MEANING)
 ┌───────────────────────────────┐      ┌──────────────────────────────────┐
 │  DuckDB SQL tools:            │      │  retrieve_semantic_context        │
 │   • execute_query_plan        │      │   • vector search (top-8)         │
 │   • run_analytical_query      │      │   • BM25 keyword fallback         │
 │   • run_readonly_sql          │      │     if vector confidence is low   │
 │                               │      │   • per-session, per-version      │
 │  → SELECT / GROUP BY / etc.   │      │     filtered                      │
 │    over the FULL dataset      │      └─────────────────┬────────────────┘
 │  → exact, authoritative math  │           grounding · wording ·
 └───────────────┬───────────────┘           themes · column hints ·
                 │                            recall of past analysis
                 └──────────────────┬──────────────────────┘
                                    ▼
                       Synthesis → decision-grade answer
              (TL;DR · findings · implications · magnitudes · caveats)

         RAG text is "grounding & citation only — never numeric evidence"
```

Key insight from Diagram B: **two arrows out of the planner.** One goes to SQL (the math). One goes to vectors (the meaning). They rejoin at synthesis. The numbers are always SQL's.

---

## 4. The questions, answered in depth

### Q1 — Is the RAG architecture vector-only or hybrid?

**Hybrid, with vector search as the primary signal.**

How it works at query time:
1. The question is embedded into a vector.
2. **Vector (semantic) search** runs first against the session's chunks, returning the top-k by cosine similarity.
3. The system measures the *mean similarity* of those hits. If vector recall looks **weak** — either **zero hits** or **mean cosine below 0.3** (a tunable threshold) — it triggers a **keyword (BM25) fallback** pass to catch exact-term matches the embeddings missed.
4. Results are **fused** by simple concatenation + de-duplication (using the first 400 characters as a signature), then trimmed to top-k.

So: **vector-primary, keyword-assisted-on-demand.** This is a pragmatic hybrid — it doesn't pay for a keyword pass on every query, only when the semantic search isn't confident.

**Honest caveat to be ready for:** there is **no reranker / cross-encoder**, and the fusion is a plain interleave-and-dedup, **not** Reciprocal Rank Fusion (RRF) or Azure's semantic ranker. For the small, per-session corpus this index holds (schema + samples + notes), that's an appropriate level of sophistication — but if asked "do you rerank?", the honest answer is *"not today; it's a known, deliberate simplification given the corpus size, and a clean place to add value if recall ever becomes the bottleneck."*

> Source: `server/lib/rag/retrieve.ts` (orchestration, threshold, fusion); `server/lib/rag/aiSearchStore.ts` (`vectorSearchSession`, `keywordSearchSession`).

---

### Q2 — Which embedding models do you use?

**Azure OpenAI's `text-embedding-3` family.** Specifically:

- **In code, the default is `text-embedding-3-small`** → 1536 dimensions.
- **In the production config template, it's `text-embedding-3-large`** → 3072 dimensions.
- The actual model and dimension count are **driven by environment variables** (`AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME`, `AZURE_OPENAI_EMBEDDING_DIMENSIONS`), so it's a deployment choice, not a hard-coded one.

Safety mechanisms worth mentioning:
- **A dimension-mismatch guard throws an error** rather than silently indexing wrong-sized vectors (which would quietly corrupt search quality). The embedding dimension must match the Azure Search index's vector field exactly.
- **A guard rejects accidentally pointing the embedding slot at a chat model**, falling back to a real embedding model.
- Embeddings are created in **batches of 16** for throughput.

**Honest caveat:** the small-vs-large discrepancy between code default and prod template is a real thing to be precise about — *"we run `-large`/3072 in production; `-small` is the safe local default."* Confirm which is set in the target environment before quoting a number.

> Source: `server/lib/rag/embeddings.ts` (model string, batch, dim guard); `server/lib/rag/config.ts` (`getEmbeddingDimensions`); `server/lib/openai.ts` (Azure client, chat-model guard); `server/.env.example` (prod `-large`/3072).

---

### Q3 — What chunking strategy do you use?

**Tabular-aware chunking — not the naive "split text every N tokens" approach** most RAG demos use. Because the source is structured data (a table), the chunks are shaped around the data's structure:

| Chunk type | What it contains | Size cap |
|---|---|---|
| `user_context` | Your analysis notes + declared dimension hierarchies, **prepended so it ranks first** | — |
| `summary` | The schema: row count, every column name + type, which columns are numeric/date | — |
| `sample` | Up to **30** representative rows | 12,000 chars |
| `rows` | The data in **windows of 50 rows**, up to **40 windows** (so ≤ 2,000 rows reach the index) — only when the dataset is small enough to hold in memory | 14,000 chars/window |
| `duckdb_sample` | For large datasets: a **3,000-row sample** pulled from DuckDB, trimmed to 40 rows in the chunk | 12,000 chars |

Notes:
- **Row windows have no overlap** (each window picks up exactly where the last ended). Overlap is a text-RAG trick to avoid splitting a sentence; it's unnecessary for row-aligned data.
- Everything is **character-bounded**, and each indexed document is additionally capped at 32,000 characters.
- **For large datasets, only a *sample* of rows is ever embedded** — never the whole table. This is by design (the whole table lives in DuckDB), and it's the reason retrieval stays focused as data grows (see Q4).

**The headline for this question:** *"We don't chunk the data into arbitrary token blocks. We index the schema, your context, and representative samples — a semantic 'table of contents.' The full rows live in the SQL engine."*

> Source: `server/lib/rag/chunking.ts` (all constants and chunk builders); `server/lib/rag/indexSession.ts` (the 3,000-row DuckDB sample, 32k cap).

---

### Q4 — How do you prevent retrieval dilution in large datasets?

Two layers — one tactical, one architectural. The architectural one is the strong answer.

**Tactical (within the vector index):** every retrieval is hard-scoped by three filters before similarity is even considered:
1. **Per-session filter** — a query can only ever see chunks from its own session/dataset (`sessionId eq '…'`). This is also the multi-tenant isolation boundary — no cross-customer or cross-dataset bleed.
2. **Per-data-version filter** — stale chunks from a previous upload of the same session are excluded, so old data can't dilute new.
3. **Per-chunk-type filter** — e.g. session-memory entries are kept out of data retrieval and surfaced through their own dedicated path.

Then a **top-k cap** (configurable 1–25, default 8; only the **top 3** are injected into the planner upfront) keeps the context tight.

**Architectural (the real answer):** *dilution of analytical results is structurally impossible here, because we don't retrieve rows to compute answers.* The numbers come from **SQL aggregations over the complete dataset in DuckDB.** A `SUM` over 5 million rows is a `SUM` over 5 million rows — it doesn't "dilute" because there's no top-k retrieval step deciding which rows count. The vector index is intentionally bounded (≤ 2,000 rows or a 3,000-row sample), so as the dataset scales from thousands to millions of rows, **the thing being retrieved stays small and metadata-focused** while the math scales independently in the SQL engine.

**The headline:** *"Retrieval dilution is a problem for systems that answer questions by retrieving rows. We answer with SQL over the full table, so growing the dataset doesn't degrade retrieval relevance — it just adds rows DuckDB aggregates over."*

> Source: `server/lib/rag/aiSearchStore.ts` (OData session/version/type filters); `server/lib/rag/config.ts` (`getRagTopK`); `server/lib/rag/chunking.ts` (bounded row index).

---

### Q5 — What context-window limitations exist?

The honest framing: **the dataset's size is decoupled from the LLM's context window.** The full table never enters the prompt — only the *results* of SQL queries (already aggregated and small) and the bounded metadata chunks do. So a 5-million-row dataset and a 5,000-row dataset put roughly the same load on the context window.

What manages the window in practice:
- **A central prompt-budget module** caps each block of the prompt (retrieved hits, prior findings, working memory, etc.), sums the post-cap total, and **proportionally trims any overshoot — recording each truncation** so it can be surfaced rather than silently dropping content.
- Concrete caps include: retrieved hits rendered at ~8,000 chars, the retrieve tool's summary at 6,000 chars, planner blocks sliced to fixed budgets (prior observations ~20k, working memory ~14k, memory recall ~16k chars), and **LLM completions defaulting to 2,048 tokens** with per-model clamping.

**Honest caveat:** the budgeting is **character-based, not tokenizer-based.** Characters are a good proxy for tokens but not exact, so there's a small margin of imprecision versus counting true tokens. It's a known, bounded trade-off (deterministic and fast), not a correctness risk for the data — because, again, the data isn't what's filling the window.

**The headline:** *"Context limits apply to the conversation and retrieved context, not to the data. The data is queried, not pasted. We budget and trim every prompt block deterministically, and we never try to fit raw rows into the window."*

> Source: `server/lib/agents/runtime/promptBudget.ts` (central budget + trim reporting); `server/lib/agents/runtime/planner.ts` and `buildSynthesisContext.ts` (per-block caps); `server/lib/rag/retrieveHelpers.ts` (8k render cap).

---

### Q6 — How much data can be queried before performance degrades?

**The ceiling is DuckDB's, not the embedding layer's** — and that's a high ceiling.

- The full dataset is materialized into a DuckDB `data` table (loaded via `read_csv_auto`, `SELECT *` — every row, with a guard that **refuses to materialize a preview-sized subset by mistake**).
- DuckDB is a **columnar OLAP engine** purpose-built for analytical scans and aggregations. On a single node it comfortably handles **millions of rows** — group-bys, filters, window functions, joins — in interactive time. This is the same class of engine used for serious analytics workloads.
- There's an explicit threshold at **50,000 rows**: below it, a small dataset can be served from an in-memory frame; above it, the system relies on the columnar/DuckDB path. So the "big data" path *is* the default for anything sizeable.
- The LLM reaches this via SQL tools (`execute_query_plan`, `run_analytical_query`, `run_readonly_sql`). For aggregations it **must** hit DuckDB (the authoritative surface) and will **hard-fail rather than silently fall back** to an in-memory approximation — so you never get a quietly-wrong number from a partial scan.

What *does* scale with data size: ingestion/materialization time (a one-time cost per upload) and individual query latency (grows sub-linearly with good columnar execution). What *doesn't* degrade: retrieval relevance (the vector index stays bounded) and answer correctness (SQL is exact).

**The headline:** *"Query performance scales like an analytics database, because it is one. The practical ceiling is DuckDB on the host — millions of rows per session — not a retrieval bottleneck. And we fail loud rather than return an approximate number."*

**Honest caveat:** DuckDB here runs **in-process / single-node**, so a single session's ceiling is ultimately the host machine's memory and cores. Genuinely massive (hundreds of millions / billions of rows) or high-concurrency multi-tenant load would call for pushing compute down to a warehouse (e.g. Snowflake, which is already a supported source) — a known scaling path, not a present limitation for the target workloads.

> Source: `server/lib/ensureSessionDuckdbMaterialized.ts` (full-table materialization); `server/utils/dataLoader.ts` (preview-size guard); `server/lib/columnarStorage.ts` (`read_csv_auto`); `server/lib/agents/runtime/tools/registerTools.ts` (`run_readonly_sql` = "full session data when columnar storage is active"; hard-fail on aggregation).

---

### Q7 — Can you explain your retrieval architecture on a whiteboard?

Yes — see the two diagrams in **§3**. The whiteboard version, spoken aloud, is four sentences:

1. *"On upload, the full dataset goes into DuckDB — a columnar SQL engine — and a small set of metadata chunks (schema, samples, the user's notes) gets embedded into Azure AI Search."*
2. *"When a question comes in, an agentic loop splits the work: it writes SQL against the full table in DuckDB for the numbers, and runs hybrid vector+keyword search over the metadata for the meaning."*
3. *"Vector search is primary; a keyword/BM25 pass kicks in only when semantic confidence is low. Everything is filtered to that one session."*
4. *"The two streams rejoin at synthesis, where the SQL results are the evidence and the retrieved text is grounding only — never the source of a number."*

---

## 5. Honest caveats — the things to be ready for if they push back

Knowing your own gaps is what separates a confident answer from a brittle one. None of these are dealbreakers, but be ready:

1. **No reranker / RRF.** Hybrid fusion is interleave + dedup. Deliberate, given the small corpus; a clean future upgrade if recall ever matters.
2. **RAG is OFF by default.** Vector retrieval requires `RAG_ENABLED=true` **and** Azure Search credentials. With it off, the product **still fully works** — the DuckDB/SQL path is independent. (This is actually a strength: the analytical core doesn't depend on the vector store. But it means "do you do RAG?" deserves the precise answer *"the analytical engine is SQL; vector RAG is an optional grounding/memory layer we enable when configured."*)
3. **Embedding model default differs from prod** (`-small`/1536 in code, `-large`/3072 in the prod template). Quote the environment you actually run.
4. **Char-based prompt budgeting**, not token-exact. Bounded imprecision, not a data-correctness issue.
5. **Single-node DuckDB.** Per-session ceiling is the host. Warehouse push-down (Snowflake) is the scale path beyond that.
6. **Row content in the vector index is sampled/bounded** (≤ 2,000 rows or a 3,000-row sample), never the full table — by design, but say it plainly so it's not "discovered."

The unifying defense for all of these: **the correctness of an analytical answer never depends on the vector layer.** Numbers are SQL over the full dataset. RAG is a context/memory accelerator on top. That separation is the architecture's real strength.

---

## 6. Source map (verify any claim)

All paths relative to repo root. Read these to confirm anything above.

| Topic | File |
|---|---|
| Retrieval orchestration (hybrid, threshold, fusion) | `server/lib/rag/retrieve.ts` |
| Azure AI Search client (vector + BM25, OData filters) | `server/lib/rag/aiSearchStore.ts` |
| Embedding model + dimension guard | `server/lib/rag/embeddings.ts` |
| RAG flags, top-k, dimensions, on/off logic | `server/lib/rag/config.ts` |
| Chunking constants + what gets indexed | `server/lib/rag/chunking.ts` |
| Indexing pipeline, memory entries, 3k DuckDB sample | `server/lib/rag/indexSession.ts` |
| HNSW index definitions (m=4, efC=400, efS=500, cosine) | `server/lib/rag/createSearchIndex.ts`, `createPastAnalysesIndex.ts` |
| Past-Q&A reuse index | `server/lib/rag/pastAnalysesStore.ts` |
| Azure OpenAI clients | `server/lib/openai.ts` |
| SQL & RAG tool definitions for the agent | `server/lib/agents/runtime/tools/registerTools.ts` |
| How RAG hits enter the planner prompt | `server/lib/agents/runtime/planner.ts` |
| RAG block rendered "citation only, never numeric" | `server/lib/agents/runtime/buildSynthesisContext.ts` |
| Central prompt budget / truncation | `server/lib/agents/runtime/promptBudget.ts` |
| Full-dataset DuckDB materialization | `server/lib/ensureSessionDuckdbMaterialized.ts`, `server/utils/dataLoader.ts`, `server/lib/columnarStorage.ts` |
| SQL generation/execution over the full table | `server/lib/queryPlanDuckdbExecutor.ts` |
| Production embedding config (`-large`/3072) | `server/.env.example` |

---

*Bottom line: this is not a "retrieve-rows-and-hope" RAG tool. It's an agentic SQL analytics engine (DuckDB, full dataset, exact math) with an optional hybrid-vector grounding layer (Azure AI Search, metadata only) on top. Lead every answer with that distinction and the hard questions get easy.*
