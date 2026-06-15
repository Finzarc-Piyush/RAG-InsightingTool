import { z } from "zod";
import {
  chartSpecSchema,
  messageAnswerEnvelopeSchema,
  businessActionItemSchema,
  pastAnalysisPivotArtifactSchema,
  investigationSummarySchema,
  pivotDefaultsSchema,
  dashboardSpecSchema,
  dashboardSchema,
  wideFormatTransformSchema,
  sessionAnalysisContextSchema,
} from "./schema/charts.js";

/**
 * EX20 / ARCH-4 · This was a 3,479-line god-module imported by 616 files.
 * The chart/dashboard grammar (the bulk) now lives in ./schema/charts.ts;
 * this file re-exports it (so every existing `from ".../schema"` import is
 * unchanged) and keeps the analytics tail domains: pivot, past-analysis /
 * memory, automations, user-directives, usage events.
 */
export * from "./schema/charts.js";

// ---------------------------
// Pivot (Excel-like) contracts
// ---------------------------

export const pivotAggSchema = z.enum(["sum", "mean", "count", "min", "max"]);
export type PivotAgg = z.infer<typeof pivotAggSchema>;

export const pivotValueSpecSchema = z.object({
  id: z.string().max(200),
  field: z.string().max(200),
  agg: pivotAggSchema,
});
export type PivotValueSpec = z.infer<typeof pivotValueSpecSchema>;

export const pivotAggRowSchema = z.object({
  flatValues: z.record(z.number()).nullable(),
  matrixValues: z.record(z.record(z.number())).nullable(),
});
export type PivotAggRow = z.infer<typeof pivotAggRowSchema>;

// Explicit types needed so TypeScript can resolve the mutual recursion between group/leaf nodes.
type _PivotLeafNode = { type: "leaf"; depth: number; label: string; pathKey: string; values: PivotAggRow };
type _PivotGroupNode = { type: "group"; depth: number; label: string; pathKey: string; children: _PivotTreeNode[]; subtotal: PivotAggRow };
type _PivotTreeNode = _PivotLeafNode | _PivotGroupNode;

// Recursive pivot tree nodes (group/leaf).
export const pivotLeafNodeSchema: z.ZodType<_PivotLeafNode> = z.lazy(() =>
  z.object({
    type: z.literal("leaf"),
    depth: z.number(),
    label: z.string(),
    pathKey: z.string(),
    values: pivotAggRowSchema,
  })
);

export const pivotGroupNodeSchema: z.ZodType<_PivotGroupNode> = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    depth: z.number(),
    label: z.string(),
    pathKey: z.string(),
    children: z.array(pivotTreeNodeSchema),
    subtotal: pivotAggRowSchema,
  })
);

export const pivotTreeNodeSchema: z.ZodType<_PivotTreeNode> = z.union([pivotLeafNodeSchema, pivotGroupNodeSchema]);

export const pivotTreeSchema = z.object({
  nodes: z.array(pivotTreeNodeSchema),
  grandTotal: pivotAggRowSchema,
});
export type PivotTree = z.infer<typeof pivotTreeSchema>;

export const pivotModelSchema = z.object({
  rowFields: z.array(z.string()),
  colField: z.string().nullable(),
  columnFields: z.array(z.string()),
  colKeys: z.array(z.string()),
  valueSpecs: z.array(pivotValueSpecSchema),
  tree: pivotTreeSchema,
  columnFieldTruncated: z.boolean(),
});
export type PivotModel = z.infer<typeof pivotModelSchema>;

export const pivotRowSortSchema = z
  .object({
    byValueSpecId: z.string().max(200).optional(),
    direction: z.enum(["asc", "desc"]),
    /** Sort pivot rows by dimension labels (chronological when parsable) instead of by a measure. */
    primary: z.enum(["measure", "rowLabel"]).optional(),
  })
  .superRefine((data, ctx) => {
    const p = data.primary ?? "measure";
    if (p === "measure" && (!data.byValueSpecId || !data.byValueSpecId.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "byValueSpecId is required when primary is measure (or omitted)",
      });
    }
  });
export type PivotRowSort = z.infer<typeof pivotRowSortSchema>;

