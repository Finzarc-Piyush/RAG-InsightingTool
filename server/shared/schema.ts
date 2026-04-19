import { z } from "zod";

/** Keep in sync with client/src/shared/schema.ts */
export const chartTypeSchema = z.enum([
  "line",
  "bar",
  "scatter",
  "pie",
  "area",
  "heatmap",
]);

// Chart Specifications
export const chartSpecSchema = z.object({
  type: chartTypeSchema,
  title: z.string(),
  x: z.string(),
  y: z.string(),
  z: z.string().optional(),
  seriesColumn: z.string().optional(),
  barLayout: z.enum(["grouped", "stacked"]).optional(),
  seriesKeys: z.array(z.string()).optional(),
  // Optional secondary Y series for dual-axis line charts
  y2: z.string().optional(),
  // Optional array of additional Y series for multi-series charts on right axis
  y2Series: z.array(z.string()).optional(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
  y2Label: z.string().optional(),
  zLabel: z.string().optional(),
  aggregate: z.enum(["sum", "mean", "count", "none"]).optional(),
  data: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).optional(),
  xDomain: z.tuple([z.number(), z.number()]).optional(), // [min, max] for X-axis
  yDomain: z.tuple([z.number(), z.number()]).optional(), // [min, max] for Y-axis
  trendLine: z.array(z.record(z.union([z.string(), z.number()]))).optional(), // Two points defining the trend line: [{ [x]: min, [y]: y1 }, { [x]: max, [y]: y2 }]
  keyInsight: z.string().optional(), // Key insight about the chart
  /** When true, final enrichment must not rebuild series from full rawData (aggregated/agent charts). */
  _useAnalyticalDataOnly: z.boolean().optional(),
});

export type ChartSpec = z.infer<typeof chartSpecSchema>;

// Insights
export const insightSchema = z.object({
  id: z.number(),
  text: z.string(),
});

export type Insight = z.infer<typeof insightSchema>;

// Thinking Steps (for real-time processing display)
export const thinkingStepSchema = z.object({
  step: z.string(),
  status: z.enum(["pending", "active", "completed", "error"]),
  timestamp: z.number(),
  details: z.string().optional(),
});

export type ThinkingStep = z.infer<typeof thinkingStepSchema>;

/** One block in the agent “workbench” UI (plan, tool I/O, parsed query). Kept small for Cosmos. */
export const agentWorkbenchEntryKindSchema = z.enum([
  "plan",
  "tool_call",
  "tool_result",
  "critic",
  "query_spec",
]);

export const agentWorkbenchEntrySchema = z.object({
  id: z.string().max(200),
  kind: agentWorkbenchEntryKindSchema,
  title: z.string().max(500),
  /** Display text (JSON, pseudo-code, etc.); cap enforced when appending server-side */
  code: z.string().max(12000),
  language: z.string().max(32).optional(),
});

export type AgentWorkbenchEntry = z.infer<typeof agentWorkbenchEntrySchema>;

export const agentWorkbenchSchema = z.array(agentWorkbenchEntrySchema).max(48);

export type AgentWorkbench = z.infer<typeof agentWorkbenchSchema>;

// Chat Messages
export const datasetProfileSchema = z.object({
  shortDescription: z.string(),
  dateColumns: z.array(z.string()),
  /** Subset of dateColumns: temporal meaning in messy string form (not native Date in the file). Server adds Cleaned_<name>. */
  dirtyStringDateColumns: z.array(z.string()).max(32).optional(),
  suggestedQuestions: z.array(z.string()).max(8),
  measureColumns: z.array(z.string()).optional(),
  idColumns: z.array(z.string()).optional(),
  grainGuess: z.string().optional(),
  notes: z.string().optional(),
});

export type DatasetProfile = z.infer<typeof datasetProfileSchema>;

/** Rolling LLM-maintained session context (Cosmos). All content produced by merge/seed LLM calls. */
export const sessionAnalysisColumnRoleSchema = z.object({
  name: z.string().max(200),
  role: z.string().max(200),
  notes: z.string().max(500).optional(),
});

