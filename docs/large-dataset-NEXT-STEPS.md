# Large-Dataset Robustness — Next Steps (things only you can do)

> Companion to the roadmap (`/Users/tida/.claude/plans/goofy-wandering-quasar.md`) and the per-phase
> plans. Everything **I** could do safely and verify is shipped on branch `claude/large-dataset-robustness`.
> The items below need **infrastructure, credentials, a deploy, or real data** that I can't reach from the
> CLI — so they're yours. Each is small and specific.

## ✅ What's already shipped & safe (no action needed to keep it safe)

All on branch `claude/large-dataset-robustness`. **Every new code path is either live-and-additive or
flag-gated default-OFF**, so nothing currently working changes until you opt in.

| Wave | What | State |
|---|---|---|
| WG0 | Phase 0 guardrails (Snowflake truncation warning, Excel OOM guard, sampling badge, env caps, telemetry) | **LIVE** |
| WG1 / WG1.1 | Phase 1 Parquet/DuckDB-over-blob keystone + review fixes | flag-gated OFF |
| WG2.0 | Parquet writer hook wired into ingest | flag-gated OFF |

Verified throughout: server typecheck 98 (baseline), client 53 (baseline), Phase 0/1/2 unit + regression tests green, builds OK.

---

## 🔴 Action items (in priority order)

### 1. Merge the branch when you've reviewed it
```bash
git checkout main && git merge claude/large-dataset-robustness   # or open a PR
```
Safe to merge as-is: Phase 0 is live value; everything else is dormant behind `USE_PARQUET_READ_PATH` (default off).

### 2. Fix the pre-existing client build break (unrelated to this work, but it blocks `client build`)
`client/src/components/charts/ExportMenu.tsx` imports `html-to-image`, which was never added to `client/package.json`. This already failed before my changes.
```bash
cd client && npm i html-to-image
```

### 3. Run the Phase 1 feasibility spike on a Vercel preview (the one open architecture question)
Decides whether DuckDB can read a blob Parquet **remotely via a SAS URL** on Vercel's read-only FS, or must **download to /tmp** first. The code already handles both (dual-branch) — this just confirms which is faster so you can keep the optimal path.
```bash
# Deploy the branch to a Vercel preview (Azure Blob creds in env), then:
node --import tsx scripts/spikeParquetReadPath.ts   # prints a DECISION line
```

### 4. Enable the Parquet read path (after the spike), gradually
```
USE_PARQUET_READ_PATH=true   # in server env
```
Then uploads write a durable Parquet and reads open it instead of rehydrating all rows. Watch the
`📈 upload-telemetry` log line (Phase 0) — `rssMb` should stay flat as row count grows.

### 5. Provide infra so the remaining streaming-ingest waves can be implemented + verified
These are **fully planned** but need real data/connections to build correctly and prove they don't change results:
- **Snowflake test connection** → Phase 2 Snowflake cursor-streaming (removes the 500k cap). Plan: `phase2-streaming-ingest.md`.
- **OK to generate large fixtures** → Phase 5 scale/E2E tests. Generate with the new script:
  ```bash
  node --import tsx scripts/makeLargeFixture.ts 1000000  /tmp/fixture-1m.csv
  node --import tsx scripts/makeLargeFixture.ts 10000000 /tmp/fixture-10m.csv
  ```
- **A Cosmos instance + a way to drive concurrent requests** → Phase 4 ETag concurrency testing.

---

## 🟡 Remaining implementation (planned, waiting on the above)

| Phase | Scope | Needs | Plan file |
|---|---|---|---|
| 2 | Native CSV `read_csv_auto` ingest; `exceljs` Excel streaming; Snowflake cursor streaming | real CSV/XLSX fixtures + Snowflake conn (to verify result parity) | `phase2-streaming-ingest.md` |
| 3 | Preview pagination; streamed exports; push-down `loadLatestData` callers | care around the "no-downsampling" preview consumers | `phase3-streaming-serve.md` |
| 4 | Cosmos `ifMatch` ETag; durable upload jobs | Cosmos + concurrency harness | `phase4-multitenant-concurrency.md` |
| 5 | 1M/10M fixtures, E2E, load test, CI perf budget | the fixtures above | `phase5-scale-validation.md` |

> I stopped short of implementing these because doing them blind (without fixtures/infra to verify result
> parity) would risk changing ingest behaviour on a stable production codebase — exactly what you asked me
> to avoid. They're specified down to file:line and reusable primitives, ready to execute.

---

## ⚙️ Config knobs introduced (all env, all safe defaults)

| Env var | Default | Effect |
|---|---|---|
| `USE_PARQUET_READ_PATH` | `false` | Master switch for the Phase 1 Parquet read/write path |
| `UPLOAD_MAX_BYTES` | 200 MB | Max upload size |
| `CHUNKING_THRESHOLD_BYTES` | 10 MB | File size → chunked ingest |
| `LARGE_FILE_THRESHOLD_BYTES` | 50 MB | File size → DuckDB native large-file path |
| `MAX_ROWS_FOR_AI_ANALYSIS` | 100k | Rows sampled for LLM analysis |
| `SNOWFLAKE_MAX_IMPORT_ROWS` | 500k | Snowflake import cap (warns when hit) |
| `MAX_ROWS_FOR_DATA_SUMMARY_PROFILE` | 300k | Rows sampled for the data-summary profile |
| `MAX_EXCEL_ROWS_IN_MEMORY` | 1M | Excel sheet refused above this (until streaming lands) |

Raise any of these per environment; they were previously hardcoded literals (`server/config/uploadLimits.ts`).