export const pivotQueryRequestSchema = z.object({
  rowFields: z.array(z.string()),
  colFields: z.array(z.string()),
  filterFields: z.array(z.string()),
  // JSON-friendly representation of FilterSelections: field -> selected values
  filterSelections: z.record(z.array(z.string())).optional(),
  valueSpecs: z.array(pivotValueSpecSchema),
  rowSort: pivotRowSortSchema.optional(),
  /**
   * Wave P1 · Data source for the pivot. Default `"base"` queries the
   * session's canonical DuckDB `data` table (or `data_filtered` view when
   * the FA active-filter is on). `"agent_result"` operates on `sourceRows`
   * passed in this request — used when the agent's analytical step emitted
   * computed-alias columns that don't exist on the base table.
   */
  dataSource: z.enum(["base", "agent_result"]).optional(),
  /**
   * Wave P1 · Inline rows for `dataSource:"agent_result"`. The pivot
   * server aggregates these in-memory via the existing `buildPivotTree`
   * helper instead of running a DuckDB query.
   */
  sourceRows: z.array(z.record(z.unknown())).optional(),
});
export type PivotQueryRequest = z.infer<typeof pivotQueryRequestSchema>;

export const pivotQueryResponseSchema = z.object({
  model: pivotModelSchema,
  meta: z
    .object({
      source: z.enum(["duckdb", "sample"]),
      rowCount: z.number().optional(),
      colKeyCount: z.number().optional(),
      truncated: z.boolean().optional(),
      cached: z.boolean().optional(),
      cacheHit: z.boolean().optional(),
      durationMs: z.number().optional(),
    })
    .optional(),
});
export type PivotQueryResponse = z.infer<typeof pivotQueryResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────── */
/* W2.1 · Past-analysis records                                                */
/*                                                                             */
/* Written fire-and-forget after every successful turn. Source-of-truth lives  */
/* in Cosmos (container `past_analyses`). A parallel doc goes into AI Search   */
/* `past-analyses` index with an embedding of `normalizedQuestion` for the     */
/* semantic question cache (W5). The `questionEmbedding` is intentionally NOT  */
/* stored in Cosmos — at 3072 dims that would be ~24KB per row.                */
/* ────────────────────────────────────────────────────────────────────────── */

export const pastAnalysisToolCallSchema = z.object({
  id: z.string(),
  tool: z.string(),
  /** Opaque hash of tool args — used only for dedup heuristics, never parsed back. */
  argsHash: z.string(),
  ok: z.boolean(),
});
export type PastAnalysisToolCall = z.infer<typeof pastAnalysisToolCallSchema>;

export const pastAnalysisOutcomeSchema = z.enum([
  "ok",
  "verifier_failed",
  "budget_exceeded",
  "tool_error",
]);
export type PastAnalysisOutcome = z.infer<typeof pastAnalysisOutcomeSchema>;

export const pastAnalysisFeedbackSchema = z.enum(["up", "down", "none"]);
export type PastAnalysisFeedback = z.infer<typeof pastAnalysisFeedbackSchema>;

/**
 * W9 · structured reasons attached to a thumbs-down. The set is closed so
 * downstream analytics can pivot reliably; "other" lets the user write a
 * free-text comment without polluting the categorical bucket.
 */
export const pastAnalysisFeedbackReasonSchema = z.enum([
  "vague",
  "wrong_numbers",
  "missing_context",
  "too_long",
  "too_short",
  "format",
  "other",
]);
export type PastAnalysisFeedbackReason = z.infer<typeof pastAnalysisFeedbackReasonSchema>;

/**
 * Granular feedback target. Lets a single turn carry sentiment for distinct
 * surfaces: the main answer, a spawned sub-question, and the pivot view.
 *
 * - `type: "answer"` → `id: "answer"` (one per turn).
 * - `type: "pivot"`  → `id: "pivot"` (one pivot per message).
 * - `type: "subanswer"` → `id` is the spawned-question's stable id (UUID
 *   generated at reflector spawn time).
 */
export const pastAnalysisFeedbackTargetSchema = z.object({
  type: z.enum(["answer", "subanswer", "pivot"]),
  id: z.string().min(1).max(64),
});
export type PastAnalysisFeedbackTarget = z.infer<typeof pastAnalysisFeedbackTargetSchema>;

