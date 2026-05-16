# Tool registry

## Purpose

The single place every runtime tool is declared, args-validated, and
executed. The planner sees tools through `formatToolManifestForPlanner`;
the loop runs them through `ToolRegistry.execute`.

## Key files

- `server/lib/agents/runtime/toolRegistry.ts` — the `ToolRegistry` class.
  Exposes `register`, `execute`, `argsValidForTool`,
  `getArgsParseError`, `listToolDescriptions`,
  `formatToolManifestForPlanner`.
- `server/lib/agents/runtime/tools/registerTools.ts` — boot-time
  registration of every built-in tool. Called once per process from
  `runtime/context.ts`.
- `server/lib/agents/runtime/tools/*.ts` — individual tool modules:
  - `breakdownRankingTool.ts`
  - `twoSegmentCompareTool.ts`
  - `patchDashboardTool.ts`
  - (plus every tool registered inline in `registerTools.ts`)

## Data contracts

- **`ToolExecutor`** `(ctx, args) => Promise<ToolResult>` — tool
  entrypoint.
- **`ToolRunContext`** — `{ exec: AgentExecutionContext; config:
  AgentConfig }`. `exec` carries the session, dataset summary, working
  memory, and SSE emitter.
- **`ToolResult`** — structured outcome: `ok`, `summary`, optional
  `charts`, `insights`, `numericPayload`, `table`, `operationResult`,
  `queryPlanParsed`, `workbenchArtifact`, `memorySlots`, etc. Fields
  are additive; callers should ignore unknown fields. See `toolRegistry.ts`
  for the full interface.
- **`ToolManifestEntry`** — `{ description: string; argsHelp: string }`.
  `argsHelp` is a JSON-shaped hint the planner is told to respect
  strictly; unknown keys are rejected by the zod schema at execute time.

## Registration policy

- **Duplicate names throw.** `ToolRegistry.register` checks
  `this.tools.has(name)` and throws
  `ToolAlreadyRegisteredError` when the name is taken. Boot-time
  registration runs once per process; a throw in prod means a merge
  conflict landed that needs real review, not silent swap.
- **Arg schema is strict.** The zod input schema for each tool should
  reject unknown keys (`.strict()` or explicit `.passthrough()` only
  with a written reason).

## Runtime flow

1. Boot: `registerTools(registry)` is called from `context.ts` when the
   server creates its first agent execution context. Every tool module
   runs `registry.register(name, schema, run, meta)`.
2. Planner prompt: `registry.formatToolManifestForPlanner(maxChars)`
   produces the block the planner sees. Args-help strings are listed
   literally; the planner is told they're strict.
