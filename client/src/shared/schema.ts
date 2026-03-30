import { z } from "zod";

/** Keep in sync with server/shared/schema.ts */
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
  /** Primary category / line X / heatmap row dimension */
  x: z.string(),
  /**
   * Primary measure (bar/line/…) or heatmap **column** dimension when type is `heatmap`.
   * For stacked/grouped bars with `seriesColumn`, this is the numeric measure column in long format.
   */
  y: z.string(),
  /** Heatmap cell value column (required for type `heatmap`). */
  z: z.string().optional(),
  /** Long-format second categorical: pivots into multiple bar series (with `bar`). */
  seriesColumn: z.string().optional(),
  /** How to render multi-series bars after pivot; default stacked. */
  barLayout: z.enum(["grouped", "stacked"]).optional(),
  /** After pivot, explicit series keys (measure columns) for multi-series bars. */
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
  dirtyStringDateColumns: z.array(z.string()).max(32).optional(),
  suggestedQuestions: z.array(z.string()).max(8),
  measureColumns: z.array(z.string()).optional(),
  idColumns: z.array(z.string()).optional(),
  grainGuess: z.string().optional(),
  notes: z.string().optional(),
});

export type DatasetProfile = z.infer<typeof datasetProfileSchema>;

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
    reason: z.enum(["seed", "user_context", "assistant_turn"]),
    at: z.string().max(40),
  }),
});

export type SessionAnalysisContext = z.infer<typeof sessionAnalysisContextSchema>;

export const thinkingSnapshotSchema = z.object({
  steps: z.array(thinkingStepSchema),
  workbench: agentWorkbenchSchema.optional(),
});

export type ThinkingSnapshot = z.infer<typeof thinkingSnapshotSchema>;

export const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  charts: z.array(chartSpecSchema).optional(),
  insights: z.array(insightSchema).optional(),
  suggestedQuestions: z.array(z.string()).optional(),
  timestamp: z.number(),
  thinkingSteps: z.array(thinkingStepSchema).optional(),
  agentWorkbench: agentWorkbenchSchema.optional(),
  userEmail: z.string().optional(), // Email of the user who sent the message (for shared analyses)
  agentTrace: z.record(z.unknown()).optional(),
  preview: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).optional(),
  summary: z.array(z.any()).optional(),
  thinkingBefore: thinkingSnapshotSchema.optional(),
  isIntermediate: z.boolean().optional(),
  /** Short client-visible insight shown for preliminary intermediate previews. */
  intermediateInsight: z.string().optional(),
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

export type TemporalFacetColumnMeta = z.infer<typeof temporalFacetColumnMetaSchema>;

// Data Summary
export const dataSummarySchema = z.object({
  rowCount: z.number(),
  columnCount: z.number(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      sampleValues: z.array(z.union([z.string(), z.number(), z.null()])),
      topValues: z
        .array(
          z.object({
            value: z.union([z.string(), z.number()]),
            count: z.number(),
          })
        )
        .optional(),
      temporalDisplayGrain: temporalDisplayGrainSchema.optional(),
      temporalFacetGrain: temporalFacetGrainSchema.optional(),
      temporalFacetSource: z.string().optional(),
    })
  ),
  numericColumns: z.array(z.string()),
  dateColumns: z.array(z.string()),
  temporalFacetColumns: z.array(temporalFacetColumnMetaSchema).optional(),
});

export type DataSummary = z.infer<typeof dataSummarySchema>;
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
  chatThread: z.array(
    z.object({
      charts: z.array(
        z.object({
          chart: chartSpecSchema,
          keyInsight: z.string().optional(),
        })
      ),
      messageInsight: z.string().optional(),
    })
  ).optional(),

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
}).refine(
  (data) =>
    data.index !== undefined || data.title !== undefined || data.type !== undefined,
  {
    message: "Provide index or title/type to remove a chart",
  }
);

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