export const pastAnalysisFeedbackDetailSchema = z.object({
  target: pastAnalysisFeedbackTargetSchema,
  feedback: pastAnalysisFeedbackSchema,
  reasons: z.array(pastAnalysisFeedbackReasonSchema).max(7).default([]),
  comment: z.string().max(500).nullable().default(null),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type PastAnalysisFeedbackDetail = z.infer<typeof pastAnalysisFeedbackDetailSchema>;

export const pastAnalysisDocSchema = z.object({
  /** `${sessionId}__${turnId}` — deterministic, no random suffix so a replay overwrites. */
  id: z.string(),
  /** Partition key in Cosmos. */
  sessionId: z.string(),
  /** Normalized email. */
  userId: z.string(),
  turnId: z.string(),
  /** Monotonic version of the session's underlying data; bumps invalidate caches. */
  dataVersion: z.number().int().nonnegative(),
  /** Raw user message. */
  question: z.string(),
  /** Lowercased + punctuation-stripped for the exact-match cache lookup (W5.2). */
  normalizedQuestion: z.string(),
  answer: z.string(),
  charts: z.array(chartSpecSchema).optional(),
  toolCalls: z.array(pastAnalysisToolCallSchema).default([]),
  /** Sum of `llm_usage.costUsd` across this turn. */
  costUsd: z.number().nonnegative(),
  /** Wall-clock total, ms. */
  latencyMs: z.number().nonnegative(),
  tokenTotals: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
  }),
  outcome: pastAnalysisOutcomeSchema,
  /** Mutated by the thumbs UI (W5.5). Defaults `"none"` on write. */
  feedback: pastAnalysisFeedbackSchema.default("none"),
  /**
   * W9 · structured reasons supplied with a thumbs-down. Empty array on a
   * thumbs-up or before any vote. Allows ops to slice "what was wrong" by
   * category without re-reading every free-text comment.
   */
  feedbackReasons: z.array(pastAnalysisFeedbackReasonSchema).max(7).default([]),
  /** Optional free-text the user typed when picking "other". Capped to keep doc light. */
  feedbackComment: z.string().max(500).optional(),
  /**
   * Granular feedback per (target.type, target.id). The "answer" target is
   * mirrored onto the top-level `feedback`/`feedbackReasons`/`feedbackComment`
   * fields above so the AI Search index merge keeps surfacing answer-level
   * sentiment without changes.
   */
  feedbackDetails: z.array(pastAnalysisFeedbackDetailSchema).max(64).default([]),
  /** ms epoch. */
  createdAt: z.number(),
  /**
   * AMR1 · Structured AnswerEnvelope captured at write time so a cache-hit
   * can restore the rich AnswerCard (TL;DR, findings, magnitudes,
   * implications, methodology, caveats, domainLens, recommendations) instead
   * of rendering plain markdown. Optional + back-compat — pre-AMR docs and
   * synthesizer-fallback turns parse cleanly.
   */
  answerEnvelope: messageAnswerEnvelopeSchema.optional(),
  /**
   * AMR1 · Business action items emitted by the post-verifier BAI agent.
   * Captured so a cache-hit can re-mount `BusinessActionsCard` without
   * re-running the agent. Empty / absent ⇒ the original turn produced none.
   */
  businessActions: z.array(businessActionItemSchema).max(8).optional(),
  /**
   * AMR1 · Pivot artifacts captured during the turn (one per
   * `execute_query_plan` step that produced rows). Small pivots are inlined;
   * large ones reference a blob via `storage.kind: "blob"`. Recall surfaces
   * the rows by either reading inline or fetching the blob on demand.
   */
  pivotArtifacts: z.array(pastAnalysisPivotArtifactSchema).max(12).optional(),
  /**
   * AMR1 · W13 blackboard digest snapshot — gives a cache-hit access to the
   * original turn's hypotheses tested + headline findings + open questions.
   * Surfaced in the `InvestigationSummaryCard` mount path.
   */
  investigationSummary: investigationSummarySchema.optional(),
});
export type PastAnalysisDoc = z.infer<typeof pastAnalysisDocSchema>;

