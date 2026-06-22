/**
 * ============================================================================
 * registerTools.ts — wires every agent tool into the registry so the act loop
 *                     can discover and call them
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The "agent" in this product answers a question by running a plan/act loop:
 *   a planner LLM picks a sequence of TOOLS to call, and an act loop executes
 *   them one by one. A TOOL is a named capability — e.g. "run SQL on the
 *   dataset", "compute correlations", "build a chart", "search the web". Each
 *   tool is just four things bundled together:
 *     1. a NAME           — the string the planner uses to call it (e.g.
 *                           "execute_query_plan").
 *     2. an ARG SCHEMA    — a Zod schema describing the JSON arguments the tool
 *                           accepts. Zod validates the LLM's arguments before
 *                           the handler runs, so bad/unknown keys are rejected
 *                           with a clear error instead of crashing. Most schemas
 *                           here are `.strict()`, meaning "no extra keys allowed".
 *     3. a HANDLER (run)  — an async function `(ctx, args) => ToolResult` that
 *                           does the actual work. `ctx` carries the execution
 *                           context (the dataset rows, schema summary, session
 *                           id, current question, config caps, etc.); the result
 *                           carries `ok`, a human/LLM-readable `summary`, and
 *                           optional structured payloads (charts, tables,
 *                           memorySlots for chained planning, workbench
 *                           artifacts).
 *     4. METADATA         — a `description` (the one-liner the planner LLM sees
 *                           and uses to decide WHEN to call the tool) and
 *                           `argsHelp` (an example of the exact arg shape, since
 *                           strict schemas reject anything unexpected).
 *
 *   `registerDefaultTools(registry)` is the single entry point. It calls
 *   `registry.register(name, schema, handler, meta)` once per tool. Some tools
 *   live inline in this file (e.g. retrieve_semantic_context, get_schema_summary,
 *   run_analytical_query, execute_query_plan, run_correlation, build_chart). The
 *   rest live in their own `runtime/tools/<name>Tool.ts` file and are pulled in
 *   via `register<Name>Tool(registry)` calls near the bottom — same effect, just
 *   organised per-tool for the bigger ones.
 *
 * WHY IT MATTERS
 *   This is the SINGLE SOURCE OF TRUTH for what the agent can do. If a tool is
 *   not registered here, the planner never sees it and the act loop can never
 *   call it. Adding a new capability means: write `tools/<name>Tool.ts`, then
 *   wire a `register<Name>Tool(registry)` line into `registerDefaultTools`.
 *
 *   INVARIANT — duplicate tool names are a FATAL BOOT ERROR. `registry.register`
 *   throws `ToolAlreadyRegisteredError` if the same name is registered twice
 *   (see toolRegistry.ts). The registry is populated exactly once at startup, so
 *   a duplicate almost always means a merge accidentally landed two
 *   implementations — we fail loud rather than silently swap behaviour.
 *
 * KEY PIECES
 *   - registerDefaultTools(registry) — the one exported function; registers
 *       every tool. Called once per agent run.
 *   - inline tools — retrieve_semantic_context (RAG vector search),
 *       get_schema_summary, sample_rows, run_analytical_query (NL → aggregates,
 *       DuckDB-backed when columnar storage is active), execute_query_plan
 *       (structured query plan, DuckDB-first for aggregations),
 *       derive_dimension_bucket, add_computed_columns, run_readonly_sql,
 *       run_correlation, run_segment_driver_analysis (flag-gated), build_chart,
 *       clarify_user, run_data_ops.
 *   - delegated registrars — registerBreakdownRankingTool, …,
 *       registerExecuteMetricQueryTool: each registers one tool defined in its
 *       own file under runtime/tools/.
 *   - helpers — allowlistedColumns / allowedColumnNames / assertColumns /
 *       assertChartColumns guard arguments against the dataset schema and the
 *       current in-memory frame; logAnalyticalToolMeta emits structured logs.
 *
 * HOW IT CONNECTS
 *   - Imports the registry type from ../toolRegistry.ts, and one symbol from
 *     each runtime/tools/*Tool.ts file it wires in.
 *   - Consumed by agentLoop.service.ts (the act loop): it does
 *     `registerDefaultTools(registry)` at startup, then `registry.execute(...)`
 *     to run each planned step. replayLoop.service.ts does the same for replays.
 *   - planner.ts calls `registry.formatToolManifestForPlanner()` to render the
 *     name + description + argsHelp of every tool into the planner prompt — that
 *     is how the LLM learns the menu of capabilities defined here.
 */