export const sessionAnalysisFactSchema = z.object({
  statement: z.string().max(1000),
  source: z.enum(["user", "assistant", "data"]),
  confidence: z.enum(["high", "medium", "low"]),
});

export const sessionAnalysisContextSchema = z.object({
  version: z.literal(1),
  dataset: z.object({
    shortDescription: z.string().max(2000),
    grainGuess: z.string().max(500).optional(),
    columnRoles: z.array(sessionAnalysisColumnRoleSchema).max(80),
    caveats: z.array(z.string().max(500)).max(20),
  }),
  userIntent: z.object({
    verbatimNotes: z.string().max(8000).optional(),
    interpretedConstraints: z.array(z.string().max(500)).max(30),
  }),
  sessionKnowledge: z.object({
    facts: z.array(sessionAnalysisFactSchema).max(50),
    analysesDone: z.array(z.string().max(500)).max(30),
  }),
  suggestedFollowUps: z.array(z.string().max(300)).max(12),
  lastUpdated: z.object({
    reason: z.enum(["seed", "user_context", "assistant_turn", "mid_turn"]),
    at: z.string().max(40),
  }),
});

export type SessionAnalysisContext = z.infer<typeof sessionAnalysisContextSchema>;

/** Thinking + workbench snapshot shown above an assistant bubble (one agent segment). */
export const thinkingSnapshotSchema = z.object({
  steps: z.array(thinkingStepSchema),
  workbench: agentWorkbenchSchema.optional(),
});

export type ThinkingSnapshot = z.infer<typeof thinkingSnapshotSchema>;

export const pivotDefaultsSchema = z.object({
  rows: z.array(z.string()).optional(),
  values: z.array(z.string()).optional(),
  /** Optional pivot Columns axis (non-numeric dimensions); engine uses first only when multiple. */
  columns: z.array(z.string()).optional(),
  /** Categorical fields in the pivot Filters well (slice dimensions not on rows/columns). */
  filterFields: z.array(z.string()).optional(),
  /** Initial slice selections (field → selected values); `in` filters only in v1. */
  filterSelections: z.record(z.array(z.string())).optional(),
});

export const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  charts: z.array(chartSpecSchema).optional(),
  insights: z.array(insightSchema).optional(),
  /** LLM-suggested starter questions (initial upload message). */
  suggestedQuestions: z.array(z.string()).optional(),
  /** Agent synthesis CTAs; rendered as clickable follow-up chips (max 3). */
  followUpPrompts: z.array(z.string()).max(3).optional(),
  timestamp: z.number(),
  thinkingSteps: z.array(thinkingStepSchema).optional(), // Snapshot of thinking steps for this turn (user message)
  /** Normalized agent activity blocks for the workbench UI (capped server-side) */
  agentWorkbench: agentWorkbenchSchema.optional(),
  userEmail: z.string().optional(), // Email of the user who sent the message (for shared analyses)
  preview: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).optional(), // Preview data for data operations (aggregate, pivot, etc.)
  summary: z.array(z.any()).optional(), // Summary data for data operations
  /** Capped agent loop trace (plan, tools, critic) when AGENTIC_LOOP_ENABLED */
  agentTrace: z.record(z.unknown()).optional(),
  /** Thinking that led to this assistant message (segmented agent turns). */
  thinkingBefore: thinkingSnapshotSchema.optional(),
  /** True for preliminary assistant rows emitted before final synthesis. */
  isIntermediate: z.boolean().optional(),
  /** Short client-visible insight shown for preliminary intermediate previews. */
  intermediateInsight: z.string().optional(),
  /** Query-derived default pivot fields for auto-shown analysis tables. */
  pivotDefaults: pivotDefaultsSchema.optional(),
});

export type Message = z.infer<typeof messageSchema>;