/**
 * W56 · Analysis Memory — append-only per-session journal of every analytical
 * event (questions, hypotheses, findings, charts, computed columns, filters,
 * dashboards, data-ops, user notes, conclusions). Lives in its own Cosmos
 * container partitioned by `/sessionId` and is mirrored into the per-session
 * Azure AI Search index for semantic recall (W57). The chat doc remains the
 * live state; this is the immutable projection that powers the user-visible
 * Memory page (W62) and the agent's semantic recall block (W60).
 *
 * Idempotency: `id = ${sessionId}__${turnId ?? 'lifecycle'}__${type}__${sequence}`.
 * Producers should upsert (not create) so retries / replays do not double-write.
 */
export const analysisMemoryEntryTypeSchema = z.enum([
  "analysis_created",
  "enrichment_complete",
  "question_asked",
  "hypothesis",
  "finding",
  "chart_created",
  "computed_column_added",
  "filter_applied",
  "data_op",
  "dashboard_drafted",
  "dashboard_promoted",
  // W65 · A subsequent edit to an already-promoted dashboard via the
  // `patch_dashboard` agent tool (add / remove charts, rename sheet).
  "dashboard_patched",
  "user_note",
  "conclusion",
  // AMR1 · Aggregated pivot result emitted by an `execute_query_plan` step.
  // Body references the `past_analyses` artifact (artifactId, storage kind)
  // so storage isn't duplicated — the journal entry is metadata only.
  "pivot_computed",
  // AMR1 · Compact per-turn rollup of the answer envelope (tldr +
  // implications + recommendations) for the in-session journal. Distinct
  // from `conclusion` (which mirrors the verifier-pass envelope verbatim);
  // `answer_summary` is the human-readable, AnalysisMemory-page-friendly
  // projection. Optional emission — builders may skip when redundant with
  // an existing `conclusion`.
  "answer_summary",
]);
export type AnalysisMemoryEntryType = z.infer<typeof analysisMemoryEntryTypeSchema>;

export const analysisMemoryActorSchema = z.enum(["user", "agent", "system"]);
export type AnalysisMemoryActor = z.infer<typeof analysisMemoryActorSchema>;

export const analysisMemoryEntrySchema = z.object({
  id: z.string().min(1).max(400),
  sessionId: z.string().min(1).max(200),
  username: z.string().min(1).max(320),
  createdAt: z.number(),
  turnId: z.string().max(120).optional(),
  sequence: z.number().int().nonnegative(),
  type: analysisMemoryEntryTypeSchema,
  actor: analysisMemoryActorSchema,
  title: z.string().min(1).max(200),
  summary: z.string().max(1500),
  body: z.record(z.unknown()).optional(),
  refs: z
    .object({
      messageTimestamp: z.number().optional(),
      dashboardId: z.string().max(200).optional(),
      chartId: z.string().max(200).optional(),
      dataVersion: z.number().int().nonnegative().optional(),
      blobName: z.string().max(400).optional(),
    })
    .optional(),
  dataVersion: z.number().int().nonnegative().optional(),
  significance: z.enum(["anomalous", "notable", "routine"]).optional(),
});
export type AnalysisMemoryEntry = z.infer<typeof analysisMemoryEntrySchema>;

// Wave-FA1 · Active filter spec moved to before `dashboardSchema` so the
// dashboard can reference it. See definitions earlier in this file.

// ---------------------------------------------------------------------------
// Automations · "Save as Automation" / "Re-Run Existing Automation"
// ---------------------------------------------------------------------------
// A user can capture an entire chat session (all questions, plan steps,
// charts, pivot configs, dashboards) as a re-runnable Automation. On a fresh
// start screen they pick a saved Automation, choose Excel/Snowflake as the
// data source, the system reconciles columns (LLM-assisted remap when names
// drift), re-applies the saved schema transformations to the new dataset,
// and then deterministically replays each turn.
//
// Plan steps are stored loose (`z.record(z.unknown())`) for the same reason
// `agentTrace` is loose: server-side replay code validates with the strict
// runtime planStepSchema (lib/agents/runtime/schemas.ts), and the client
// only needs metadata-level knowledge.
// ---------------------------------------------------------------------------