import { z } from "zod";
import { ToolRegistry, type ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";
import { AGENT_WORKBENCH_ENTRY_CODE_MAX, isAgenticLoopEnabled } from "../runtimeConfig.js";
import { executeAnalyticalQuery } from "../../../analyticalQueryExecutor.js";
import type { DimensionFilter, ParsedQuery } from "../../../../shared/queryTypes.js";
import { filterRowsByDimensionFilters } from "../../../dataTransform.js";
import {
  diagnosticSliceRowCap,
  isDiagnosticCompositeToolEnabled,
} from "../../../diagnosticPipelineConfig.js";
import {
  runSegmentDriverAnalysisTool,
  segmentDriverArgsSchema,
} from "../../../segmentDriverAnalysisTool.js";
import { analyzeCorrelations } from "../../../correlationAnalyzer.js";
import { bucketCorrelationR } from "../../../correlationMath.js";
import { composeFindingDetail } from "../formatFindingEvidence.js";
import type { FindingEvidence } from "../scaleNarrativeByConfidence.js";
import { processChartData } from "../../../chartGenerator.js";
import { compileChartSpec } from "../../../chartSpecCompiler.js";
import { isTemporalChartX } from "../../../chartTypeAuthority.js";
import { chartSpecSchema, type AgentWorkbenchEntry } from "../../../../shared/schema.js";
import {
  executeQueryPlan,
  executeQueryPlanArgsSchema,
  normalizeAndValidateQueryPlanBody,
  questionImpliesSumAggregation,
  queryPlanToParsedQuery,
  remapQueryPlanGroupByToTemporalFacets,
  validateCoarseDateAggregationOutput,
} from "../../../queryPlanExecutor.js";
import {
  canExecuteQueryPlanOnDuckDb,
  executeQueryPlanOnDuckDb,
} from "../../../queryPlanDuckdbExecutor.js";
import {
  pickRowLevelDataForQueryPlan,
  promoteQueryPlanDateAggregationToFacetGroupBy,
} from "../../../queryPlanFacetPromotion.js";
import {
  migrateLegacyTemporalFacetRowKeys,
  facetColumnKey,
  parseTemporalFacetDisplayKey,
  type TemporalFacetGrain,
} from "../../../temporalFacetColumns.js";
import type { DatePeriod } from "../../../dateUtils.js";
import { shouldRejectWideWithoutAgg } from "../../../questionAggregationPolicy.js";
import { findMatchingColumn } from "../../utils/columnMatcher.js";
import type { DataSummary } from "../../../../shared/schema.js";
import {
  deriveDimensionBucketArgsSchema,
  applyDeriveDimensionBucket,
} from "../../../deriveDimensionBucket.js";
import {
  executeReadonlySqlOnFrame,
  READONLY_SQL_MAX_LENGTH,
  sanitizeReadonlyDatasetSql,
} from "../../../agentReadonlySql.js";
import {
  addComputedColumnsArgsSchema,
  applyAddComputedColumns,
  replaceSummaryFromFresh,
} from "../../../computedColumns.js";
import { createDataSummary } from "../../../fileParser.js";
import { saveModifiedData } from "../../../dataOps/dataPersistence.js";
import queryCache from "../../../cache.js";
import {
  ColumnarStorageService,
  isDuckDBAvailable,
} from "../../../columnarStorage.js";
import { getTurnColumnarStorage } from "../turnColumnarStorage.js";
import { metadataService } from "../../../metadataService.js";
import { registerBreakdownRankingTool } from "./breakdownRankingTool.js";
import { registerTwoSegmentCompareTool } from "./twoSegmentCompareTool.js";
import { registerPatchDashboardTool } from "./patchDashboardTool.js";
import { registerWebSearchTool } from "./webSearchTool.js";
import { registerBudgetOptimizerTool } from "./budgetOptimizerTool.js";
import { registerComputeGrowthTool } from "./computeGrowthTool.js";
import { registerDetectSeasonalityTool } from "./detectSeasonalityTool.js";
import { registerForecastTool } from "./forecastTool.js";
import { registerAnomalyDetectionTool } from "./anomalyDetectionTool.js";
import { registerHierarchicalDrillTool } from "./hierarchicalDrillTool.js";
import { registerCohortAnalysisTool } from "./cohortAnalysisTool.js";
import { registerRfmSegmentationTool } from "./rfmSegmentationTool.js";
import { registerPriceElasticityTool } from "./priceElasticityTool.js";
import { registerMarketBasketTool } from "./marketBasketTool.js";
import { registerSignificanceTestTool } from "./significanceTestTool.js";
import { registerExecuteMetricQueryTool } from "./executeMetricQueryTool.js";
import { logger } from "../../../logger.js";
import { errorMessage } from "../../../../utils/errorMessage.js";

function appliedAggregationFromParsed(pq: ParsedQuery | null | undefined): boolean {
  return !!(pq?.aggregations?.length);
}

const emptyArgs = z.object({}).strict();
const sampleRowsArgs = z
  .object({
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
const analyticalArgs = z
  .object({
    question_override: z.string().optional(),
  })
  .strict();
const correlationDimensionFilterSchema = z
  .object({
    column: z.string(),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

const correlationArgs = z
  .object({
    targetVariable: z.string(),
    filter: z.enum(["all", "positive", "negative"]).optional(),
    /** When set, correlation runs on this slice of **turn-start** row-level data (not on aggregated ctx.data). */
    dimensionFilters: z.array(correlationDimensionFilterSchema).max(12).optional(),
  })
  .strict();
const chartArgs = z
  .object({
    type: z.enum(["line", "bar", "scatter", "pie", "area", "heatmap"]),
    x: z.string(),
    y: z.string(),
    z: z.string().optional(),
    seriesColumn: z.string().optional(),
    barLayout: z.enum(["stacked", "grouped"]).optional(),
    y2: z.string().optional(),
    title: z.string().optional(),
    aggregate: z.enum(["sum", "mean", "count", "none"]).optional(),
    max_series: z.number().int().min(3).max(20).optional(),
    /** Explicit time bucket for a date x-axis (day/week/month/quarter/half_year/year). "auto"/omit = let the resolver pick. */
    grain: z
      .enum(["day", "week", "month", "quarter", "half_year", "year", "auto"])
      .optional(),
  })
  .strict();
const clarifyArgs = z
  .object({
    message: z.string(),
  })
  .strict();
const runDataOpsArgs = z
  .object({
    reason: z.string().optional(),
  })
  .strict();
const retrieveSemanticArgs = z
  .object({
    query: z.string().min(1).max(2000),
  })
  .strict();

// Part 3.2 · recall a prior turn's FULL analytical result so a follow-up can
// build on it instead of re-deriving.
const retrievePriorResultArgs = z
  .object({
    query: z.string().min(1).max(2000),
  })
  .strict();
const readonlySqlArgs = z
  .object({
    sql: z.string().min(1).max(READONLY_SQL_MAX_LENGTH),
  })
  .strict();

function allowlistedColumns(ctx: ToolRunContext): Set<string> {
  return new Set(ctx.exec.summary.columns.map((c) => c.name));
}

/** Schema headers plus keys on the current in-memory frame (e.g. aggregated query output). */
function allowedColumnNames(ctx: ToolRunContext): Set<string> {
  const allow = allowlistedColumns(ctx);
  const row0 = ctx.exec.data[0];
  if (row0 && typeof row0 === "object") {
    for (const k of Object.keys(row0)) {
      allow.add(k);
    }
  }
  return allow;
}

function assertColumns(ctx: ToolRunContext, names: string[]): string | null {
  const allow = allowedColumnNames(ctx);
  for (const n of names) {
    if (!allow.has(n)) {
      return `Column not in schema: ${n}`;
    }
  }
  return null;
}

/** When the frame looks aggregated, x/y must resolve to keys on the current rows (e.g. Sales_sum). */
function assertChartColumns(ctx: ToolRunContext, names: string[]): string | null {
  const row0 = ctx.exec.data[0];
  const keys =
    row0 && typeof row0 === "object" ? Object.keys(row0 as object) : [];
  const hasAggShape = keys.some((k) => /_(sum|mean|avg|count|min|max|median)$/i.test(k));

  for (const n of names) {
    if (hasAggShape) {
      const m = findMatchingColumn(n, keys);
      if (!m || !keys.includes(m)) {
        return `Column not on current result rows: ${n}. Use keys from the last query output (e.g. Sales_sum). Available: ${keys.slice(0, 40).join(", ")}${keys.length > 40 ? "…" : ""}`;
      }
      continue;
    }
    const err = assertColumns(ctx, [n]);
    if (err) return err;
  }
  return null;
}

function topDistinctStrings(
  data: Record<string, any>[],
  col: string,
  maxScan: number,
  maxReturn: number
): string[] {
  const slice = data.slice(0, Math.min(data.length, maxScan));
  const counts = new Map<string, number>();
  for (const row of slice) {
    const v = row[col];
    if (v === null || v === undefined || v === "") continue;
    const k = String(v);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxReturn)
    .map(([k]) => k);
}

function logAnalyticalToolMeta(
  tool: string,
  summary: DataSummary,
  parsed: ParsedQuery | null | undefined
) {
  const gb = parsed?.groupBy ?? [];
  const period = parsed?.dateAggregationPeriod ?? "";
  const ops = (parsed?.aggregations ?? []).map((a) => a.operation).join(",");
  const dateBucketSchemaApplied =
    gb.length > 0 && gb.every((c) => summary.dateColumns.includes(c));
  agentLog("tool_analytical_meta", {
    tool,
    groupBy: gb.join("|").slice(0, 240),
    dateAggregationPeriod: String(period),
    aggOps: ops.slice(0, 200),
    dateBucketSchemaApplied,
  });
}

export function registerDefaultTools(registry: ToolRegistry) {
  registry.register(
    "retrieve_semantic_context",
    retrieveSemanticArgs,
    async (ctx, args) => {
      const { isRagEnabled } = await import("../../../rag/config.js");
      if (!isRagEnabled()) {
        return {
          ok: false,
          summary: isAgenticLoopEnabled()
            ? "Semantic retrieval is not configured. Set RAG_ENABLED=true and AZURE_SEARCH_* (required when the agentic loop is enabled)."
            : "Semantic retrieval is not configured (set RAG_ENABLED and Azure AI Search env).",
        };
      }
      const { retrieveRagHits, formatHitsForPrompt } = await import("../../../rag/retrieve.js");
      const params = {
        sessionId: ctx.exec.sessionId,
        question: args.query as string,
        summary: ctx.exec.summary,
        dataVersion: ctx.exec.dataBlobVersion,
      };
      let { hits, suggestedColumns, retrievalError } = await retrieveRagHits(params);
      if (retrievalError) {
        const retry = await retrieveRagHits(params);
        hits = retry.hits;
        suggestedColumns = retry.suggestedColumns;
        retrievalError = retry.retrievalError;
      }
      if (retrievalError) {
        return {
          ok: false,
          summary:
            "Semantic retrieval is temporarily unavailable. Please try again in a moment.",
        };
      }
      const text = formatHitsForPrompt(hits);
      if (!text.trim()) {
        return {
          ok: true,
          summary: "No indexed passages matched this query.",
          suggestedColumns,
          ragHitCount: hits.length,
          memorySlots: suggestedColumns?.length
            ? { suggested_columns: suggestedColumns.slice(0, 20).join(",") }
            : undefined,
        };
      }
      return {
        ok: true,
        summary: text.slice(0, 6000),
        numericPayload: text,
        suggestedColumns,
        ragHitCount: hits.length,
        memorySlots: suggestedColumns?.length
          ? { suggested_columns: suggestedColumns.slice(0, 20).join(",") }
          : undefined,
      };
    },
    {
      description:
        "Vector search over indexed session chunks (themes, wording, narrative text).",
      argsHelp: '{"query": string} required — natural-language search text; not SQL.',
    }
  );

  // Part 3.2 · Full-fidelity recall of a prior turn's analytical RESULT TABLE.
  // Use for follow-ups that build on an earlier answer ("now break that down by
  // X", "of those…", "compare to the last result") — recall the stored rows
  // instead of re-deriving or guessing. Distinct from retrieve_semantic_context
  // (which returns narrative passages, not result rows).
  registry.register(
    "retrieve_prior_result",
    retrievePriorResultArgs,
    async (ctx, args) => {
      let match;
      try {
        const { findRelevantPriorResult } = await import(
          "../../../pastAnalysisRecall.js"
        );
        match = await findRelevantPriorResult(
          ctx.exec.sessionId,
          args.query as string
        );
      } catch (err) {
        return {
          ok: false,
          summary: `Prior-result recall failed: ${
            errorMessage(err)
          }`,
        };
      }
      if (!match) {
        return {
          ok: false,
          summary:
            "No prior analytical result in this session matched that description. Compute it fresh with execute_query_plan.",
        };
      }
      const PREVIEW = 200;
      const preview = match.rows.slice(0, PREVIEW);
      const header = match.columns.join(" | ");
      const body = preview
        .map((r) =>
          match.columns
            .map((c) => String((r as Record<string, unknown>)[c] ?? ""))
            .join(" | ")
        )
        .join("\n");
      const more =
        match.rowCount > preview.length
          ? `\n… (${match.rowCount - preview.length} more rows available)`
          : "";
      const text =
        `PRIOR RESULT — recalled from an earlier turn that asked: "${match.question.slice(0, 200)}"\n` +
        `${match.rowCount} rows · columns: ${header}\n${body}${more}`;
      return {
        ok: true,
        summary: text.slice(0, 6000),
        numericPayload: text,
      };
    },
    {
      description:
        "Recall the FULL result table the agent computed in an EARLIER turn of this session (stored durably server-side), so a follow-up builds on it instead of re-deriving. Returns the prior result's rows + columns + the question it answered.",
      argsHelp:
        '{"query": string} required — describe the prior result to recall (e.g. "top 10 products by sales from earlier").',
    }
  );

  registry.register(
    "get_schema_summary",
    emptyArgs,
    async (ctx) => {
      const s = ctx.exec.summary;
      const lines = [
        `rows=${s.rowCount}`,
        `columns=${s.columns.map((c) => `${c.name}(${c.type})`).join(", ")}`,
        `numeric=${s.numericColumns.join(", ")}`,
        `dates=${s.dateColumns.join(", ")}`,
      ];
      const dimHints = s.columns
        .filter((c) => c.type === "string" && c.topValues && c.topValues.length > 0)
        .map(
          (c) =>
            `${c.name}=[${c.topValues!.map((t) => String(t.value)).slice(0, 14).join("|")}]`
        );
      if (dimHints.length) {
        lines.push(`dimension_top_values=${dimHints.join("; ").slice(0, 4000)}`);
      }
      const colNames = s.columns.map((c) => c.name).join(",");
      if (ctx.exec.data.length > 0) {
        const dataKeys = new Set(Object.keys(ctx.exec.data[0]!));
        const missing = s.columns
          .map((c) => c.name)
          .filter((n) => !dataKeys.has(n) && !n.startsWith("__tf_"));
        if (missing.length > 0) {
          lines.push(
            `⚠️ schema_columns_not_in_loaded_frame=${missing.slice(0, 20).join(",")}`
          );
        }
      }
      return {
        ok: true,
        summary: lines.join("\n"),
        memorySlots: {
          column_names: colNames.slice(0, 800),
          numeric_columns: s.numericColumns.join(",").slice(0, 400),
        },
      };
    },
    {
      description: "Cheap overview: row count, column names and types.",
      argsHelp: "{} (no keys)",
    }
  );

  registry.register(
    "sample_rows",
    sampleRowsArgs,
    async (ctx, args) => {
      const limit = Math.min(
        (args.limit as number | undefined) ?? ctx.config.sampleRowsCap,
        ctx.config.sampleRowsCap
      );
      const rows = ctx.exec.data.slice(0, limit);
      return {
        ok: true,
        summary: `First ${rows.length} rows (JSON preview truncated).`,
        numericPayload: JSON.stringify(rows.slice(0, 3)),
      };
    },
    {
      description: "Preview first N in-memory rows.",
      argsHelp: '{"limit"?: number}',
    }
  );

  registry.register(
    "run_analytical_query",
    analyticalArgs,
    async (ctx, args) => {
      const q = (args.question_override as string | undefined) || ctx.exec.question;
      const res = await executeAnalyticalQuery(
        q,
        ctx.exec.data,
        ctx.exec.summary,
        ctx.exec.chatHistory
      );
      if (!res.isAnalytical) {
        return { ok: true, summary: "Question not classified as analytical; no query run." };
      }
      if (!res.queryResults) {
        return {
          ok: false,
          summary: "Analytical intent but query could not be executed (low parse confidence or error).",
        };
      }

      // When columnar storage is active, attempt to upgrade the in-memory result
      // to a full-dataset DuckDB execution (same data source as the pivot).
      // Guard: only when the parsed query has aggregations AND no filter types that
      // have no QueryPlanBody equivalent (timeFilters, valueFilters, exclusionFilters)
      // — dropping those silently would produce wrong results.
      if (
        ctx.exec.columnarStoragePath &&
        ctx.exec.sessionId &&
        isDuckDBAvailable() &&
        res.parsedQuery?.aggregations?.length &&
        !res.parsedQuery.timeFilters?.length &&
        !res.parsedQuery.valueFilters?.length &&
        !res.parsedQuery.exclusionFilters?.length
      ) {
        const plan = {
          groupBy: res.parsedQuery.groupBy,
          aggregations: res.parsedQuery.aggregations,
          dimensionFilters: res.parsedQuery.dimensionFilters,
          dateAggregationPeriod: res.parsedQuery.dateAggregationPeriod ?? undefined,
          sort: res.parsedQuery.sort,
          limit: res.parsedQuery.limit,
        };
        const validated = normalizeAndValidateQueryPlanBody(ctx.exec.summary, plan);
        if (validated.ok && canExecuteQueryPlanOnDuckDb(validated.normalizedPlan)) {
          try {
            // PERF-10 · Reuse the per-turn shared DuckDB handle.
            const { storage: sharedStorage } = await getTurnColumnarStorage(ctx.exec);
            const duck = await executeQueryPlanOnDuckDb(
              ctx.exec.sessionId,
              validated.normalizedPlan,
              ctx.exec.summary,
              ctx.exec.chatDocument,
              ctx.exec.abortSignal,
              sharedStorage
            );
            if (duck.ok) {
              const duckRows = duck.rows as Record<string, any>[];
              const duckInputCount = duck.inputRowCount;
              const duckOutputCount = duckRows.length;
              // Sum/mean guard still applies.
              if (
                questionImpliesSumAggregation(q) &&
                res.parsedQuery.aggregations?.length
              ) {
                const ops = res.parsedQuery.aggregations.map((a) => a.operation);
                if (!ops.some((o) => o === "sum") && ops.every((o) => o === "mean" || o === "avg")) {
                  agentLog("tool_verifier_reject", { tool: "run_analytical_query", reason: "total_requires_sum_not_mean" });
                  return {
                    ok: false,
                    summary: `The question asks for a total/sum but the parsed query only used mean/average. Replan with question_override that explicitly requests SUM (e.g. "sum of [numeric column] by [breakdown column]") using exact column names.`,
                    analyticalMeta: { inputRowCount: duckInputCount, outputRowCount: duckOutputCount, appliedAggregation: true },
                    memorySlots: { analytical_snippet: "total_requires_sum_not_mean" },
                  };
                }
              }
              const duckDesc = duck.descriptions.length ? duck.descriptions.join("; ") : "Query executed on full dataset.";
              const duckFormatted = JSON.stringify(duckRows.slice(0, 200), null, 2);
              const prev = duckFormatted.length > 2000 ? duckFormatted.slice(0, 2000) + "…" : duckFormatted;
              const duckCols = duckRows.length > 0 ? Object.keys(duckRows[0]!) : [];
              const duckMeta = { inputRowCount: duckInputCount, outputRowCount: duckOutputCount, appliedAggregation: true };
              let workbenchArtifact: AgentWorkbenchEntry | undefined;
              if (res.parsedQuery) {
                const code = JSON.stringify(res.parsedQuery, null, 2);
                workbenchArtifact = {
                  id: `pq-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                  kind: "query_spec",
                  title: "Parsed analytical query (full dataset)",
                  code: code.slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX),
                  language: "json",
                };
              }
              logAnalyticalToolMeta("run_analytical_query", ctx.exec.summary, res.parsedQuery);
              return {
                ok: true,
                summary: `${duckDesc}\n${prev}`,
                numericPayload: duckFormatted.slice(0, 8_000),
                analyticalMeta: duckMeta,
                queryPlanParsed: res.parsedQuery ?? null,
                table: { rows: duckRows, columns: duckCols, rowCount: duckOutputCount },
                memorySlots: { analytical_snippet: duckFormatted.replace(/\s+/g, " ").slice(0, 800) },
                workbenchArtifact,
              };
            }
          } catch {
            // Fall through to in-memory result.
          }
        }
      }

      // In-memory fallback (or primary path when columnar is not active).
      const { formattedResults, summary: rs, data: resultRows } = res.queryResults;
      const inputRowCount = ctx.exec.data.length;
      const outputRowCount = resultRows.length;
      const appliedAggregation = appliedAggregationFromParsed(res.parsedQuery);
      const analyticalMeta = {
        inputRowCount,
        outputRowCount,
        appliedAggregation,
      };

      if (outputRowCount === 0 && inputRowCount >= 10) {
        const pq = res.parsedQuery;
        const colsToSample = new Set<string>();
        pq?.dimensionFilters?.forEach((f) => colsToSample.add(f.column));
        pq?.groupBy?.forEach((c) => colsToSample.add(c));
        pq?.valueFilters?.forEach((f) => colsToSample.add(f.column));
        pq?.exclusionFilters?.forEach((f) => colsToSample.add(f.column));
        const diag: string[] = [
          `${rs}`,
          "Diagnostic: 0 result rows with non-empty input — filters may not match literals in the data, or a needed column is missing from the in-memory frame.",
        ];
        const row0 = ctx.exec.data[0];
        for (const col of colsToSample) {
          if (!row0 || !(col in row0)) {
            diag.push(`Column "${col}" is absent from loaded rows — replan with full schema columns or sample_rows.`);
            continue;
          }
          const tops = topDistinctStrings(ctx.exec.data, col, 8000, 18);
          if (tops.length) {
            diag.push(`Distinct sample for "${col}": ${tops.join(", ")}`);
          }
        }
        let workbenchArtifact: AgentWorkbenchEntry | undefined;
        if (pq) {
          const code = JSON.stringify(pq, null, 2);
          workbenchArtifact = {
            id: `pq-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            kind: "query_spec",
            title: "Parsed analytical query",
            code: code.slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX),
            language: "json",
          };
        }
        return {
          ok: false,
          summary: diag.join("\n"),
          analyticalMeta,
          memorySlots: {
            zero_row_diagnostic: "1",
            analytical_snippet: diag.join(" ").slice(0, 800),
          } as Record<string, string>,
          workbenchArtifact,
        };
      }

      if (
        shouldRejectWideWithoutAgg({
          question: q,
          inputRowCount,
          outputRowCount,
          appliedAggregation,
        })
      ) {
        return {
          ok: false,
          summary: `Analytical query returned ${outputRowCount} rows (nearly the full ${inputRowCount} rows) without aggregation. Replan: add an aggregation over the requested metric with an explicit breakdown (e.g. "by <dimension>") using exact column names from the schema.`,
          analyticalMeta,
          memorySlots: {
            analytical_snippet: "wide_result_no_aggregation",
          },
        };
      }

      if (
        questionImpliesSumAggregation(q) &&
        appliedAggregation &&
        res.parsedQuery?.aggregations?.length
      ) {
        const ops = res.parsedQuery.aggregations.map((a) => a.operation);
        const hasSum = ops.some((o) => o === "sum");
        const onlyMeans = ops.every((o) => o === "mean" || o === "avg");
        if (!hasSum && onlyMeans) {
          agentLog("tool_verifier_reject", {
            tool: "run_analytical_query",
            reason: "total_requires_sum_not_mean",
          });
          return {
            ok: false,
            summary: `The question asks for a total/sum but the parsed query only used mean/average. Replan with question_override that explicitly requests SUM (e.g. "sum of [numeric column] by [breakdown column]") using exact column names.`,
            analyticalMeta,
            memorySlots: { analytical_snippet: "total_requires_sum_not_mean" },
          };
        }
      }

      const prev =
        formattedResults.length > 2000
          ? formattedResults.slice(0, 2000) + "…"
          : formattedResults;

      let workbenchArtifact: AgentWorkbenchEntry | undefined;
      if (res.parsedQuery) {
        const code = JSON.stringify(res.parsedQuery, null, 2);
        workbenchArtifact = {
          id: `pq-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          kind: "query_spec",
          title: "Parsed analytical query",
          code: code.slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX),
          language: "json",
        };
      }

      const outCols =
        resultRows.length > 0 ? Object.keys(resultRows[0]!) : [];

      logAnalyticalToolMeta("run_analytical_query", ctx.exec.summary, res.parsedQuery);

      return {
        ok: true,
        summary: `${rs}\n${prev}`,
        numericPayload: formattedResults.slice(0, 8_000),
        analyticalMeta,
        queryPlanParsed: res.parsedQuery ?? null,
        table: {
          rows: resultRows,
          columns: outCols,
          rowCount: outputRowCount,
        },
        memorySlots: {
          analytical_snippet: formattedResults.replace(/\s+/g, " ").slice(0, 800),
        },
        workbenchArtifact,
      };
    },
    {
      description:
        "Run NL analytical query for aggregates, filters, totals (authoritative numbers). Uses full dataset via DuckDB when columnar storage is active.",
      argsHelp:
        '{"question_override"?: string} optional. Never use key "query" — that belongs only on retrieve_semantic_context.',
    }
  );

  registry.register(
    "execute_query_plan",
    executeQueryPlanArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, args) => {
      const plan = (args as z.infer<typeof executeQueryPlanArgsSchema>).plan;
      const promotedPlan = promoteQueryPlanDateAggregationToFacetGroupBy(
        plan,
        ctx.exec.summary
      );
      const dateCols = ctx.exec.summary.dateColumns ?? [];
      if (ctx.exec.data.length > 0 && dateCols.length > 0) {
        migrateLegacyTemporalFacetRowKeys(ctx.exec.data, dateCols);
      }
      const keysFromData = new Set(Object.keys(ctx.exec.data[0] ?? {}));
      const mergedKeys = new Set(keysFromData);
      if (ctx.exec.turnStartDataRef?.[0]) {
        for (const k of Object.keys(ctx.exec.turnStartDataRef[0])) {
          mergedKeys.add(k);
        }
      }
      const effectivePlan = remapQueryPlanGroupByToTemporalFacets(
        promotedPlan,
        ctx.exec.summary,
        mergedKeys,
        ctx.exec.question
      );
      const validated = normalizeAndValidateQueryPlanBody(
        ctx.exec.summary,
        effectivePlan
      );
      if (!validated.ok) {
        return { ok: false, summary: validated.error };
      }
      const { normalizedPlan } = validated;

      let resultRows: Record<string, any>[] = [];
      let descriptions: string[] = [];
      let parsed = queryPlanToParsedQuery(normalizedPlan);
      let inputRowCount = ctx.exec.data.length;

      const memFrame = pickRowLevelDataForQueryPlan(
        normalizedPlan,
        ctx.exec.data,
        ctx.exec.turnStartDataRef
      );

      const tryDuck =
        Boolean(ctx.exec.columnarStoragePath) &&
        Boolean(ctx.exec.sessionId) &&
        canExecuteQueryPlanOnDuckDb(normalizedPlan);

      // DuckDB-first for analytical aggregations. When the plan
      // has aggregations we MUST hit DuckDB (the authoritative analytical
      // surface). The in-memory fallback only fires for:
      //   (a) plans with NO aggregations (projections, sample-style queries)
      //     — these legitimately need the in-memory frame for per-turn
      //     computed columns and row-level chart enrichment.
      //   (b) DuckDB column-binding failures on per-turn computed columns
      //     (add_computed_columns produced a column DuckDB doesn't have).
      //     We keep the safety net there so the agent can still chain
      //     row-wise transforms; for everything else, hard fail.
      const hasAggregations = (normalizedPlan.aggregations ?? []).length > 0;
      const planLooksLikePerTurnComputedColumn = (errMsg: string): boolean => {
        const m = errMsg.toLowerCase();
        return (
          m.includes("binder error") ||
          m.includes("referenced column") ||
          m.includes("does not have a column") ||
          m.includes("not found in")
        );
      };

      if (tryDuck) {
        // PERF-10 · Reuse the per-turn shared DuckDB handle.
        const { storage: sharedStorage } = await getTurnColumnarStorage(ctx.exec);
        const duck = await executeQueryPlanOnDuckDb(
          ctx.exec.sessionId,
          normalizedPlan,
          ctx.exec.summary,
          ctx.exec.chatDocument,
          ctx.exec.abortSignal,
          sharedStorage
        );
        if (duck.ok) {
          resultRows = duck.rows as Record<string, any>[];
          descriptions = duck.descriptions;
          inputRowCount = duck.inputRowCount;
        } else {
          // Surface perDimension (nested aggregation) failures with the
          // resolved perDimension and a sample of tableColumns so production
          // logs make column-not-found cases debuggable.
          const nestedPerDims = (normalizedPlan.aggregations ?? [])
            .map((a) => a.perDimension)
            .filter((p): p is string => typeof p === "string" && p.length > 0);
          if (nestedPerDims.length > 0) {
            agentLog("execute_query_plan_duckdb_fail_nested", {
              sessionId: ctx.exec.sessionId,
              perDimensions: nestedPerDims.join(","),
              error: duck.error.slice(0, 400),
            });
          }
          // Hard-fail on DuckDB execution errors when the plan
          // has aggregations AND the error is NOT a column-binding failure.
          // Column-binding failures usually mean a per-turn computed column
          // isn't materialized in DuckDB yet — that's the only case where
          // we keep the in-memory fallback, because the in-memory frame
          // carries the just-added column.
          const isColumnBindingErr = planLooksLikePerTurnComputedColumn(
            duck.error
          );
          if (hasAggregations && !isColumnBindingErr) {
            agentLog("execute_query_plan_duckdb_hard_fail", {
              sessionId: ctx.exec.sessionId,
              error: duck.error.slice(0, 400),
            });
            return {
              ok: false,
              summary: `DuckDB execution failed for this aggregation: ${duck.error.slice(0, 240)}. The dataset may not be materialized yet — re-open the session or wait a moment, then retry.`,
            };
          }
          agentLog("execute_query_plan_duckdb_fallback", {
            sessionId: ctx.exec.sessionId,
            error: duck.error.slice(0, 400),
            reason: isColumnBindingErr
              ? "per_turn_computed_column"
              : "no_aggregation",
          });
          const mem = executeQueryPlan(
            memFrame,
            ctx.exec.summary,
            normalizedPlan
          );
          if (!mem.ok) {
            return { ok: false, summary: mem.error };
          }
          resultRows = mem.data;
          descriptions = mem.descriptions;
          parsed = mem.parsed;
          inputRowCount = memFrame.length;
        }
      } else {
        // No DuckDB materialization available. For aggregations,
        // this is a hard fail — we never silently grind through Cosmos-loaded
        // rows for what should be a DuckDB query. For non-aggregation plans
        // (projections, row lists, sample fetches), the in-memory path is
        // legitimate.
        if (hasAggregations) {
          agentLog("execute_query_plan_no_duckdb_hard_fail", {
            sessionId: ctx.exec.sessionId,
            columnarStoragePath: ctx.exec.columnarStoragePath ?? "(missing)",
          });
          return {
            ok: false,
            summary:
              "DuckDB execution surface is not available for this session yet. Re-open the session or wait a moment for materialization, then retry.",
          };
        }
        const mem = executeQueryPlan(
          memFrame,
          ctx.exec.summary,
          normalizedPlan
        );
        if (!mem.ok) {
          return { ok: false, summary: mem.error };
        }
        resultRows = mem.data;
        descriptions = mem.descriptions;
        parsed = mem.parsed;
        inputRowCount = memFrame.length;
      }
      const outputRowCount = resultRows.length;
      const appliedAggregation = appliedAggregationFromParsed(parsed);
      const analyticalMeta = {
        inputRowCount,
        outputRowCount,
        appliedAggregation,
      };

      if (
        shouldRejectWideWithoutAgg({
          question: ctx.exec.question,
          inputRowCount,
          outputRowCount,
          appliedAggregation,
        })
      ) {
        return {
          ok: false,
          summary: `execute_query_plan returned ${outputRowCount} rows (nearly full ${inputRowCount}) without aggregation. Replan: add groupBy + aggregations with an explicit breakdown (e.g. "by <dimension>") using exact column names from the schema.`,
          analyticalMeta,
          memorySlots: { analytical_snippet: "query_plan_wide_no_agg" },
        };
      }

      if (
        questionImpliesSumAggregation(ctx.exec.question) &&
        appliedAggregation &&
        parsed.aggregations?.length
      ) {
        const ops = parsed.aggregations.map((a) => a.operation);
        const hasSum = ops.some((o) => o === "sum");
        const onlyMeans = ops.every((o) => o === "mean" || o === "avg");
        if (!hasSum && onlyMeans) {
          agentLog("tool_verifier_reject", {
            tool: "execute_query_plan",
            reason: "plan_total_requires_sum",
          });
          return {
            ok: false,
            summary:
              "Question implies total/sum but plan only uses mean/average. Replan execute_query_plan with operation sum for the revenue/metric column.",
            analyticalMeta,
            memorySlots: { analytical_snippet: "plan_total_requires_sum" },
          };
        }
      }

      const coarseValidation = validateCoarseDateAggregationOutput(
        parsed,
        inputRowCount,
        outputRowCount
      );
      if (coarseValidation) {
        agentLog("tool_verifier_reject", {
          tool: "execute_query_plan",
          reason: "coarse_period_too_many_groups",
          outputRowCount,
        });
        return {
          ok: false,
          summary: coarseValidation,
          analyticalMeta,
          queryPlanParsed: parsed,
          memorySlots: { analytical_snippet: "coarse_period_row_count_mismatch" },
        };
      }

      const cols =
        resultRows.length > 0 ? Object.keys(resultRows[0]!) : [];
      // Slim the narrator observation snippet — 200 rows of JSON often
      // brushed the 40k observation cap and truncated unrelated tool output
      // from the same turn. The full result still rides on `table.rows` below
      // and powers downstream pivot/leaderboard surfacing.
      // W2 · but a SMALL aggregated result (e.g. a 24-row ASM ranking) must be
      // shown IN FULL so the narrator can state the complete ranking instead of
      // hedging "only partially shown in the snippet"; only large results get
      // the 30-row cap.
      const OBSERVATION_TOP_K = resultRows.length <= 50 ? resultRows.length : 30;
      const SAMPLE_CHAR_CAP = resultRows.length <= 50 ? 8_000 : 3_500;
      const formattedResults = JSON.stringify(
        resultRows.slice(0, OBSERVATION_TOP_K),
        null,
        2
      );
      const showingNote =
        resultRows.length > OBSERVATION_TOP_K
          ? ` (showing first ${OBSERVATION_TOP_K} of ${resultRows.length} rows in this snippet; full table available downstream)`
          : "";
      const rs = descriptions.length
        ? descriptions.join("; ")
        : "Query plan executed.";
      const workbenchArtifact: AgentWorkbenchEntry = {
        id: `qp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        kind: "query_spec",
        title: "execute_query_plan",
        code: JSON.stringify(plan, null, 2).slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX),
        language: "json",
      };

      logAnalyticalToolMeta("execute_query_plan", ctx.exec.summary, parsed);

      return {
        ok: true,
        summary: `${rs}\nRows: ${outputRowCount}. Columns: ${cols.join(", ")}${showingNote}\nSample:\n${formattedResults.length > SAMPLE_CHAR_CAP ? formattedResults.slice(0, SAMPLE_CHAR_CAP) + "…" : formattedResults}`,
        numericPayload: formattedResults.slice(0, 8_000),
        analyticalMeta,
        queryPlanParsed: parsed,
        table: { rows: resultRows, columns: cols, rowCount: outputRowCount },
        memorySlots: {
          analytical_snippet: formattedResults.replace(/\s+/g, " ").slice(0, 800),
        },
        workbenchArtifact,
      };
    },
    {
      description:
        "Structured query plan: time series (trend) OR dimension breakdowns. For explicit time grain questions (year/month/quarter/etc.), groupBy the matching derived time-bucket column (same label as in schema, e.g. Month · Order Date). When groupBy is already such a bucket column, OMIT dateAggregationPeriod (pre-bucketed). Legacy __tf_month__* ids are normalized automatically. Use dateAggregationPeriod only when groupBy is a raw date column that needs calendar truncation. For vague 'over time' without an explicit grain, you can omit groupBy/aggregations and instead sort by a date column (and use limit) to return an ordered time series without forcing yearly sums. For breakdowns: groupBy dimension(s) + aggregations. Exact schema column names required.",
      argsHelp:
        'Facet time-series: {"plan":{"groupBy":["Month · Order Date"],"aggregations":[{"column":"Sales","operation":"sum"}],"sort":[{"column":"Month · Order Date","direction":"asc"}]}}. Raw date: {"plan":{"groupBy":["Order Date"],"dateAggregationPeriod":"month","aggregations":[{"column":"Sales","operation":"sum"}]}}. Full shape: {"plan": {"groupBy"?: string[], "dateAggregationPeriod"?: "day"|"week"|"half_year"|"month"|"monthOnly"|"quarter"|"year"|null, "aggregations"?: [{"column": string, "operation": "sum"|"mean"|"avg"|"count"|"min"|"max"|"median"|"percent_change", "alias"?: string}], "dimensionFilters"?: [...], "limit"?: number, "sort"?: [...]}}',
    }
  );

  registry.register(
    "derive_dimension_bucket",
    deriveDimensionBucketArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, args) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "derive_dimension_bucket is only available in analysis mode.",
        };
      }
      const parsed = deriveDimensionBucketArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for derive_dimension_bucket: ${parsed.error.message}`,
        };
      }
      const allow = allowlistedColumns(ctx);
      if (!allow.has(parsed.data.sourceColumn)) {
        return {
          ok: false,
          summary: `Column not in schema: ${parsed.data.sourceColumn}`,
        };
      }
      const out = applyDeriveDimensionBucket(ctx.exec.data, ctx.exec.summary, parsed.data);
      if (!out.ok) {
        return { ok: false, summary: out.error };
      }
      const cols = out.rows.length > 0 ? Object.keys(out.rows[0]!) : [];
      const sample = JSON.stringify(out.rows.slice(0, 15), null, 2);
      return {
        ok: true,
        summary: `derive_dimension_bucket: added "${parsed.data.newColumnName}" from "${parsed.data.sourceColumn}". Rows: ${out.rows.length}. Columns: ${cols.join(", ")}\nSample:\n${sample.slice(0, 3500)}`,
        table: {
          rows: out.rows,
          columns: cols,
          rowCount: out.rows.length,
        },
        memorySlots: {
          derived_column: parsed.data.newColumnName,
        },
      };
    },
    {
      description:
        "Add a string bucket column by mapping source dimension values into labels (custom groups). Use before execute_query_plan when the user merges categories/regions. Chain with dependsOn if needed.",
      argsHelp:
        '{"sourceColumn": string, "newColumnName": string, "buckets": [{"label": string, "values": string[]}], "matchMode"?: "exact"|"case_insensitive", "defaultLabel"?: string}',
    }
  );

  registry.register(
    "add_computed_columns",
    addComputedColumnsArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, args) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "add_computed_columns is only available in analysis mode.",
        };
      }
      const parsed = addComputedColumnsArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for add_computed_columns: ${parsed.error.message}`,
        };
      }

      const useColumnarDuckdb =
        Boolean(ctx.exec.columnarStoragePath) && isDuckDBAvailable();

      let rows: Record<string, any>[];
      let nonNullCounts: { name: string; nonNull: number; total: number }[];
      if (useColumnarDuckdb) {
        let base: Record<string, any>[];
        try {
          base = ctx.exec.loadFullData
            ? await ctx.exec.loadFullData()
            : ctx.exec.data;
        } catch (e) {
          const msg = errorMessage(e);
          return {
            ok: false,
            summary: `add_computed_columns: loadFullData failed (${msg.slice(0, 300)}).`,
          };
        }
        if (!base?.length) {
          return {
            ok: false,
            summary: "add_computed_columns: no rows loaded for columnar session.",
          };
        }
        const fullOut = applyAddComputedColumns(
          base,
          ctx.exec.summary,
          parsed.data
        );
        if (!fullOut.ok) {
          return { ok: false, summary: fullOut.error };
        }
        rows = fullOut.rows;
        nonNullCounts = fullOut.nonNull;
      } else {
        const out = applyAddComputedColumns(
          ctx.exec.data,
          ctx.exec.summary,
          parsed.data
        );
        if (!out.ok) {
          return { ok: false, summary: out.error };
        }
        rows = out.rows;
        nonNullCounts = out.nonNull;
      }

      let persistNote = "";
      let duckdbNote = "";
      if (parsed.data.persistToSession) {
        try {
          await saveModifiedData(
            ctx.exec.sessionId,
            rows,
            "add_computed_columns",
            (parsed.data.persistDescription?.trim() ||
              "Computed columns added from analysis agent") as string
          );
          queryCache.invalidateSession(ctx.exec.sessionId);
          const fresh = createDataSummary(rows);
          replaceSummaryFromFresh(ctx.exec.summary, fresh);
          persistNote = " Persisted to session dataset (new blob version).";
        } catch (e) {
          const msg = errorMessage(e);
          return {
            ok: false,
            summary: `Computed columns were built but persist failed: ${msg.slice(0, 400)}`,
          };
        }
      }

      if (useColumnarDuckdb) {
        const storage = new ColumnarStorageService({
          sessionId: ctx.exec.sessionId,
        });
        try {
          await storage.initialize();
          await storage.materializeAuthoritativeDataTable(rows, {
            tableName: "data",
          });
        } catch (e) {
          const msg = errorMessage(e);
          return {
            ok: false,
            summary: `Computed columns built but DuckDB rematerialize failed: ${msg.slice(0, 400)}`,
          };
        } finally {
          await storage.close().catch(() => {
            /* ignore */
          });
        }
        metadataService.invalidateCache(ctx.exec.sessionId);
        queryCache.invalidateSession(ctx.exec.sessionId);
        ctx.exec.data = rows;
        duckdbNote = " Session DuckDB table `data` updated for pivot/sample queries.";
      }
      const cols = rows.length > 0 ? Object.keys(rows[0]!) : [];
      const sample = JSON.stringify(rows.slice(0, 15), null, 2);
      const names = parsed.data.columns.map((c) => c.name).join(", ");
      const coverage = nonNullCounts
        .map((c) => `${c.name}: ${c.nonNull}/${c.total}`)
        .join(", ");

      // Record the computed-column recipe (regardless of persistToSession) so
      // that on resume-after-days the planner can see what derived metrics were
      // useful in past turns and reference them by name. Skip silently when
      // username is missing so the producer doesn't fail schema validation (the
      // entry can be backfilled later).
      const memoryUsername = ctx.exec.username?.trim();
      if (memoryUsername) {
        void (async () => {
          try {
            const { buildComputedColumnEntry, scheduleLifecycleMemory } =
              await import("../memoryLifecycleBuilders.js");
            scheduleLifecycleMemory(
              buildComputedColumnEntry({
                sessionId: ctx.exec.sessionId,
                username: memoryUsername,
                columns: parsed.data.columns,
                persistedToBlob: Boolean(parsed.data.persistToSession),
                description: parsed.data.persistDescription,
                createdAt: Date.now(),
                turnId: ctx.turnId,
              })
            );
          } catch (e) {
            logger.warn(
              "⚠️ analysisMemory computed_column_added hook failed:",
              e
            );
          }
        })();
      }

      return {
        ok: true,
        summary: `add_computed_columns: added ${names}. Rows: ${rows.length}. Non-null: ${coverage}. Columns: ${cols.join(", ")}${persistNote}${duckdbNote}\nSample:\n${sample.slice(0, 3500)}`,
        table: {
          rows,
          columns: cols,
          rowCount: rows.length,
        },
        memorySlots: {
          computed_columns: names.slice(0, 200),
          ...(parsed.data.persistToSession ? { persisted: "1" } : {}),
        },
      };
    },
    {
      description:
        "Add row-wise numeric columns from safe definitions (date difference in whole days between two date columns; or numeric add/subtract/multiply/divide). Use before execute_query_plan when you need a derived metric. Same row count as input. Optional persistToSession saves the enriched frame as the session dataset (use only when the user asked to keep/save the new column).",
      argsHelp:
        '{"columns": [{"name": string, "def": {"type":"date_diff_days","startColumn": string, "endColumn": string, "clampNegative"?: boolean} | {"type":"numeric_binary","op":"add"|"subtract"|"multiply"|"divide","leftColumn": string, "rightColumn": string}}], "persistToSession"?: boolean, "persistDescription"?: string}',
    }
  );

  registry.register(
    "run_readonly_sql",
    readonlySqlArgs,
    async (ctx, args) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_readonly_sql is only available in analysis mode.",
        };
      }
      const sql = (args as z.infer<typeof readonlySqlArgs>).sql;
      const pre = sanitizeReadonlyDatasetSql(sql);
      if (!pre.ok) {
        return { ok: false, summary: pre.error };
      }

      // When a columnar session is available, run the SQL directly against the
      // full persistent DuckDB session table (same source as the pivot) so that
      // all rows are scanned — not just the 5 000-row in-memory sample.
      if (
        ctx.exec.columnarStoragePath &&
        ctx.exec.sessionId &&
        isDuckDBAvailable()
      ) {
        const sessionSql = pre.sql.replace(/\bdataset\b/gi, '"data"');
        // PERF-10 · Reuse the per-turn shared DuckDB handle instead of opening
        // and closing our own; the turn owner closes it at turn end.
        const { storage } = await getTurnColumnarStorage(ctx.exec);
        try {
          await storage.assertTableExists("data");
          const rows = await storage.executeQuery<Record<string, any>>(sessionSql);
          const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
          const formatted = JSON.stringify(rows.slice(0, 100), null, 2);
          return {
            ok: true,
            summary: `run_readonly_sql (full dataset, ${rows.length} rows): columns: ${columns.join(", ")}. Sample:\n${formatted.slice(0, 4000)}`,
            table: { rows, columns, rowCount: rows.length },
            memorySlots: { readonly_sql: "full_dataset" },
          };
        } catch (e) {
          // Fall through to in-memory path on any DuckDB error.
        }
      }

      const exec = await executeReadonlySqlOnFrame(ctx.exec.data, sql);
      if (!exec.ok) {
        return { ok: false, summary: exec.error };
      }
      const formatted = JSON.stringify(exec.rows.slice(0, 100), null, 2);
      return {
        ok: true,
        summary: `run_readonly_sql: ${exec.rows.length} rows, columns: ${exec.columns.join(", ")}. Sample:\n${formatted.slice(0, 4000)}`,
        table: {
          rows: exec.rows,
          columns: exec.columns,
          rowCount: exec.rows.length,
        },
        memorySlots: { readonly_sql: "1" },
      };
    },
    {
      description:
        "Advanced: single SELECT only against table \"dataset\" (full session data when columnar storage is active, otherwise current frame). No DDL/DML. Prefer execute_query_plan when possible.",
      argsHelp: '{"sql": string} — e.g. SELECT bucket, SUM(CAST("Sales" AS DOUBLE)) FROM dataset GROUP BY 1',
    }
  );

  registry.register(
    "run_correlation",
    correlationArgs,
    async (ctx, args) => {
      const requestedTarget = (args.targetVariable as string) ?? "";
      // Forgive case/spacing/underscore/dash differences before strict
      // assertion. Same `findMatchingColumn` already used by chart builders,
      // chart downsampling, dataTransform, pivot preview, segment driver — no
      // new abstraction. Resolves "sales" → "Total Sales", "Sales (USD)", etc.
      const allowedSet = [...allowedColumnNames(ctx)];
      const matched = findMatchingColumn(requestedTarget, allowedSet);
      const targetVariable = matched ?? requestedTarget;
      let resolutionNote = "";
      if (matched && matched !== requestedTarget) {
        resolutionNote = ` (target resolved: "${requestedTarget}" → "${matched}")`;
      }
      const err = assertColumns(ctx, [targetVariable]);
      if (err) return { ok: false, summary: err };
      const numeric = ctx.exec.summary.numericColumns;
      if (!numeric.includes(targetVariable)) {
        return {
          ok: false,
          summary: `Target ${targetVariable} is not a numeric column.`,
        };
      }

      // Derive categorical columns: low-to-medium cardinality string columns not already in numericColumns/dateColumns
      const dateColSet = new Set(ctx.exec.summary.dateColumns ?? []);
      const numericSet = new Set(numeric);
      const allColNames = ctx.exec.data.length > 0 ? Object.keys(ctx.exec.data[0]!) : [];
      const MAX_CAT_CARDINALITY = 100;
      const sampleForCardinality = ctx.exec.data.slice(0, 2000);
      const categoricalCols = allColNames.filter(col => {
        if (numericSet.has(col)) return false;
        if (dateColSet.has(col)) return false;
        if (col.startsWith('__')) return false;
        const uniq = new Set(sampleForCardinality.map(r => r[col])).size;
        return uniq >= 2 && uniq <= MAX_CAT_CARDINALITY;
      });

      const rawFilters = (args as { dimensionFilters?: DimensionFilter[] }).dimensionFilters;
      let frame = ctx.exec.data;
      let filterNote = "";
      if (rawFilters?.length) {
        const base =
          ctx.exec.turnStartDataRef && ctx.exec.turnStartDataRef.length > 0
            ? ctx.exec.turnStartDataRef
            : ctx.exec.data;
        const cap = diagnosticSliceRowCap();
        const capped = base.length > cap ? base.slice(0, cap) : base;
        frame = filterRowsByDimensionFilters(capped, rawFilters) as Record<string, any>[];
        filterNote = ` (slice: ${rawFilters.length} dimension filter(s), n=${frame.length}${base.length > cap ? `, frame capped at ${cap}` : ""})`;
        if (!frame.length) {
          return {
            ok: false,
            summary: "dimensionFilters matched zero rows for correlation.",
          };
        }
      }

      // Frame-fit guard. `frame` is whatever the previous tool left in
      // ctx.exec.data — if a `run_aggregation` / `execute_query_plan` ran
      // first, the rows are aggregated (`{bucket, Sales_sum}`) and the schema
      // numeric list (`Sales`, `Price`, …) doesn't match the row keys.
      // `assertColumns` passed because allowedColumnNames unions schema + frame
      // keys, but `row[targetVariable]` would still be `undefined` and every
      // correlation would return NaN/empty. Auto-recover to row-level data.
      const frameKeys = new Set(Object.keys(frame[0] ?? {}));
      const targetOnFrame = frameKeys.has(targetVariable);
      const numericOnFrame = numeric.filter((c) => frameKeys.has(c));
      let frameNumeric = numericOnFrame;
      let frameCategorical = categoricalCols.filter((c) => frameKeys.has(c));
      if (!targetOnFrame || numericOnFrame.length <= 1) {
        const rowLevel = ctx.exec.turnStartDataRef ?? [];
        const rowLevelKeys = new Set(Object.keys(rowLevel[0] ?? {}));
        if (rowLevel.length && rowLevelKeys.has(targetVariable)) {
          frame = rowLevel as Record<string, any>[];
          frameNumeric = numeric.filter((c) => rowLevelKeys.has(c));
          frameCategorical = categoricalCols.filter((c) => rowLevelKeys.has(c));
          filterNote += ` (auto-recovered to row-level frame, n=${frame.length}; original frame missing target or had ${numericOnFrame.length} numeric col(s))`;
        } else if (!targetOnFrame) {
          return {
            ok: false,
            summary: `Frame does not contain "${targetVariable}". Current frame keys: ${[...frameKeys].slice(0, 8).join(", ")}${frameKeys.size > 8 ? "…" : ""}. Numeric in frame: ${numericOnFrame.join(", ") || "(none)"}. No row-level fallback available — re-run upstream tool to materialize raw rows.`,
          };
        }
        // If targetOnFrame but numericOnFrame.length <= 1 and no row-level
        // fallback, fall through with what we have — analyzeCorrelations will
        // surface a `no_numeric_pairs` diagnostic if it produces nothing.
      }

      const { charts, insights, diagnostic, topCorrelations } = await analyzeCorrelations(
        frame,
        targetVariable,
        frameNumeric,
        (args.filter as "all" | "positive" | "negative" | undefined) ?? "all",
        undefined,
        ctx.exec.chatInsights,
        25,
        undefined,
        ctx.exec.sessionId,
        true,
        frameCategorical,
        // Pipe domain context + user/session signals through so the agent-path
        // correlation charts can render `businessCommentary`, matching the
        // chatStream path.
        {
          userQuestion: ctx.exec.question,
          sessionAnalysisContext: ctx.exec.sessionAnalysisContext,
          permanentContext: ctx.exec.permanentContext,
          domainContext: ctx.exec.domainContext,
        }
      );
      const noteSuffix = `${resolutionNote}${filterNote}`;

      // Append a canonical FindingEvidence suffix on the summary so the
      // downstream blackboard `addFinding` (agentLoop.service.ts) gets a
      // detail string the evidence extractor catches deterministically and the
      // confidence grader can grade on real evidence (R², n) instead of
      // defaulting to "medium / no evidence supplied". Strongest correlation by
      // |r|; R² = r². Also emit the categorical effect-size via Cohen's |r|
      // conventions so the grader can distinguish "r = 0.05 on n = 10000" (real
      // and trivial) from "r = 0.7 on n = 80" (real and large).
      let wv4EvidenceSuffix = "";
      if (topCorrelations && topCorrelations.length > 0) {
        const strongest = topCorrelations[0]!;
        const rSquared = strongest.correlation * strongest.correlation;
        const evidence: FindingEvidence = {};
        if (Number.isFinite(rSquared) && rSquared >= 0 && rSquared <= 1) {
          evidence.rSquared = rSquared;
        }
        if (typeof strongest.nPairs === "number" && strongest.nPairs >= 0) {
          evidence.n = strongest.nPairs;
        }
        const bucket = bucketCorrelationR(strongest.correlation);
        if (bucket) {
          evidence.effectMagnitude = bucket;
        }
        // composeFindingDetail("", ev) returns just the evidence suffix
        // (leading space + parenthesised block) — safe to concatenate.
        wv4EvidenceSuffix = composeFindingDetail("", evidence);
      }
      // Return ok:false when the analyzer produced nothing useful. The
      // reflector already retries on ok:false (see dimensionFilters zero-rows
      // path above) — keep correlation consistent so the planner gets a signal
      // to try a different target, drop filters, or move on instead of treating
      // empty as success.
      if (charts.length === 0 && insights.length === 0) {
        const reason = diagnostic?.reason ?? "unknown";
        const stats = diagnostic
          ? `frame=${diagnostic.frameRows} rows, target non-NaN sample=${diagnostic.targetSampleNonNan}/100, numeric tried=${diagnostic.numericTried} kept=${diagnostic.numericKept}, categorical tried=${diagnostic.categoricalTried} kept=${diagnostic.categoricalKept}`
          : "no diagnostic available";
        const notes = diagnostic?.notes ? ` ${diagnostic.notes}` : "";
        return {
          ok: false,
          summary: `Correlation analysis produced no results. Reason: ${reason}. ${stats}.${notes}${noteSuffix}`,
        };
      }
      return {
        ok: true,
        summary: `Correlation analysis: ${charts.length} chart(s), ${insights.length} insight(s).${noteSuffix}${wv4EvidenceSuffix}`,
        charts,
        insights,
      };
    },
    {
      description:
        "Correlation / drivers for a numeric target column. Automatically includes categorical variables via correlation ratio η (measures how much variance in the target each category explains). Optional dimensionFilters apply to **row-level turn-start data** (not aggregated frames). Auto-recovers row-level data when the current frame is aggregated (e.g. after run_aggregation). Returns ok:false with a `reason` (no_target_values | no_numeric_pairs | no_categorical_signal | filter_eliminated_all | insights_llm_failed | chart_generation_failed) when no charts/insights can be produced.",
      argsHelp:
        '{"targetVariable": string, "filter"?: "all"|"positive"|"negative", "dimensionFilters"?: [{"column": string, "op": "in"|"not_in", "values": string[], "match"?: "exact"|"case_insensitive"|"contains"}]}',
    }
  );

  if (isDiagnosticCompositeToolEnabled()) {
    registry.register(
      "run_segment_driver_analysis",
      segmentDriverArgsSchema,
      async (ctx, args) => {
        const parsed = segmentDriverArgsSchema.safeParse(args);
        if (!parsed.success) {
          return { ok: false, summary: `Invalid args: ${parsed.error.message}` };
        }
        if (ctx.exec.mode !== "analysis") {
          return { ok: false, summary: "run_segment_driver_analysis is only for analysis mode." };
        }
        return runSegmentDriverAnalysisTool(ctx.exec, parsed.data);
      },
      {
        description:
          "One-shot diagnostic: slice by dimensionFilters on row-level data, benchmark vs global, parallel breakdowns, correlation on slice. Prefer when the user asks for drivers/factors in a segment.",
        argsHelp:
          '{"outcomeColumn": string, "dimensionFilters": [{"column": string, "op": "in"|"not_in", "values": string[]}], "breakdownColumns"?: string[]}',
      }
    );
  }

  registry.register(
    "build_chart",
    chartArgs,
    async (ctx, args) => {
      const a = args as z.infer<typeof chartArgs>;

      // T4 · explicit grain → bucket the date x-axis at the requested grain.
      // Prefer the precomputed facet column (e.g. "Week · Date"); if absent,
      // keep the raw date x and pass a bucketing hint to processChartData.
      let xCol = a.x;
      let grainHint: DatePeriod | null = null;
      if (a.grain && a.grain !== "auto") {
        const facetGrain: TemporalFacetGrain =
          a.grain === "day" ? "date" : (a.grain as TemporalFacetGrain);
        const parsedX = parseTemporalFacetDisplayKey(a.x);
        const sourceDate =
          parsedX?.sourceColumn ??
          ((ctx.exec.summary?.dateColumns ?? []).includes(a.x) ? a.x : undefined);
        if (sourceDate) {
          const facetKey = facetColumnKey(sourceDate, facetGrain);
          const frameKeys =
            Array.isArray(ctx.exec.data) && ctx.exec.data[0]
              ? new Set(Object.keys(ctx.exec.data[0] as Record<string, unknown>))
              : new Set<string>();
          if (frameKeys.has(facetKey)) {
            xCol = facetKey; // precomputed bucket column — no re-bucketing needed
          } else {
            xCol = sourceDate; // bucket the raw date on the fly
            grainHint = a.grain as DatePeriod;
          }
        }
      }

      // Temporal x-axis ⇒ line, never bar — via the single chart-type authority,
      // applied at CONSTRUCTION. This is in-policy argument normalization (like
      // the grain remap above), not a flow override: it closes the gap where the
      // verifier flags BAR_ON_TEMPORAL_X but, per the single-flow policy
      // (invariant #6), never rewrites the chart.
      let chartType: typeof a.type = a.type;
      let coercedTemporalBar = false;
      if (
        a.type === "bar" &&
        isTemporalChartX(xCol, { dateColumns: ctx.exec.summary?.dateColumns ?? [] })
      ) {
        chartType = "line";
        coercedTemporalBar = true;
      }

      const names = [
        xCol,
        a.y,
        ...(a.y2 ? [a.y2] : []),
        ...(a.type === "heatmap" && a.z ? [a.z] : []),
        ...(a.seriesColumn ? [a.seriesColumn] : []),
      ];
      const colErr = assertChartColumns(ctx, names);
      if (colErr) return { ok: false, summary: colErr };
      const explicitAgg =
        a.aggregate !== undefined && a.aggregate !== null;
      const compileProposal = {
        type: chartType,
        x: xCol,
        y: a.y,
        ...(a.type === "heatmap" && a.z ? { z: a.z } : {}),
        seriesColumn: a.seriesColumn,
        barLayout: a.barLayout,
        ...(a.aggregate !== undefined && a.aggregate !== null
          ? { aggregate: a.aggregate }
          : {}),
        ...(a.y2 ? { y2: a.y2 } : {}),
      };
      const { merged: compiled } = compileChartSpec(
        ctx.exec.data as Record<string, unknown>[],
        {
          numericColumns: ctx.exec.summary?.numericColumns ?? [],
          dateColumns: ctx.exec.summary?.dateColumns,
        },
        compileProposal,
        {
          preserveAggregate: explicitAgg,
          columnOrder: Array.isArray(ctx.exec.lastAnalyticalTable?.columns)
            ? (ctx.exec.lastAnalyticalTable!.columns as string[])
            : null,
        }
      );
      const postNames = [
        compiled.x,
        compiled.y,
        ...(compiled.type === "heatmap" && compiled.z ? [compiled.z] : []),
        ...(compiled.seriesColumn ? [compiled.seriesColumn] : []),
        ...(a.y2 ? [a.y2] : []),
      ];
      const colErr2 = assertChartColumns(ctx, postNames);
      if (colErr2) return { ok: false, summary: colErr2 };

      const defaultAgg =
        explicitAgg
          ? (a.aggregate as "sum" | "mean" | "count" | "none")
          : compiled.seriesColumn &&
              (compiled.type === "bar" ||
                compiled.type === "line" ||
                compiled.type === "area")
            ? compiled.aggregate ?? "sum"
            : compiled.aggregate ??
              (compiled.type === "heatmap"
                ? "sum"
                : "none");
      const spec = chartSpecSchema.parse({
        type: compiled.type,
        title: a.title || `${compiled.y} by ${compiled.x}`,
        x: compiled.x,
        y: compiled.y,
        ...(compiled.type === "heatmap" && compiled.z ? { z: compiled.z } : {}),
        ...(compiled.seriesColumn ? { seriesColumn: compiled.seriesColumn } : {}),
        ...(compiled.seriesColumn && compiled.barLayout
          ? { barLayout: compiled.barLayout }
          : {}),
        ...(a.y2 ? { y2: a.y2 } : {}),
        aggregate: defaultAgg,
      });
      const processed = processChartData(
        ctx.exec.data,
        spec,
        ctx.exec.summary?.dateColumns,
        { chartQuestion: ctx.exec.question, grain: grainHint }
      );
      const useAnalyticalOnly =
        Boolean(ctx.exec.lastAnalyticalTable?.rows?.length) &&
        ctx.exec.data === ctx.exec.lastAnalyticalTable!.rows;
      const full = {
        ...spec,
        data: processed,
        ...(useAnalyticalOnly ? { _useAnalyticalDataOnly: true as const } : {}),
      };
      const layerNote = spec.seriesColumn
        ? `, series=${spec.seriesColumn}${spec.barLayout ? ` (${spec.barLayout})` : ""}`
        : "";
      const zNote = spec.type === "heatmap" && spec.z ? `, z=${spec.z}` : "";
      const coercionNote = coercedTemporalBar
        ? ` (coerced bar→line: x='${spec.x}' is a temporal axis)`
        : "";
      return {
        ok: true,
        summary: `Chart ${spec.type}: ${spec.title} (x=${spec.x}, y=${spec.y}${a.y2 ? `, y2=${a.y2}` : ""}${zNote}${layerNote}, aggregate=${spec.aggregate ?? defaultAgg}), ${processed.length} points.${coercionNote}`,
        charts: [full],
        memorySlots: { chart_x: spec.x, chart_y: spec.y },
      };
    },
    {
      description:
        "Build a chart from in-memory rows (often after run_analytical_query or execute_query_plan). After sum/mean aggregations, y must match the result column (e.g. Sales_sum), not the raw schema name Sales. x is the groupBy date column (bucket labels). Use aggregate none when one row per x already. For breakdowns (e.g. sales by month AND region), use bar or line/area with seriesColumn = the second dimension column (long-format rows: one row per x×series with y numeric); default aggregate sum then applies per series cell. For two numeric metrics over the same x (e.g. Revenue and Profit over time), use y2 instead of seriesColumn. Heatmap: type heatmap, x=row dim, y=col dim, z=numeric measure. CRITICAL RULES: (1) ALWAYS use type 'line' or 'area' when x is a date, month, quarter, or year column — NEVER use 'bar' for temporal trends. (2) Use seriesColumn only when the column has ≤15 distinct values; if higher cardinality, either set max_series (3–20) to auto-merge excess into 'Others', or use a single-series bar sorted by y instead. (3) For geographic/state/country breakdowns with many values, prefer a single-series bar chart sorted by y rather than multi-series. (4) GRAIN: for a date/time x-axis, set `grain` to day|week|month|quarter|half_year|year to control the time bucket (e.g. a follow-up 'by week'). The chart uses the matching `<Grain> · <Date>` facet column if present, otherwise buckets the raw date at that grain. Omit / 'auto' lets the resolver pick a span-appropriate grain.",
      argsHelp:
        '{"type": "line"|"bar"|"scatter"|"pie"|"area"|"heatmap", "x": string, "y": string, "z"?: string (heatmap cell value), "seriesColumn"?: string (second category for stacked/grouped bar or multi-series line/area), "barLayout"?: "stacked"|"grouped", "y2"?: string (second numeric series, dual-axis line), "title"?: string, "aggregate"?: "sum"|"mean"|"count"|"none", "max_series"?: number (3–20, cap series count and merge remainder into Others), "grain"?: "day"|"week"|"month"|"quarter"|"half_year"|"year"|"auto" (time bucket for a date x-axis)} — after execute_query_plan, y must match result column names (e.g. Sales_sum). With seriesColumn, omit aggregate or use sum/mean to roll up raw rows per x×series. When seriesColumn cardinality >15, set max_series to 10.',
    }
  );

  registry.register(
    "clarify_user",
    clarifyArgs,
    async (_ctx, args) => {
      return {
        ok: true,
        summary: "Clarification requested.",
        clarify: args.message as string,
      };
    },
    {
      description: "Ask the user a clarifying question.",
      argsHelp: '{"message": string}',
    }
  );

  registry.register(
    "run_data_ops",
    runDataOpsArgs,
    async (ctx) => {
      if (ctx.exec.mode !== "dataOps") {
        return {
          ok: false,
          summary: "run_data_ops only available in dataOps mode.",
        };
      }
      const { runDataOpsFromAgentContext } = await import("../../runDataOpsFromAgent.js");
      const out = await runDataOpsFromAgentContext(ctx.exec);
      return {
        ok: true,
        summary: out.answer?.slice(0, 1500) || "",
        answerFragment: out.answer,
        charts: out.charts,
        insights: out.insights,
        table: out.table,
        operationResult: out.operationResult,
        numericPayload: out.answer?.slice(0, 2000),
      };
    },
    {
      description:
        "Perform a data transformation (mutations) via the data-ops pipeline — not the legacy orchestrator.",
      argsHelp: '{"reason"?: string} optional note only.',
    }
  );

  // --- Delegated registrars: each registers ONE tool defined in its own ---
  // --- runtime/tools/<name>Tool.ts file. Same `registry.register` effect. ---
  registerBreakdownRankingTool(registry);
  registerTwoSegmentCompareTool(registry);
  registerPatchDashboardTool(registry);
  // web_search is registered unconditionally so the planner can see it and
  // learn the no-op message when WEB_SEARCH_ENABLED is false. Real execution is
  // gated inside the tool itself.
  registerWebSearchTool(registry);
  // Marketing-mix budget reallocator. Trips on questions like "how should I
  // redistribute my budget" — see budget_reallocation question shape in
  // analysisBrief.ts.
  registerBudgetOptimizerTool(registry);
  // Period-over-period growth (YoY/QoQ/MoM/WoW). Use for trend / "fastest
  // growing market" / "biggest decliner" questions.
  registerComputeGrowthTool(registry);
  // Within-year recurring seasonality (month-of-year / quarter-of-year).
  // Use for trend questions on multi-year monthly/quarterly data.
  registerDetectSeasonalityTool(registry);
  // Time-series forecasting (linear trend + optional seasonal).
  // Gated by FORECAST_ENABLED=true; surfaces a clear off-message otherwise.
  registerForecastTool(registry);
  // Hierarchical drill — top-N + "Other" rollup for unreadable
  // high-cardinality breakdowns (50+ regions, 200+ SKUs). Pure-Node.
  registerHierarchicalDrillTool(registry);
  // Cohort retention/expansion table. Pure-Node; tracks entities across period
  // offsets to answer "of cohort X, how many remain in period Y?".
  registerCohortAnalysisTool(registry);
  // RFM segmentation. Pure-Node; scores entities on Recency / Frequency /
  // Monetary and assigns canonical RFM segment labels.
  registerRfmSegmentationTool(registry);
  // Price elasticity (log-log OLS). Pure-Node; returns slope, R², 95% CI,
  // t-value, and a categorical interpretation per group.
  registerPriceElasticityTool(registry);
  // Market-basket association rules (1-LHS apriori). Pure-Node; returns
  // support / confidence / lift per rule, sorted by lift desc.
  registerMarketBasketTool(registry);
  // Outlier / anomaly detection (IQR + z-score). Gated by
  // ANOMALY_DETECTION_ENABLED=true.
  registerAnomalyDetectionTool(registry);
  // Statistical significance tests (Welch's t, paired t, χ²). Gated by
  // SIGNIFICANCE_TESTS_ENABLED=true.
  registerSignificanceTestTool(registry);
  // Semantic-layer dispatcher — wraps compileMetricQuery and dispatches through
  // execute_query_plan, so the SEMANTIC_CATALOG block becomes the planner's
  // preferred dispatch path, not just read-only grounding.
  registerExecuteMetricQueryTool(registry);
}