3. Execution: the agent loop calls `registry.execute(name, rawArgs, ctx)`.
   - Unknown tool → `{ ok: false, summary: "Unknown tool: <name>" }`
     (no throw; the loop's reflector sees it as a normal failure).
   - Invalid args → `{ ok: false, summary: "Invalid args for <name>: <zod>" }`.
   - Thrown exception → logged as `tool_error`, returned as `ok: false`
     with the error message.

## Extension points

- **Add a tool**: new file under `runtime/tools/`, export `(ctx, args) =>
  Promise<ToolResult>`. Register it in `registerTools.ts` with a zod
  schema, a description, and an `argsHelp` hint.
- **Args-help discipline**: keep `argsHelp` one-line where possible.
  The planner prompt is budget-constrained; verbose hints evict real
  context. `formatToolManifestForPlanner` truncates at `maxChars` and
  appends `(manifest truncated)` if needed.

## Known pitfalls

- **Before Wave F2**, `register(name, …)` silently overwrote an existing
  tool. A duplicate `run_query_plan` from a bad merge could swap the
  implementation at runtime with zero signal. The throw-on-duplicate
  guard makes the failure explicit.
- **Tool exceptions are caught.** The registry converts any thrown
  error into `ok: false`. The reflector / verifier sees the failure;
  the loop does not crash. Write tools that throw readable messages.
- **`numericPayload` is the only channel for deterministic re-verify.**
  Verifier replay depends on this; don't stuff narrative strings into
  it.

## Recent changes

- **Wave WT7 (2026-05-16)** — `run_price_elasticity` registered (pure-Node). Closes the price-elasticity question-shape gap from Workstream 5. Log-log OLS fit: `log(quantity) = a + b · log(price)` → slope `b` is the price elasticity. Returns `elasticity`, `intercept`, `r_squared`, `slope_se`, 95% CI, `t_value`, `significant` flag, and a categorical `interpretation` (highly inelastic / inelastic / unit elastic / elastic / highly elastic / anomalous / not statistically significant). Optional `groupColumn` for per-segment fits; `minObservations` (3..1000, default 6) skips unstable groups; skips non-positive price/quantity rows. New file [priceElasticityTool.ts](../../server/lib/agents/runtime/tools/priceElasticityTool.ts). 24 tests. See `docs/WAVES.md` for full entry.
- **Wave WT3 (2026-05-16)** — `run_rfm_segmentation` registered (pure-Node). Closes the RFM question-shape gap from Workstream 5. Scores each entity on Recency / Frequency / Monetary (quintiles by default, 3..7 buckets configurable) and assigns canonical segment labels (Champions / Loyal / At Risk / Cant Lose Them / Hibernating / Lost / New Customers / About to Sleep / Potential Loyalist / Regular). `frequencyMode` toggles between row count and distinct-period count. `maxEntities` caps the table; `numericPayload.segmentBreakdown` always covers the full population. New file [rfmSegmentationTool.ts](../../server/lib/agents/runtime/tools/rfmSegmentationTool.ts). 23 tests. See `docs/WAVES.md` for full entry.
- **Wave WT2 (2026-05-16)** — `run_cohort_analysis` registered (pure-Node). Closes the cohort/retention question-shape gap from the 1000x master plan Workstream 5. Groups entities by cohort (acquisition period if `cohortColumn` omitted, else explicit column value) and tracks aggregated activity across period offsets. Args: `entityColumn`, `periodColumn`, optional `cohortColumn` / `metricColumn`, `aggregation` (count_distinct/sum/mean, default count_distinct), `maxPeriods` (2..24, default 12), `retentionMode` (normalises every cell by period_offset_0), optional `dimensionFilters[]`. Output is a wide-format cohort × offset matrix with `cohort_size` (distinct-entity count in period_offset_0). New file [cohortAnalysisTool.ts](../../server/lib/agents/runtime/tools/cohortAnalysisTool.ts). 20 tests. See `docs/WAVES.md` for full entry.
- **Wave WT8 (2026-05-16)** — `run_hierarchical_drill` registered (pure-Node, no Python service). Rolls high-cardinality dimensions into top-N + "Other" so matrix breakdown charts with 50+ categories stay readable. `_rank: -1` flags the rolled bucket; `_share` is the 0..1 fraction of grand total. Args: `dimension`, `metricColumn`, `aggregation` (sum/mean/count/min/max, default sum), `topN` (2..50, default 10), `direction` (asc/desc, default desc), `otherLabel`, optional `dimensionFilters[]`. mean-of-the-Other-bucket uses row-level total/count, not mean-of-means. New file [hierarchicalDrillTool.ts](../../server/lib/agents/runtime/tools/hierarchicalDrillTool.ts). 19 tests. See `docs/WAVES.md` for full entry.
- **Waves W46-W51** — `run_correlation` no longer fails silently. Six tiny
  waves harden the path:
  - **W46**: `analyzeCorrelations` returns `diagnostic?: CorrelationDiagnostic`
    with one of six `reason`s explaining empty payloads.
  - **W47**: tool handler validates that the current frame actually contains
    the target column; auto-recovers from `turnStartDataRef` when the previous
    tool aggregated `ctx.exec.data` (e.g. after `run_aggregation`).
  - **W48**: target column resolved via the existing `findMatchingColumn`
    fuzzy matcher — `"sales"` resolves against schema `"Total Sales"`, etc.
  - **W49**: returns `ok:false` with the diagnostic summary when nothing was
    produced, so the reflector can retry instead of treating empty as success.
  - **W50**: deterministic insight fallback when the LLM call throws or
    returns garbage — users always see top correlations from raw values.
  - **W51**: integration tests
    (`server/tests/runCorrelationFrameFit.test.ts`) +
    planner-prompt note.
- **Wave F2** — `ToolRegistry.register` throws
  `ToolAlreadyRegisteredError` when the tool name is taken. Boot-time
  registration runs once per process; a collision means a merge
  conflict landed two implementations. Test:
  `server/tests/toolRegistryDuplicateGuard.test.ts`. Skill registry
  stays idempotent on purpose (HMR, test re-imports) — the asymmetry
  is documented in `skills.md` "Known pitfalls".
- Initial seed of this doc.