export const temporalDisplayGrainSchema = z.enum(['dayOrWeek', 'monthOrQuarter', 'year']);

export const temporalFacetGrainSchema = z.enum([
  'date',
  'week',
  'month',
  'quarter',
  'half_year',
  'year',
]);

export const temporalFacetColumnMetaSchema = z.object({
  name: z.string(),
  sourceColumn: z.string(),
  grain: temporalFacetGrainSchema,
});

// Data Summary
export const dataSummarySchema = z.object({
  rowCount: z.number(),
  columnCount: z.number(),
  columns: z.array(z.object({
    name: z.string(),
    type: z.string(),
    sampleValues: z.array(z.union([z.string(), z.number(), z.null()])),
    /** Capped frequent values for low-cardinality string columns (optional). */
    topValues: z
      .array(
        z.object({
          value: z.union([z.string(), z.number()]),
          count: z.number(),
        })
      )
      .optional(),
    temporalDisplayGrain: temporalDisplayGrainSchema.optional(),
    /** Set when this column is a derived __tf_* bucket from a source date column. */
    temporalFacetGrain: temporalFacetGrainSchema.optional(),
    temporalFacetSource: z.string().optional(),
  })),
  numericColumns: z.array(z.string()),
  dateColumns: z.array(z.string()),
  /** Hidden __tf_* columns derived from dateColumns for coarse time group-bys */
  temporalFacetColumns: z.array(temporalFacetColumnMetaSchema).optional(),
});

export type DataSummary = z.infer<typeof dataSummarySchema>;
export type TemporalFacetColumnMeta = z.infer<typeof temporalFacetColumnMetaSchema>;
export type TemporalDisplayGrain = z.infer<typeof temporalDisplayGrainSchema>;

// Column Statistics Schema
export const columnStatisticsSchema = z.object({
  count: z.number(),
  min: z.number(),
  max: z.number(),
  sum: z.number(),
  mean: z.number(),
  median: z.number(),
  standardDeviation: z.number(),
  q1: z.number(),
  q3: z.number(),
  range: z.number(),
  variance: z.number(),
});

export type ColumnStatistics = z.infer<typeof columnStatisticsSchema>;

// Analysis Metadata Schema
export const analysisMetadataSchema = z.object({
  totalProcessingTime: z.number(),
  aiModelUsed: z.string(),
  fileSize: z.number(),
  analysisVersion: z.string(),
});

export type AnalysisMetadata = z.infer<typeof analysisMetadataSchema>;

// Complete Analysis Data Schema
export const completeAnalysisDataSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  uploadedAt: z.number(),
  createdAt: z.number(),
  lastUpdatedAt: z.number(),
  collaborators: z.array(z.string()).default([]),
  dataSummary: dataSummarySchema,
  rawData: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
  sampleRows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
  columnStatistics: z.record(z.string(), columnStatisticsSchema),
  charts: z.array(chartSpecSchema),
  insights: z.array(insightSchema),
  messages: z.array(messageSchema),
  
  // ✅ New nested chat storage format
  chatThread: z.array(z.object({
    charts: z.array(z.object({
      chart: chartSpecSchema,
      keyInsight: z.string().optional(),
    })),
    messageInsight: z.string().optional(),
  })).optional(),

  blobInfo: z.object({
    blobUrl: z.string(),
    blobName: z.string(),
  }).optional(),

  analysisMetadata: analysisMetadataSchema,
  sessionId: z.string(),
});


export type CompleteAnalysisData = z.infer<typeof completeAnalysisDataSchema>;

// Analysis Session Summary Schema
export const analysisSessionSummarySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  uploadedAt: z.number(),
  createdAt: z.number(),
  lastUpdatedAt: z.number(),
  collaborators: z.array(z.string()).default([]),
  dataSummary: dataSummarySchema,
  chartsCount: z.number(),
  insightsCount: z.number(),
  messagesCount: z.number(),
  blobInfo: z.object({
    blobUrl: z.string(),
    blobName: z.string(),
  }).optional(),
  analysisMetadata: analysisMetadataSchema,
  sessionId: z.string(),
});