const automationColumnInfoSchema = z.object({
  name: z.string(),
  type: z.string(),
  sampleValues: z
    .array(z.union([z.string(), z.number(), z.null()]))
    .max(10)
    .optional(),
  topValues: z
    .array(
      z.object({
        value: z.union([z.string(), z.number()]),
        count: z.number(),
      })
    )
    .optional(),
});
export type AutomationColumnInfo = z.infer<typeof automationColumnInfoSchema>;

export const automationSessionComputedColumnSchema = z.object({
  name: z.string().min(1).max(200),
  /** Captured from `add_computed_columns` tool calls with persistToSession=true. */
  formula: z.string().min(1).max(2000),
  sourceTurnOrdinal: z.number().int().nonnegative(),
});
export type AutomationSessionComputedColumn = z.infer<
  typeof automationSessionComputedColumnSchema
>;

export const automationTurnSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  question: z.string().min(1).max(8000),
  /** Free-form mode label captured from the original turn (analytical / data_op / general / etc.). */
  mode: z.string().max(60).optional(),
  /** Loose plan-step list. Server-side replay revalidates with the strict
   *  runtime planStepSchema before dispatching to ToolRegistry. */
  planSteps: z.array(z.record(z.unknown())).max(60),
  /** Captured chart templates (title, encoding, businessCommentary). Data
   *  is refilled from new tool outputs at replay time. */
  charts: z.array(chartSpecSchema).max(24).optional(),
  pivotDefaults: pivotDefaultsSchema.optional(),
  dashboardDraft: dashboardSpecSchema.optional(),
  /** Name of the dashboard auto-created from this turn (for traceability;
   *  replay creates a fresh dashboard with the same name). */
  createdDashboardName: z.string().max(200).optional(),
});
export type AutomationTurn = z.infer<typeof automationTurnSchema>;

export const automationSchema = z.object({
  id: z.string().min(1).max(200),
  username: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  /** Original chat session this automation was captured from. */
  sourceSessionId: z.string().min(1).max(200),
  sourceFileName: z.string().min(1).max(400),
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  runCount: z.number().int().nonnegative().default(0),

  /** Schema fingerprint for compatibility check + LLM-assisted remap. */
  expectedSchema: z.object({
    /** Columns BEFORE upload-time transforms (wide-format melt, temporal facets). */
    rawColumns: z.array(automationColumnInfoSchema).max(500),
    /** Columns AFTER all upload + chat-time transforms. Plan-step args reference these. */
    finalColumns: z.array(automationColumnInfoSchema).max(500),
  }),

  /** Re-applied to the new session BEFORE the recipe replays. */
  sessionTransformations: z.object({
    /** Re-melt at upload time when set. */
    wideFormatTransform: wideFormatTransformSchema.optional(),
    /** Persisted (persistToSession=true) computed columns from the original chat. */
    sessionComputedColumns: z
      .array(automationSessionComputedColumnSchema)
      .max(40)
      .optional(),
    // Wave W-UD1 · Zod length cap dropped — user requirement is "store user
    // context forever without any limit". The Cosmos 2 MB doc soft limit is
    // the only ceiling now, enforced by `cosmosDocSizeGuard.test.ts`. The
    // automation seed mirrors the same shape as `ChatDocument.permanentContext`
    // (no Zod cap on the live field either).
    permanentContext: z.string().optional(),
    /** Slim seed of the original sessionAnalysisContext (user intent +
     *  declared dimension hierarchies + dataset notes). */
    seedSessionAnalysisContext: sessionAnalysisContextSchema
      .partial()
      .optional(),
  }),

  recipe: z.array(automationTurnSchema).max(200),
});
export type Automation = z.infer<typeof automationSchema>;

/** POST /api/automations body. */
export const createAutomationRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
});
export type CreateAutomationRequest = z.infer<
  typeof createAutomationRequestSchema
>;

/** Lightweight summary returned by GET /api/automations (list view). */
export const automationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  sourceFileName: z.string(),
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  runCount: z.number().int().nonnegative(),
  recipeLength: z.number().int().nonnegative(),
  expectedColumnCount: z.number().int().nonnegative(),
});
export type AutomationSummary = z.infer<typeof automationSummarySchema>;

