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

- **Wave WV6 (2026-05-16)** — `run_price_elasticity` migrated to `composeFindingDetail`. Third per-tool migration in the WV4 series, completing the most-impactful triad (correlation / significance / elasticity). Headline group (top by |β|) emits its n + R² as a canonical WV2 suffix on both summary branches — single-fit (no-group) AND per-segment (`groupColumn`). The no-group branch's legacy inline `R²=X, n=N` is left in place (already extractable); the canonical block appended at the end gives a uniform format across migrated tools. Per-group branch previously had no inline R²/n at all — WV6 adds the headline group's evidence so WW2 can extract it. p-value not included (tool reports `significant: boolean` thresholded `|t| > 2`, not continuous p; t-CDF helper would be its own wave). 4 tests — clean log-log power-law fits with R² ≈ 1 on both branches + source-inspection wiring. See `docs/WAVES.md` for full entry.
- **Wave WV5 (2026-05-16)** — `run_significance_test` migrated to `composeFindingDetail`. Second per-tool migration of the WV2 formatter; first to cover multiple test branches in a single wave. All three sub-tests (welch_t / paired_t / chi_square) now append a canonical `(n = N; p = X)` suffix to their success-path summary via a shared `buildEvidenceSuffix` helper. Effective n is test-specific: welch_t → `sampleA + sampleB` (combined size of independent samples), paired_t → `sampleA` (pair count — NOT 2 × sampleA, because pairs aren't independent observations), chi_square → `sampleA` (grand total of the contingency table). WW2 extractor catches p (from the existing interpretation's `p=X` prose) and n (from the canonical suffix); WQ1 grades the finding by real evidence. No change to `runSignificanceTest` math; touches only [`significanceTestTool.ts`](../../server/lib/agents/runtime/tools/significanceTestTool.ts). 5 end-to-end tests through the registered tool + source-inspection wiring. See `docs/WAVES.md` for full entry.
- **Wave WV7 (2026-05-18)** — `run_segment_driver_analysis` now emits a canonical WV2 `FindingEvidence` suffix on its correlation branch's text. First composite-tool migration in the WV4 series: the tool lives at [`segmentDriverAnalysisTool.ts`](../../server/lib/segmentDriverAnalysisTool.ts) (one directory above `agents/runtime/tools/`, so the import paths are `./agents/runtime/formatFindingEvidence.js` rather than `../formatFindingEvidence.js`). The correlation branch destructures `topCorrelations` from `analyzeCorrelations` (the field WV4 plumbed through the analyzer's return type), picks the strongest correlation by |r|, computes `R² = correlation²` + reads `nPairs`, and concats `composeFindingDetail("", { n, rSquared })` onto the existing `Correlation scan on filtered slice (n=…) for **outcome**.` text. Empty `topCorrelations` → empty suffix → branch text byte-stable with pre-WV7. Closes the immediate per-tool migration backlog (WV4 + WV5 + WV6 + WV7 = all four high-volume statistical tools now evidence-carrying); the WW1 → WW2 → WV1 → WV2 → WV3 chain is now both structurally complete AND evidence-bearing for every direct + composite statistical tool. 6 tests. See `docs/WAVES.md` for full entry.
- **Wave WV4 (2026-05-16)** — `run_correlation` now emits a canonical WV2 `FindingEvidence` suffix on its success-path summary. `analyzeCorrelations` gains an optional `topCorrelations?: CorrelationResult[]` return field (already computed internally for chart selection — just plumbed out). The `run_correlation` tool wrapper imports `composeFindingDetail` from [`formatFindingEvidence.ts`](../../server/lib/agents/runtime/formatFindingEvidence.ts), computes `R² = correlation²` and reads `nPairs` from the strongest correlation, builds a `FindingEvidence`, and appends `composeFindingDetail("", evidence)` (e.g. `" (n = 1200; R² = 0.78)"`) to the summary string. Downstream `addFinding` in [`agentLoop.service.ts`](../../server/lib/agents/runtime/agentLoop.service.ts) carries this into the blackboard finding's `detail`, so WW2's regex extractor catches both fields and WQ1 grades correlation findings by real evidence instead of defaulting to `medium / no evidence supplied`. First per-tool migration; `run_significance_test` / `run_price_elasticity` / `run_segment_driver_analysis` can follow the same template. Defensive guards (`Number.isFinite`, range checks) make NaN / out-of-range silently drop to the empty suffix — no throws. 8 tests across math anchor, formatter shape, roundtrip, and source-inspection wiring. See `docs/WAVES.md` for full entry.
- **Wave WT4 (2026-05-16)** — `run_market_basket` registered (pure-Node 1-LHS apriori). Closes the market-basket question-shape gap from Workstream 5. Mines association rules `antecedent → consequent` from transaction baskets and returns `support / confidence / lift / count` per rule, sorted by lift desc with support desc on ties. Set semantics on (transaction, item) pairs — duplicate rows collapse. Args: `transactionIdColumn`, `itemColumn`, `minSupport` (0..1 default 0.01), `minConfidence` (0.01..1 default 0.3), `topN` (1..500 default 50), optional `dimensionFilters[]`. Emits BOTH directions a→b and b→a as separate rules with their own confidence. New file [marketBasketTool.ts](../../server/lib/agents/runtime/tools/marketBasketTool.ts). 19 tests. See `docs/WAVES.md` for full entry.
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