export type AnalysisSessionSummary = z.infer<typeof analysisSessionSummarySchema>;

// Shared Analyses
export const sharedAnalysisStatusSchema = z.enum(["pending", "accepted", "declined"]);

export const sharedAnalysisPreviewSchema = z.object({
  fileName: z.string(),
  uploadedAt: z.number(),
  createdAt: z.number(),
  lastUpdatedAt: z.number(),
  chartsCount: z.number(),
  insightsCount: z.number(),
  messagesCount: z.number(),
});

export const sharedAnalysisInviteSchema = z.object({
  id: z.string(),
  sourceSessionId: z.string(),
  sourceChatId: z.string(),
  ownerEmail: z.string(),
  targetEmail: z.string(),
  status: sharedAnalysisStatusSchema,
  createdAt: z.number(),
  acceptedAt: z.number().optional(),
  declinedAt: z.number().optional(),
  note: z.string().optional(),
  acceptedSessionId: z.string().optional(),
  preview: sharedAnalysisPreviewSchema.optional(),
  // Optional dashboard sharing fields
  dashboardId: z.string().optional(),
  dashboardEditable: z.boolean().optional(),
});

export type SharedAnalysisInvite = z.infer<typeof sharedAnalysisInviteSchema>;

export const sharedAnalysesResponseSchema = z.object({
  pending: z.array(sharedAnalysisInviteSchema),
  accepted: z.array(sharedAnalysisInviteSchema),
});

export type SharedAnalysesResponse = z.infer<typeof sharedAnalysesResponseSchema>;

// Shared Dashboard Schemas
export const sharedDashboardPermissionSchema = z.enum(["view", "edit"]);

export const sharedDashboardStatusSchema = z.enum(["pending", "accepted", "declined"]);

export const sharedDashboardPreviewSchema = z.object({
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sheetsCount: z.number(),
  chartsCount: z.number(),
});

export const sharedDashboardInviteSchema = z.object({
  id: z.string(),
  sourceDashboardId: z.string(),
  ownerEmail: z.string(),
  targetEmail: z.string(),
  permission: sharedDashboardPermissionSchema,
  status: sharedDashboardStatusSchema,
  createdAt: z.number(),
  acceptedAt: z.number().optional(),
  declinedAt: z.number().optional(),
  note: z.string().optional(),
  preview: sharedDashboardPreviewSchema.optional(),
});

export type SharedDashboardInvite = z.infer<typeof sharedDashboardInviteSchema>;

export const sharedDashboardsResponseSchema = z.object({
  pending: z.array(sharedDashboardInviteSchema),
  accepted: z.array(sharedDashboardInviteSchema),
});

export type SharedDashboardsResponse = z.infer<typeof sharedDashboardsResponseSchema>;