/** POST /api/automations/:id/dry-run response. */
export const automationDryRunResultSchema = z.object({
  exactMatches: z.array(z.string()),
  proposedMappings: z.array(
    z.object({
      saved: z.string(),
      suggested: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
      reason: z.string().max(400).optional(),
    })
  ),
  unmatchable: z.array(z.string()),
});
export type AutomationDryRunResult = z.infer<typeof automationDryRunResultSchema>;

/** Final user-confirmed column mapping submitted with the run request. */
export const automationColumnMappingSchema = z.record(z.string(), z.string());
export type AutomationColumnMapping = z.infer<typeof automationColumnMappingSchema>;

/** POST /api/automations/:id/run body (SSE response). */
export const runAutomationRequestSchema = z.object({
  sessionId: z.string().min(1).max(200),
  /** saved-name → new-name. Identity for unchanged columns may be omitted. */
  columnMapping: automationColumnMappingSchema.optional(),
});
export type RunAutomationRequest = z.infer<typeof runAutomationRequestSchema>;

// ============================================================================
// Wave W-UD1 · User directives — per-dataset persistent rules
// ============================================================================
// Extracted to `./userDirectiveSchema.ts` as a self-contained leaf cluster.
// Re-exported here verbatim so existing `from ".../shared/schema.js"` imports
// (server + client `@shared/schema`) keep resolving unchanged.
export {
  userDirectiveScopeSchema,
  userDirectiveKindSchema,
  userDirectiveSourceSchema,
  userDirectiveStatusSchema,
  userDirectiveStructuredSchema,
  userDirectiveSchema,
  datasetDirectivesDocSchema,
} from "./userDirectiveSchema.js";
export type {
  UserDirectiveScope,
  UserDirectiveKind,
  UserDirectiveSource,
  UserDirectiveStatus,
  UserDirectiveStructured,
  UserDirective,
  DatasetDirectivesDoc,
} from "./userDirectiveSchema.js";

// W-EXP-1 · Dashboard-export `SlideDeckPlan` schema. Re-exported here so the
// client side (`@shared/schema`) picks it up automatically — the planner
// agent and renderers consume it server-side, but client-side exports may
// want to type the download response in the future.
export * from "./exportSchema.js";

// ============================================================================
// Wave AD3 · Usage events — admin-dashboard observability
// ============================================================================
// One container, partitioned by `/dateKey`, holding fire-and-forget per-event
// rows. Used by the metrics aggregator (Wave AD5) to compute KPIs the existing
// containers can't derive (dashboard exports, pivot generations, message
// regenerations / edits, dashboard opens). Charts / messages / dashboards-
// created / cost / feedback are NOT logged here — the aggregator queries the
// existing canonical containers for those.

export const usageEventTypeSchema = z.enum([
  "dashboard.exported",
  "dashboard.opened",
  "dashboard.shared",
  "dashboard.drill-through",
  "dashboard.explain-slice",
  "analysis.shared",
  "pivot.generated",
  "message.regenerated",
  "message.edited",
  "admin.session.viewed",
  // One row per question served from the past_analyses cache (exact or
  // semantic). These turns DON'T write a fresh past_analyses doc, so the
  // metrics aggregator folds them in to keep "Questions" / active-user counts
  // honest. One event per (user, analysis served).
  "analysis.cache_hit",
]);
export type UsageEventType = z.infer<typeof usageEventTypeSchema>;

export const usageEventDocSchema = z.object({
  /** `${dateKey}__${userEmail}__${eventType}__${ulidOrUuid}` — deterministic ordering by date. */
  id: z.string(),
  /** Partition key (UTC `YYYYMMDD`). */
  dateKey: z.string().regex(/^\d{8}$/),
  /** ms epoch — exact event time, for sub-day ordering. */
  timestamp: z.number().int().nonnegative(),
  eventType: usageEventTypeSchema,
  /** Normalized email of the actor. */
  userEmail: z.string(),
  /** Optional foreign keys — populated when relevant for the event type. */
  sessionId: z.string().optional(),
  dashboardId: z.string().optional(),
  /** Free-form per-event payload (kept small — caps enforced by writers). */
  metadata: z.record(z.unknown()).optional(),
});
export type UsageEventDoc = z.infer<typeof usageEventDocSchema>;