// API Response Types
export const uploadResponseSchema = z.object({
  sessionId: z.string(),
  summary: dataSummarySchema,
  charts: z.array(chartSpecSchema),
  insights: z.array(insightSchema),
  sampleRows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).optional(),
  suggestions: z.array(z.string()).optional(), // AI-generated suggestions based on the data
  chatId: z.string().optional(), // CosmosDB chat document ID
  blobInfo: z.object({
    blobUrl: z.string(),
    blobName: z.string(),
  }).optional(), // Azure Blob Storage info
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export const chatResponseSchema = z.object({
  answer: z.string(),
  charts: z.array(chartSpecSchema).optional(),
  insights: z.array(insightSchema).optional(),
  suggestions: z.array(z.string()).optional(),
  followUpPrompts: z.array(z.string()).max(3).optional(),
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;

// Data Retrieval Response Schemas
export const userAnalysisSessionsResponseSchema = z.object({
  sessions: z.array(analysisSessionSummarySchema),
  totalCount: z.number(),
});

export type UserAnalysisSessionsResponse = z.infer<typeof userAnalysisSessionsResponseSchema>;

export const columnStatisticsResponseSchema = z.object({
  chatId: z.string(),
  fileName: z.string(),
  columnStatistics: z.record(z.string(), columnStatisticsSchema),
  numericColumns: z.array(z.string()),
  totalNumericColumns: z.number(),
});

export type ColumnStatisticsResponse = z.infer<typeof columnStatisticsResponseSchema>;

export const rawDataResponseSchema = z.object({
  chatId: z.string(),
  fileName: z.string(),
  data: z.array(z.record(z.union([z.string(), z.number(), z.null()]))),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    totalRows: z.number(),
    totalPages: z.number(),
    hasNextPage: z.boolean(),
    hasPrevPage: z.boolean(),
  }),
});

export type RawDataResponse = z.infer<typeof rawDataResponseSchema>;

// Session Storage (backend only)
export interface SessionData {
  data: Record<string, any>[];
  summary: DataSummary;
  fileName: string;
  uploadedAt: number;
}

// Dashboards
export const dashboardTableSpecSchema = z.object({
  caption: z.string().min(1),
  columns: z.array(z.string()).min(1),
  // A row is an array of cell values aligned to `columns`.
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});

export type DashboardTableSpec = z.infer<typeof dashboardTableSpecSchema>;

export const dashboardSheetSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  charts: z.array(chartSpecSchema),
  tables: z.array(dashboardTableSpecSchema).optional(),
  order: z.number().optional(),
});

export type DashboardSheet = z.infer<typeof dashboardSheetSchema>;

export const dashboardCollaboratorSchema = z.object({
  userId: z.string(), // User email/ID
  permission: z.enum(["view", "edit"]), // Permission level
});

export const dashboardSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOpenedAt: z.number().optional(), // Track when dashboard was last accessed
  charts: z.array(chartSpecSchema), // Keep for backward compatibility
  sheets: z.array(dashboardSheetSchema).optional(), // New: multiple sheets
  collaborators: z.array(dashboardCollaboratorSchema).optional(), // Users with access and their permissions
});

export type Dashboard = z.infer<typeof dashboardSchema>;

export const createDashboardRequestSchema = z.object({
  name: z.string().min(1),
  charts: z.array(chartSpecSchema).optional(),
});

export const addChartToDashboardRequestSchema = z.object({
  chart: chartSpecSchema,
  sheetId: z.string().optional(), // Optional: specify which sheet to add to
});

export const removeChartFromDashboardRequestSchema = z.object({
  index: z.number().optional(),
  title: z.string().optional(),
  type: chartTypeSchema.optional(),
  sheetId: z.string().optional(), // Optional: specify which sheet to remove from
}).refine((data) => data.index !== undefined || data.title !== undefined || data.type !== undefined, {
  message: "Provide index or title/type to remove a chart",
});

export const addTableToDashboardRequestSchema = z.object({
  table: dashboardTableSpecSchema,
  sheetId: z.string().optional(),
});

export const removeTableFromDashboardRequestSchema = z.object({
  index: z.number().min(0),
  sheetId: z.string().optional(),
});

export const updateTableCaptionRequestSchema = z.object({
  caption: z.string().min(1),
  sheetId: z.string().optional(),
});

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

// Recursive pivot tree nodes (group/leaf).
export const pivotLeafNodeSchema = z.lazy(() =>
  z.object({
    type: z.literal("leaf"),
    depth: z.number(),
    label: z.string(),
    pathKey: z.string(),
    values: pivotAggRowSchema,
  })
);

export const pivotGroupNodeSchema = z.lazy(() =>
  z.object({
    type: z.literal("group"),
    depth: z.number(),
    label: z.string(),
    pathKey: z.string(),
    children: z.array(pivotTreeNodeSchema),
    subtotal: pivotAggRowSchema,
  })
);

export const pivotTreeNodeSchema = z.union([pivotLeafNodeSchema, pivotGroupNodeSchema]);

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

