import { z } from "zod";

/**
 * W5 · single source-of-truth for the message / chart / dashboard / agent
 * contracts. The client re-exports this file via `client/src/shared/schema.ts`
 * (one-line re-export, enabled by Vite's `server.fs.allow`). Do not duplicate
 * types in the client copy; edit them here.
 */
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
  /**
   * W12 · 1–2 sentence framing of the chart against FMCG/Marico domain
   * priors. Populated by `generateChartInsights` only when domain context
   * is enabled and the chart's metric matches a known KPI (volume, value,
   * share, distribution, ACV, MSL, etc.). Rendered under the keyInsight
   * card. Cap matches keyInsight (≤500 chars) so renderers can share
   * styling.
   */
  businessCommentary: z.string().max(500).optional(),
  /** When true, final enrichment must not rebuild series from full rawData (aggregated/agent charts). */
  _useAnalyticalDataOnly: z.boolean().optional(),
  /** Agent tool call id or trace ref linking narrative to evidence (optional). */
  _agentEvidenceRef: z.string().max(200).optional(),
  _agentTurnId: z.string().max(80).optional(),
  /**
   * WC7 · server-attached analytical layers (forwarded into ChartSpecV2.layers
   * by the client ChartShim). Opaque to the legacy renderer.
   */
  _autoLayers: z
    .array(
      z.object({
        type: z.enum([
          "reference-line",
          "trend",
          "forecast",
          "outliers",
          "annotation",
          "comparison",
        ]),
        on: z.enum(["x", "y"]).optional(),
        value: z.union([z.number(), z.string()]).optional(),
        label: z.string().max(120).optional(),
        method: z.enum(["linear", "poly", "log", "exp-smoothing"]).optional(),
        horizon: z.number().int().min(1).max(64).optional(),
        ci: z.number().min(0).max(0.99).optional(),
        threshold: z.number().min(0).max(10).optional(),
        style: z.string().max(40).optional(),
        text: z.string().max(500).optional(),
        x: z.union([z.string(), z.number()]).optional(),
        against: z.literal("prior-period").optional(),
      })
    )
    .max(8)
    .optional(),
  /** WC7 · server-suggested alternative marks (forwarded to <SuggestedAlts>). */
  _suggestedAlts: z
    .array(
      z.object({
        mark: z.string().max(40),
        reason: z.string().max(300),
      })
    )
    .max(3)
    .optional(),
  /**
   * W7.2 · Provenance: which tool calls produced this chart's data, with row
   * counts and (when applicable) a SQL-equivalent string. Lets the UI show a
   * "where did these numbers come from" popover so managers can trust the
   * dashboard. Capped to a few entries so chart payloads stay light.
   */
  _agentProvenance: z
    .object({
      toolCalls: z
        .array(
          z.object({
            id: z.string().max(80),
            tool: z.string().max(80),
            rowsIn: z.number().int().nonnegative().optional(),
            rowsOut: z.number().int().nonnegative().optional(),
          })
        )
        .max(8),
      sqlEquivalent: z.string().max(2000).optional(),
      sources: z.array(z.string().max(120)).max(8).optional(),
      // W8 · expose the columns and range filters that produced this chart so
      // the SourceDrawer can answer "which columns and which slice of the
      // dataset was used". Both fields are optional — the UI degrades gracefully
      // when the runtime doesn't populate them.
      columnsUsed: z.array(z.string().max(120)).max(20).optional(),
      rangeFilters: z
        .array(
          z.object({
            column: z.string().max(120),
            op: z.string().max(20),
            value: z.string().max(200).optional(),
            min: z.string().max(60).optional(),
            max: z.string().max(60).optional(),
          })
        )
        .max(12)
        .optional(),
    })
    .optional(),
});

export type ChartSpec = z.infer<typeof chartSpecSchema>;

// =====================================================================
// ChartSpec v2 (grammar of graphics)
// =====================================================================
// Mark + encoding + transform + layers + source + config. Lives
// side-by-side with v1 — the client `<ChartShim>` adapter detects v1
// shape and converts. No v1 callers are required to migrate.
//
// See plan: /Users/tida/.claude/plans/are-2-things-ever-deep-duckling.md
// See contract: docs/architecture/charting.md
// =====================================================================

/** v2 mark catalog: 16 visx (primary) + 9 ECharts (lazy specialty). */
export const chartV2MarkSchema = z.enum([
  // visx (primary, non-lazy)
  "point",
  "line",
  "area",
  "bar",
  "arc",
  "rect",
  "rule",
  "text",
  "box",
  "errorbar",
  "regression",
  "combo",
  "waterfall",
  "funnel",
  "bubble",
  "radar",
  // echarts (lazy specialty bundles)
  "treemap",
  "sunburst",
  "sankey",
  "parallel",
  "calendar",
  "choropleth",
  "candlestick",
  "gauge",
  "kpi",
]);
export type ChartV2Mark = z.infer<typeof chartV2MarkSchema>;

/** Field type system: quantitative, nominal, ordinal, temporal. */
export const chartFieldTypeSchema = z.enum(["q", "n", "o", "t"]);
export type ChartFieldType = z.infer<typeof chartFieldTypeSchema>;

/** Aggregation operators usable in transforms and per-encoding. */
export const chartAggOpSchema = z.enum([
  "sum",
  "mean",
  "count",
  "median",
  "min",
  "max",
  "p25",
  "p50",
  "p75",
  "p95",
  "stdev",
  "variance",
  "distinct",
]);
export type ChartAggOp = z.infer<typeof chartAggOpSchema>;

export const chartTimeUnitSchema = z.enum([
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "yearmonth",
  "yearquarter",
  "yearweek",
]);
export type ChartTimeUnit = z.infer<typeof chartTimeUnitSchema>;

export const chartSortSpecSchema = z.union([
  z.enum(["ascending", "descending"]),
  z.object({
    field: z.string().max(200),
    op: chartAggOpSchema.optional(),
    order: z.enum(["ascending", "descending"]).optional(),
  }),
]);

export const chartBinSpecSchema = z.object({
  maxbins: z.number().int().positive().max(100).optional(),
  step: z.number().optional(),
  extent: z.tuple([z.number(), z.number()]).optional(),
});

export const chartScaleConfigSchema = z.object({
  type: z
    .enum([
      "linear",
      "log",
      "pow",
      "sqrt",
      "time",
      "band",
      "ordinal",
      "point",
    ])
    .optional(),
  domain: z.array(z.union([z.number(), z.string()])).optional(),
  range: z.array(z.union([z.number(), z.string()])).optional(),
  zero: z.boolean().optional(),
  nice: z.boolean().optional(),
  padding: z.number().optional(),
});

export const chartAxisConfigSchema = z.object({
  title: z.string().max(200).optional(),
  /** d3-format string ('$.2s', '.0%') or shortcut: 'currency'|'percent'|'kmb'|'date'. */
  format: z.string().max(40).optional(),
  labelAngle: z.number().optional(),
  grid: z.boolean().optional(),
  ticks: z.number().int().min(0).max(50).optional(),
  orient: z.enum(["top", "bottom", "left", "right"]).optional(),
});

export const chartLegendConfigSchema = z.object({
  title: z.string().max(200).optional(),
  orient: z.enum(["top", "bottom", "left", "right", "none"]).optional(),
  type: z.enum(["symbol", "gradient"]).optional(),
});

/** Base encoding channel — every encoding extends this. */
const baseEncodingChannelShape = {
  field: z.string().max(200),
  type: chartFieldTypeSchema,
  aggregate: chartAggOpSchema.optional(),
  bin: chartBinSpecSchema.optional(),
  timeUnit: chartTimeUnitSchema.optional(),
  sort: chartSortSpecSchema.optional(),
  axis: chartAxisConfigSchema.optional(),
  scale: chartScaleConfigSchema.optional(),
  legend: chartLegendConfigSchema.optional(),
  /** Per-channel format shortcut overriding axis.format. */
  format: z.string().max(40).optional(),
};

export const chartEncodingChannelSchema = z.object(baseEncodingChannelShape);
export type ChartEncodingChannel = z.infer<typeof chartEncodingChannelSchema>;

export const chartColorEncodingSchema = z.object({
  ...baseEncodingChannelShape,
  scheme: z.enum(["qualitative", "sequential", "diverging"]).optional(),
});

export const chartSizeEncodingSchema = z.object({
  ...baseEncodingChannelShape,
  range: z.tuple([z.number(), z.number()]).optional(),
});

export const chartFacetEncodingSchema = z.object({
  ...baseEncodingChannelShape,
  /** Wrap N facets per row (`facetCol`) or column (`facetRow`). */
  columns: z.number().int().positive().max(20).optional(),
});

export const chartOpacityEncodingSchema = z.union([
  chartEncodingChannelSchema,
  z.object({ value: z.number().min(0).max(1) }),
]);

export const chartTooltipChannelSchema = z
  .array(
    z.object({
      field: z.string().max(200),
      format: z.string().max(40).optional(),
      title: z.string().max(200).optional(),
    })
  )
  .max(20);

export const chartEncodingSchema = z.object({
  x: chartEncodingChannelSchema.optional(),
  y: chartEncodingChannelSchema.optional(),
  /** Range-end channel (e.g. for boxplot, errorbar, candlestick). */
  x2: chartEncodingChannelSchema.optional(),
  y2: chartEncodingChannelSchema.optional(),
  /**
   * Multiple secondary-axis series. When non-empty, line/combo charts
   * render each as an independent line on the right axis, with dash
   * patterns + colors cycled from chart-2..N. y2 (single) and y2Series
   * (array) can both be populated; y2Series wins when provided.
   */
  y2Series: z.array(chartEncodingChannelSchema).max(8).optional(),
  color: chartColorEncodingSchema.optional(),
  size: chartSizeEncodingSchema.optional(),
  shape: chartEncodingChannelSchema.optional(),
  /**
   * Pattern encoding — categorical field maps to one of 8 SVG fill
   * patterns (solid / horizontal / vertical / diagonal / cross-hatch
   * / dots / dense-dots / checkers). Independent of color, so users
   * can encode TWO categorical dimensions at once on a single bar.
   * Critical for accessibility (color-blind) and for high-dim charts.
   */
  pattern: chartEncodingChannelSchema.optional(),
  opacity: chartOpacityEncodingSchema.optional(),
  facetRow: chartFacetEncodingSchema.optional(),
  facetCol: chartFacetEncodingSchema.optional(),
  detail: chartEncodingChannelSchema.optional(),
  text: chartEncodingChannelSchema.optional(),
  tooltip: chartTooltipChannelSchema.optional(),
  order: chartEncodingChannelSchema.optional(),
});
export type ChartEncoding = z.infer<typeof chartEncodingSchema>;

/** Transforms applied to source rows before encoding. Order matters. */
export const chartTransformSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("filter"), expr: z.string().max(2000) }),
  z.object({
    type: z.literal("calculate"),
    as: z.string().max(120),
    expr: z.string().max(2000),
  }),
  z.object({
    type: z.literal("aggregate"),
    groupby: z.array(z.string().max(200)).max(10),
    ops: z
      .array(
        z.object({
          op: chartAggOpSchema,
          field: z.string().max(200),
          as: z.string().max(120),
        })
      )
      .max(20),
  }),
  z.object({
    type: z.literal("fold"),
    fields: z.array(z.string().max(200)).max(50),
    as: z.tuple([z.string().max(120), z.string().max(120)]),
  }),
  z.object({
    type: z.literal("bin"),
    field: z.string().max(200),
    as: z.string().max(120),
    maxbins: z.number().int().positive().max(100).optional(),
  }),
  z.object({
    type: z.literal("window"),
    ops: z
      .array(
        z.object({
          op: z.enum([
            "row_number",
            "rank",
            "dense_rank",
            "cumsum",
            "cummean",
            "cummax",
            "cummin",
            "moving_avg",
            "moving_sum",
            "lag",
            "lead",
          ]),
          field: z.string().max(200).optional(),
          as: z.string().max(120),
          window: z.number().int().optional(),
        })
      )
      .max(10),
    groupby: z.array(z.string().max(200)).max(10).optional(),
    sort: z.array(z.string().max(200)).max(10).optional(),
  }),
  z.object({
    type: z.literal("regression"),
    on: z.string().max(200),
    method: z.enum(["linear", "poly", "log"]),
    degree: z.number().int().min(2).max(6).optional(),
  }),
]);
export type ChartTransform = z.infer<typeof chartTransformSchema>;

/** Analytical overlays — toggleable layers on top of the base mark. */
export const chartLayerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reference-line"),
    on: z.enum(["x", "y"]),
    value: z.union([z.number(), z.enum(["mean", "median", "target"])]),
    label: z.string().max(120).optional(),
    style: z
      .object({
        stroke: z.string().max(40).optional(),
        strokeWidth: z.number().min(0.5).max(8).optional(),
        strokeDasharray: z.string().max(20).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("trend"),
    on: z.literal("y"),
    method: z.enum(["linear", "poly", "log"]),
    degree: z.number().int().min(2).max(6).optional(),
    ci: z.number().min(0).max(0.99).optional(),
  }),
  z.object({
    type: z.literal("forecast"),
    on: z.literal("y"),
    horizon: z.number().int().min(1).max(64),
    method: z.enum(["exp-smoothing", "linear"]),
    ci: z.number().min(0).max(0.99).optional(),
  }),
  z.object({
    type: z.literal("annotation"),
    x: z.union([z.string(), z.number()]),
    y: z.union([z.string(), z.number()]).optional(),
    text: z.string().max(500),
    arrow: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("outliers"),
    threshold: z.number().min(0).max(10),
    style: z.enum(["highlight", "callout"]),
  }),
  z.object({
    type: z.literal("comparison"),
    against: z.literal("prior-period"),
    style: z.enum(["faded", "split"]),
  }),
]);
export type ChartLayer = z.infer<typeof chartLayerSchema>;

/** Where the data lives. Chat charts use `session-ref` so client-side
 * re-derivation hits the in-memory <RawDataProvider> cache instead of
 * shipping rows in the spec. */
export const chartSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inline"),
    rows: z.array(
      z.record(z.union([z.string(), z.number(), z.null(), z.boolean()]))
    ),
  }),
  z.object({
    kind: z.literal("session-ref"),
    sessionId: z.string().max(120),
    dataVersion: z.number().int().nonnegative().optional(),
    rowEstimate: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("pivot-query"),
    queryRef: z.string().max(200),
    rowEstimate: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("analytical-query"),
    queryRef: z.string().max(200),
    rowEstimate: z.number().int().nonnegative().optional(),
  }),
]);
export type ChartSource = z.infer<typeof chartSourceSchema>;

export const chartConfigSchema = z.object({
  title: z
    .object({
      text: z.string().max(200),
      subtitle: z.string().max(300).optional(),
    })
    .optional(),
  theme: z.enum(["light", "dark", "auto"]).optional(),
  palette: z
    .union([
      z.enum(["qualitative", "sequential", "diverging"]),
      z.string().max(40),
    ])
    .optional(),
  height: z
    .union([z.number().int().min(80).max(2000), z.literal("auto")])
    .optional(),
  width: z
    .union([z.number().int().min(80).max(4000), z.literal("auto")])
    .optional(),
  legend: z
    .object({
      position: z
        .enum(["top", "bottom", "left", "right", "none"])
        .optional(),
      interactive: z.boolean().optional(),
    })
    .optional(),
  tooltip: z
    .object({
      format: z.enum(["rich", "compact"]).optional(),
      showComparison: z.boolean().optional(),
    })
    .optional(),
  interactions: z
    .object({
      brush: z.boolean().optional(),
      click: z
        .enum(["cross-filter", "drill-down", "drill-through", "none"])
        .optional(),
      hoverDim: z.boolean().optional(),
    })
    .optional(),
  accessibility: z
    .object({
      ariaLabel: z.string().max(300).optional(),
      description: z.string().max(1000).optional(),
    })
    .optional(),
  export: z
    .object({
      png: z.boolean().optional(),
      svg: z.boolean().optional(),
      pdf: z.boolean().optional(),
      csv: z.boolean().optional(),
    })
    .optional(),
  /** Replaces v1's underscored `_isCorrelationChart` flag (contract Q2). */
  loadingState: z.enum(["computing", "sampling", "idle"]).optional(),
  /**
   * Bar layout when `encoding.color` is set. Default: 'grouped'.
   *   - grouped: side-by-side sub-bars per category
   *   - stacked: stacked vertically per category
   *   - normalized: stacked + each category sums to 100%
   *   - grouped-stacked: outer X groups, inner color groups, each
   *     inner bar stacked by `encoding.detail` (Tableau-style)
   *   - diverging: positive values stack one direction, negatives the
   *     other; reference line at zero (for variance / sentiment).
   */
  barLayout: z
    .enum([
      "grouped",
      "stacked",
      "normalized",
      "grouped-stacked",
      "diverging",
    ])
    .optional(),
  /**
   * Bar/column orientation. 'auto' picks horizontal when X cardinality
   * is high or labels are long; defaults to vertical otherwise.
   * Named `barOrientation` (not `orientation`) to avoid shadowing the
   * deprecated `Window.orientation` DOM property.
   */
  barOrientation: z.enum(["vertical", "horizontal", "auto"]).optional(),
  /**
   * Whether to draw a "Total" / aggregate bar at the end of a stacked
   * series. Applies to the bar mark when barLayout is 'stacked' or
   * 'grouped-stacked'.
   */
  showTotalBar: z.boolean().optional(),
  /**
   * Render bar labels (the y-value) inside the bar when fits, else
   * outside. Defaults to false to keep charts uncluttered.
   */
  barLabels: z.boolean().optional(),
});
export type ChartConfig = z.infer<typeof chartConfigSchema>;

/** Root v2 spec. */
export const chartSpecV2Schema = z.object({
  version: z.literal(2),
  mark: chartV2MarkSchema,
  encoding: chartEncodingSchema,
  transform: z.array(chartTransformSchema).max(20).optional(),
  layers: z.array(chartLayerSchema).max(12).optional(),
  source: chartSourceSchema,
  config: chartConfigSchema.optional(),
  /** Provenance shared with v1; same shape so the SourceDrawer keeps working. */
  _agentProvenance: chartSpecSchema.shape._agentProvenance,
  _agentEvidenceRef: z.string().max(200).optional(),
  _agentTurnId: z.string().max(80).optional(),
});
export type ChartSpecV2 = z.infer<typeof chartSpecV2Schema>;

/** Discriminator: v2 specs declare `version: 2`; v1 specs lack it. */
export function isChartSpecV2(value: unknown): value is ChartSpecV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 2 &&
    typeof (value as { mark?: unknown }).mark === "string"
  );
}

// Insights
export const insightSchema = z.object({
  id: z.number(),
  text: z.string(),
});

/**
 * W13 · compact, persistable digest of the analytical blackboard for one
 * assistant turn. Lets the client render an "Investigation summary" card
 * that surfaces the hypotheses tested, headline findings, and unresolved
 * open questions — the parts of the agentic loop that make the analysis
 * read like a real investigation rather than a tool execution log.
 *
 * Authored as a separate small object instead of persisting the full
 * blackboard so Cosmos document size stays bounded and the client doesn't
 * need to know about evidence-ref bookkeeping.
 */
/**
 * W30 · canonical per-entry shape for the prior-investigations digest.
 * Reused by `sessionAnalysisContextSchema.sessionKnowledge.priorInvestigations`
 * (the live array) AND `messageSchema.priorInvestigationsSnapshot` (per-
 * message snapshot — added in W30 to let historical messages show what
 * the agent knew at THAT turn). Single source of truth eliminates drift.
 */
export const priorInvestigationItemSchema = z.object({
  at: z.string().max(40),
  question: z.string().max(280),
  hypothesesConfirmed: z.array(z.string().max(200)).max(5),
  hypothesesRefuted: z.array(z.string().max(200)).max(5),
  hypothesesOpen: z.array(z.string().max(200)).max(5),
  headlineFinding: z.string().max(280).optional(),
});

export type PriorInvestigationItem = z.infer<typeof priorInvestigationItemSchema>;

export const investigationSummarySchema = z.object({
  hypotheses: z
    .array(
      z.object({
        text: z.string().max(280),
        status: z.enum(["open", "confirmed", "refuted", "partial"]),
        evidenceCount: z.number().int().min(0).max(20),
      })
    )
    .max(8)
    .optional(),
  findings: z
    .array(
      z.object({
        label: z.string().max(200),
        significance: z.enum(["routine", "notable", "anomalous"]),
      })
    )
    .max(8)
    .optional(),
  openQuestions: z
    .array(
      z.object({
        question: z.string().max(280),
        priority: z.enum(["low", "medium", "high"]),
      })
    )
    .max(6)
    .optional(),
});

export type InvestigationSummary = z.infer<typeof investigationSummarySchema>;

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
  "handoff",
  "flow_decision",
]);

/**
 * Structured payload for `kind: "flow_decision"` entries. Used to surface routing
 * & override decisions (agentic vs legacy, mode vs intent, reflector replan,
 * verifier rewriteNarrative, coordinator decompose) in the workbench timeline so
 * users can see which flow won and why.
 */
export const flowDecisionDetailSchema = z.object({
  layer: z.string().max(80),
  chosen: z.string().max(120),
  overriddenBy: z.string().max(120).optional(),
  reason: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  candidates: z.array(z.string().max(200)).max(8).optional(),
});

export type FlowDecisionDetail = z.infer<typeof flowDecisionDetailSchema>;

export const agentWorkbenchEntrySchema = z.object({
  id: z.string().max(200),
  kind: agentWorkbenchEntryKindSchema,
  title: z.string().max(500),
  /** Display text (JSON, pseudo-code, etc.); cap enforced when appending server-side */
  code: z.string().max(24000),
  language: z.string().max(32).optional(),
  /** Present only for `kind: "flow_decision"`; structured routing/override payload. */
  flowDecision: flowDecisionDetailSchema.optional(),
  /**
   * W10 · short human-readable "what this step means" line, computed
   * deterministically from the SSE payload at emission time (no LLM). Lets
   * the UI show commentary alongside each entry without spawning extra LLM
   * calls. Optional + back-compat — pre-W10 Cosmos rows parse cleanly.
   */
  insight: z.string().max(400).optional(),
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
  /** WF8: Disambiguate currency for columns whose symbol is ambiguous
   * (e.g. "$" → USD/CAD/AUD/SGD/HKD, "kr" → SEK/DKK/NOK, "¥" →
   * JPY/CNY). The LLM picks the ISO code from market values, brand
   * names, and dataset description. uploadQueue applies these
   * overrides to dataSummary.columns[i].currency.isoCode. Optional —
   * empty when no ambiguous symbols exist. */
  currencyOverrides: z
    .array(
      z.object({
        columnName: z.string(),
        isoCode: z.string().min(3).max(3),
      })
    )
    .optional(),
});

export type DatasetProfile = z.infer<typeof datasetProfileSchema>;

/** Rolling LLM-maintained session context (Cosmos). All content produced by merge/seed LLM calls. */
export const sessionAnalysisColumnRoleSchema = z.object({
  name: z.string().max(200),
  role: z.string().max(200),
  notes: z.string().max(500).optional(),
});

/**
 * Declared dimension hierarchy: a value in `column` that is a category total
 * which rolls up the other values in the same column. When present, the agent
 * auto-excludes `rollupValue` from peer-comparison aggregations on `column`,
 * and frames it in narrative as a category, not a competing item.
 */
export const dimensionHierarchySchema = z.object({
  column: z.string().min(1).max(200),
  rollupValue: z.string().min(1).max(200),
  itemValues: z.array(z.string().min(1).max(200)).max(200).optional(),
  source: z.enum(["user", "auto"]).default("user"),
  description: z.string().max(500).optional(),
});

export type DimensionHierarchy = z.infer<typeof dimensionHierarchySchema>;

export const sessionAnalysisFactSchema = z.object({
  statement: z.string().max(1000),
  source: z.enum(["user", "assistant", "data"]),
  confidence: z.enum(["high", "medium", "low"]),
});

/** Compact digest from a successful analysis brief (Cosmos-safe; no full brief JSON). */
export const analysisBriefDigestSchema = z.object({
  at: z.string().max(40),
  outcomeMetricColumn: z.string().max(200).optional(),
  filterSummary: z.string().max(1500).optional(),
  comparisonBaseline: z.string().max(80).optional(),
  clarifyingQuestionCount: z.number().int().min(0).max(20).optional(),
  epistemicNotePreview: z.string().max(500).optional(),
});

export type AnalysisBriefDigest = z.infer<typeof analysisBriefDigestSchema>;

export const sessionAnalysisContextSchema = z.object({
  version: z.literal(1),
  dataset: z.object({
    shortDescription: z.string().max(2000),
    grainGuess: z.string().max(500).optional(),
    columnRoles: z.array(sessionAnalysisColumnRoleSchema).max(80),
    caveats: z.array(z.string().max(500)).max(20),
    /** Manager-facing scope bullets ("4 years · 2015–2018", "4 regions · 17 categories",
     *  "$2.3M total sales"). Rendered on the welcome card in place of the technical
     *  "Columns at a glance" breakdown. Optional for back-compat with pre-existing
     *  Cosmos docs; the renderer falls back to deterministic facts from `DataSummary`. */
    keyHighlights: z.array(z.string().max(240)).max(6).optional(),
    /** Manager-facing themes ("Compare regional sales performance",
     *  "Track shipping efficiency by mode"). Replaces the "Data caveats" section
     *  on the welcome card. Optional with the same back-compat / fallback logic. */
    whatYouCanAnalyze: z.array(z.string().max(240)).max(6).optional(),
    dimensionHierarchies: z.array(dimensionHierarchySchema).max(20).optional(),
  }),
  userIntent: z.object({
    verbatimNotes: z.string().max(8000).optional(),
    interpretedConstraints: z.array(z.string().max(500)).max(30),
  }),
  sessionKnowledge: z.object({
    facts: z.array(sessionAnalysisFactSchema).max(50),
    analysesDone: z.array(z.string().max(500)).max(30),
    /**
     * W21 · compact digest of the last few turns' investigations. Lets the
     * planner chain hypotheses across turns: pick up open questions, avoid
     * re-running settled ones, weight the new question against what's
     * already established. Capped at 5 entries to keep Cosmos doc size in
     * check; oldest dropped first.
     */
    // W30 · uses the canonical priorInvestigationItemSchema exported from
    // `lib/agents/runtime/priorInvestigations.ts` so the per-message
    // snapshot (added below) and the live SAC array share a single source
    // of truth. Inline-defined here originally; refactored into the
    // exported schema with no shape change.
    priorInvestigations: z
      .array(priorInvestigationItemSchema)
      .max(5)
      .optional(),
  }),
  suggestedFollowUps: z.array(z.string().max(300)).max(12),
  analysisBriefDigest: analysisBriefDigestSchema.optional(),
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

/**
 * RNK2 · metadata stamped on a message when the agent answered a ranking /
 * leaderboard / entity-max question. Drives the "Full leaderboard available
 * below" hint in AnswerCard and helps the client know when to scroll the
 * pivot view into focus. The full ranked rows ride on `pivotDefaults` →
 * the existing `DataPreviewTable` pivot UI; this just labels the message.
 */
export const rankingMetaSchema = z.object({
  /** Question shape that triggered the ranking pipeline. */
  intentKind: z.enum(["topN", "extremum", "entityList"]),
  /** Sort direction the planner used (desc for "top/highest", asc for "bottom/lowest"). */
  direction: z.enum(["desc", "asc"]),
  /** Entity column the leaderboard is grouped by. */
  entityColumn: z.string().max(200),
  /** Metric column being ranked (omitted for entityList). */
  metricColumn: z.string().max(200).optional(),
  /** Total number of ranked entities returned (pre-truncation). */
  totalEntities: z.number().int().nonnegative(),
  /** Set when the persisted pivot was capped below totalEntities for size safety. */
  truncationNote: z.string().max(200).optional(),
});

export type RankingMeta = z.infer<typeof rankingMetaSchema>;

/**
 * W-PivotState — full per-message pivot + chart UI state, persisted so the
 * user's view (rows / columns / values / filters / view tab / chart axes) is
 * restored exactly on session reopen and is available to the agent on
 * follow-up turns. Distinct from `pivotDefaults`: defaults are the agent's
 * server-side seed; pivotState is the user's live-edited state.
 *
 * Optional and back-compat — legacy messages without it fall back to
 * `pivotDefaults`-driven hydration (and ultimately to empty defaults).
 */
export const pivotStateSchema = z.object({
  schemaVersion: z.literal(1),
  config: z.object({
    rows: z.array(z.string().max(200)).max(20),
    columns: z.array(z.string().max(200)).max(20),
    values: z
      .array(
        z.object({
          id: z.string().max(120),
          field: z.string().max(200),
          agg: z.enum(['sum', 'mean', 'count', 'min', 'max']),
        })
      )
      .max(20),
    filters: z.array(z.string().max(200)).max(20),
    unused: z.array(z.string().max(200)).max(200),
    rowSort: z
      .object({
        byValueSpecId: z.string().max(120).optional(),
        direction: z.enum(['asc', 'desc']),
        primary: z.enum(['measure', 'rowLabel']).optional(),
      })
      .optional(),
  }),
  filterSelections: z.record(z.array(z.string().max(500)).max(2000)).optional(),
  analysisView: z.enum(['chart', 'pivot', 'flat']).optional(),
  chart: z
    .object({
      type: z.enum(['bar', 'line', 'area', 'scatter', 'pie', 'heatmap']),
      xCol: z.string().max(200),
      yCol: z.string().max(200),
      zCol: z.string().max(200).optional(),
      seriesCol: z.string().max(200),
      barLayout: z.enum(['stacked', 'grouped']),
    })
    .optional(),
  pinned: z.boolean().optional(),
  customName: z.string().max(120).optional(),
});

export type PivotState = z.infer<typeof pivotStateSchema>;

/**
 * Wave A1 · `agentInternals` — full in-memory turn state that previously
 * survived only as digests. Lets the next turn's planner / verifier / reflector
 * reason against typed prior state instead of summarised prose, and lets crash
 * recovery / debugging replay the turn without losing structure.
 *
 * Every field is optional + per-field byte-capped at zod-validation time so a
 * single richly-instrumented turn cannot blow the Cosmos 2 MB doc limit. When
 * the budget is exceeded, the agent loop trims FIFO-from-oldest before save.
 */
export const agentInternalsSchema = z.object({
  schemaVersion: z.literal(1),
  /** Last N inter-step working-memory entries, each tool call's mnemonic state. */
  workingMemory: z
    .array(
      z.object({
        callId: z.string().max(120),
        tool: z.string().max(120),
        ok: z.boolean(),
        summaryPreview: z.string().max(800),
        suggestedColumns: z.array(z.string().max(200)).max(40).optional(),
        slots: z.record(z.unknown()).optional(),
      })
    )
    .max(60)
    .optional(),
  /** Structured per-step reflector decisions (was: only `reflectorNotes` string). */
  reflectorVerdicts: z
    .array(
      z.object({
        stepIndex: z.number().int().min(0),
        action: z.enum([
          "continue",
          "finish",
          "replan",
          "clarify",
          "investigate_gap",
        ]),
        rationale: z.string().max(2000),
        suggestedQuestions: z.array(z.string().max(400)).max(8).optional(),
        gapFill: z
          .object({
            hypothesisId: z.string().max(120).optional(),
            tool: z.string().max(120),
            rationale: z.string().max(1000).optional(),
          })
          .optional(),
      })
    )
    .max(40)
    .optional(),
  /** Structured per-step + final verifier verdicts. */
  verifierVerdicts: z
    .array(
      z.object({
        stepIndex: z.number().int().min(-1), // -1 = final
        verdict: z.string().max(60),
        rationale: z.string().max(2000),
        evidence: z.string().max(4000).optional(),
      })
    )
    .max(40)
    .optional(),
  /** Snapshot of the analytical blackboard at turn end (full, not just digest). */
  blackboardSnapshot: z
    .object({
      hypotheses: z
        .array(
          z.object({
            id: z.string().max(120),
            text: z.string().max(600),
            status: z.enum([
              "open",
              "confirmed",
              "refuted",
              "partial",
              "inconclusive",
            ]),
            evidenceFindingIds: z.array(z.string().max(120)).max(20).optional(),
            parentId: z.string().max(120).optional(),
            alternatives: z.array(z.string().max(120)).max(8).optional(),
          })
        )
        .max(40)
        .optional(),
      findings: z
        .array(
          z.object({
            id: z.string().max(120),
            sourceRef: z.string().max(200),
            label: z.string().max(400),
            detail: z.string().max(2000),
            significance: z.enum(["anomalous", "notable", "routine"]),
            relatedColumns: z.array(z.string().max(200)).max(20).optional(),
            hypothesisId: z.string().max(120).optional(),
            confidence: z.enum(["low", "medium", "high"]).optional(),
          })
        )
        .max(60)
        .optional(),
      openQuestions: z
        .array(
          z.object({
            id: z.string().max(120),
            text: z.string().max(600),
            spawnedFromStepId: z.string().max(120).optional(),
            priority: z.enum(["low", "medium", "high"]).optional(),
          })
        )
        .max(20)
        .optional(),
      domainContext: z
        .array(
          z.object({
            id: z.string().max(120),
            text: z.string().max(2000),
            sourceRound: z.enum(["rag_round1", "rag_round2", "web", "injected"]),
          })
        )
        .max(20)
        .optional(),
    })
    .optional(),
  /** Per-step tool I/O — full structured result up to ~8 KB per step. */
  toolIO: z
    .array(
      z.object({
        stepId: z.string().max(120),
        tool: z.string().max(120),
        ok: z.boolean(),
        argsJson: z.string().max(4000),
        resultSummary: z.string().max(2000),
        resultPayload: z.string().max(8000).optional(), // JSON-stringified table/numericPayload
        analyticalMeta: z
          .object({
            inputRowCount: z.number().int().nonnegative().optional(),
            outputRowCount: z.number().int().nonnegative().optional(),
            appliedAggregation: z.boolean().optional(),
          })
          .optional(),
        durationMs: z.number().int().nonnegative().optional(),
      })
    )
    .max(60)
    .optional(),
  /** Coarse byte budget actually used; surfaced for size-monitoring telemetry. */
  budgetBytes: z.number().int().nonnegative().optional(),
});

export type AgentInternals = z.infer<typeof agentInternalsSchema>;

export const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  charts: z.array(chartSpecSchema).optional(),
  insights: z.array(insightSchema).optional(),
  /** LLM-suggested starter questions (initial upload message). */
  suggestedQuestions: z.array(z.string()).optional(),
  /**
   * Spawned sub-questions from the reflector with their stable ids. Distinct
   * from `suggestedQuestions` (text-only): these carry an id so per-question
   * feedback (thumbs up/down) survives reload via `pastAnalysisFeedbackTargetSchema`.
   */
  spawnedQuestions: z
    .array(z.object({ id: z.string(), question: z.string() }))
    .max(16)
    .optional(),
  /** Agent synthesis CTAs; rendered as clickable follow-up chips (max 3). */
  followUpPrompts: z.array(z.string()).max(3).optional(),
  /** Phase-1: 2–4 numeric magnitudes that back the main claim. */
  magnitudes: z
    .array(
      z.object({
        label: z.string().max(140),
        value: z.string().max(80),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(6)
    .optional(),
  /** Phase-1: one-line note on what the tools could not determine. */
  unexplained: z.string().max(800).optional(),
  /**
   * W3 · structured AnswerEnvelope. Optional — when present, the client renders
   * a headline-first AnswerCard (TL;DR pill, findings list, methodology in a
   * collapsible, caveats card, next-steps as outline buttons). When absent the
   * client falls back to rendering `content` as markdown unchanged.
   *
   * Fields are intentionally optional — narrator may emit any subset, and the
   * synthesizer fallback path emits none. Caveats and findings are arrays so
   * their order matters; renderers must preserve it.
   */
  // WTL3 · envelope `.max()` constraints loosened across the board.
  // Lengthening is forward-compatible (existing shorter outputs validate
  // trivially); shortening would break, so we only go up. Direct response
  // to the user request to "give a higher limit for all text outputs the
  // app gives to the user". The W17/W22/W35 deterministic gates still
  // enforce *presence* — only the upper-bound character / item caps move.
  answerEnvelope: z
    .object({
      tldr: z.string().max(400).optional(),
      findings: z
        .array(
          z.object({
            headline: z.string().max(280),
            evidence: z.string().max(1200),
            magnitude: z.string().max(120).optional(),
          })
        )
        .max(7)
        .optional(),
      methodology: z.string().max(1400).optional(),
      caveats: z.array(z.string().max(280)).max(5).optional(),
      nextSteps: z.array(z.string().max(280)).max(5).optional(),
      /**
       * W8 · "So what" reading of each headline finding. Each entry pairs the
       * observed `statement` with its business-meaning `soWhat`, framed using
       * the FMCG/Marico domain context when applicable. Optional confidence
       * lets the UI show a low/med/high pill.
       */
      implications: z
        .array(
          z.object({
            statement: z.string().max(400),
            soWhat: z.string().max(400),
            confidence: z.enum(["low", "medium", "high"]).optional(),
          })
        )
        .max(6)
        .optional(),
      /**
       * W8 · concrete recommended actions, grouped by horizon. Rendered as a
       * numbered list under headings ("Do now", "This quarter", "Strategic").
       */
      recommendations: z
        .array(
          z.object({
            action: z.string().max(280),
            rationale: z.string().max(400),
            horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
          })
        )
        .max(6)
        .optional(),
      /**
       * W8 · one-paragraph framing of the findings against FMCG/Marico domain
       * priors. Cite the pack id (e.g. `marico-haircare-portfolio`). Rendered
       * as an italic preamble pill above the body.
       */
      domainLens: z.string().max(900).optional(),
    })
    .optional(),
  /** Phase-2 agent-emitted dashboard draft (chat preview; not yet persisted to Cosmos). */
  dashboardDraft: z.record(z.unknown()).optional(),
  /**
   * Set when the agent persisted the dashboard automatically (requestsDashboard
   * intent). The client uses this to skip the manual "Create dashboard" CTA
   * and route the user straight to /dashboard?open=<id>.
   */
  createdDashboardId: z.string().optional(),
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
  /**
   * RNK2 · set when the message is the answer to a ranking / leaderboard
   * / entity-max question. Used by the client to render a "Full leaderboard
   * available below" hint above findings (the pivot itself comes from
   * `pivotDefaults` which the existing DataPreviewTable already auto-renders).
   * Optional + back-compat — legacy messages render unchanged.
   */
  rankingMeta: rankingMetaSchema.optional(),
  /**
   * W13 · compact digest of the analytical blackboard for this turn —
   * hypotheses tested with status, headline findings, unresolved open
   * questions. Optional + back-compat (legacy turns parse cleanly).
   */
  investigationSummary: investigationSummarySchema.optional(),
  /**
   * W30 · snapshot of `sessionKnowledge.priorInvestigations` AS IT WAS
   * BEFORE this turn ran. Lets historical messages show what the agent
   * knew at the time, distinct from the live current-state array on
   * `sessionAnalysisContext.sessionKnowledge.priorInvestigations`.
   * Capped at 5 entries (matches the live array cap). Optional + back-
   * compat — legacy messages render unchanged.
   */
  priorInvestigationsSnapshot: z
    .array(priorInvestigationItemSchema)
    .max(5)
    .optional(),
  /**
   * W6 — filters the agent applied to this turn's analysis, surfaced in the
   * UI as chips above the chart cards so the user can confirm the scope.
   * Typically populated from `ctx.inferredFilters`, but the schema is the
   * same as `analysisBriefFilterSchema` so brief-emitted filters can be saved
   * here verbatim.
   */
  appliedFilters: z
    .array(
      z.object({
        column: z.string().max(200),
        op: z.enum(["in", "not_in"]),
        values: z.array(z.string()).max(40),
        match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
      })
    )
    .max(12)
    .optional(),
  /**
   * W-PivotState — per-message pivot + chart view state. Captured client-side
   * via debounced PATCH whenever the user mutates the pivot panel; restored on
   * reopen. Also surfaced (latest assistant message only) into agent context
   * so follow-up turns know what view the user is on.
   */
  pivotState: pivotStateSchema.optional(),
  /**
   * Wave A1 · full in-memory turn state. Previously only digests survived;
   * now the working memory, reflector + verifier verdicts, full blackboard
   * snapshot, and per-step tool I/O are persisted. The next turn's
   * `priorTurnState` handle (Wave B9) reads this field to give planner /
   * reflector / verifier typed access to prior state.
   */
  agentInternals: agentInternalsSchema.optional(),
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

// Per-column currency tag, populated by detectCurrencyInValues at
// upload time. Optional — non-currency numeric columns and all
// string/date columns leave this unset. See WF2.
export const columnCurrencySchema = z.object({
  /** Raw symbol seen in cells (e.g. "đ", "R$", "kr"). */
  symbol: z.string(),
  /** ISO 4217 code (e.g. "VND", "BRL", "SEK"). */
  isoCode: z.string(),
  /** Where the symbol sat relative to the digits. */
  position: z.enum(["prefix", "suffix"]),
  /** 0..1 — votes-agreement ratio across sample values. */
  confidence: z.number(),
});

export type ColumnCurrency = z.infer<typeof columnCurrencySchema>;

// Wide-format transform metadata, populated by meltDataset when an
// uploaded dataset is detected as wide and reshaped to long. See WF4.
export const wideFormatTransformSchema = z.object({
  detected: z.literal(true),
  shape: z.enum(["pure_period", "compound", "pivot_metric_row"]),
  idColumns: z.array(z.string()),
  /** Original wide-format column headers that were melted away. */
  meltedColumns: z.array(z.string()),
  periodCount: z.number(),
  periodColumn: z.string(),
  periodIsoColumn: z.string(),
  periodKindColumn: z.string(),
  valueColumn: z.string(),
  metricColumn: z.string().optional(),
  /** Dominant currency symbol seen across melted values, if any. */
  detectedCurrencySymbol: z.string().nullable().optional(),
});

export type WideFormatTransform = z.infer<typeof wideFormatTransformSchema>;

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
    /** Currency tag for numeric columns whose cells carried a currency
     * symbol at parse time (e.g. "đ", "$", "R$"). See WF2/WF5. */
    currency: columnCurrencySchema.optional(),
  })),
  numericColumns: z.array(z.string()),
  dateColumns: z.array(z.string()),
  /** Hidden __tf_* columns derived from dateColumns for coarse time group-bys */
  temporalFacetColumns: z.array(temporalFacetColumnMetaSchema).optional(),
  /** Set when the upload pipeline detected a wide-format input and
   * melted it to long form. See WF3/WF4/WF7. */
  wideFormatTransform: wideFormatTransformSchema.optional(),
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
  /** Phase-1 rich envelope — see messageSchema.magnitudes for details. */
  magnitudes: z
    .array(
      z.object({
        label: z.string().max(140),
        value: z.string().max(80),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(6)
    .optional(),
  unexplained: z.string().max(800).optional(),
  /** Phase-2 agent-emitted dashboard draft (chat preview before commit). */
  dashboardDraft: z.record(z.unknown()).optional(),
  /** Set when the agent persisted the dashboard automatically (requestsDashboard intent). */
  createdDashboardId: z.string().optional(),
  /** W6 — filters the agent applied to the turn, mirrored in messageSchema.appliedFilters. */
  appliedFilters: z
    .array(
      z.object({
        column: z.string().max(200),
        op: z.enum(["in", "not_in"]),
        values: z.array(z.string()).max(40),
        match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
      })
    )
    .max(12)
    .optional(),
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

/** Structured intent for diagnostic / report-style questions (agent planner + verifier). */
export const analysisBriefFilterSchema = z.object({
  column: z.string().max(200),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string()).max(40),
  match: z.enum(["exact", "case_insensitive"]).optional(),
});

/**
 * Coarse question-shape label that lets Phase-1 skills dispatch. Optional so
 * existing briefs stay valid; defaults to undefined when the classifier
 * isn't confident.
 */
export const questionShapeSchema = z.enum([
  "driver_discovery",    // "what impacts X the most?"
  "variance_diagnostic", // "why did X fall in segment Y between A and B?"
  "trend",               // "how did X change over time?"
  "comparison",          // "how does A compare to B?"
  "exploration",         // "show me something interesting"
  "descriptive",         // "what's my top segment by revenue?"
  "budget_reallocation", // W52 · "how should I redistribute my marketing budget?"
]);

export type QuestionShape = z.infer<typeof questionShapeSchema>;

export const analysisBriefSchema = z.object({
  version: z.literal(1),
  outcomeMetricColumn: z.string().max(200).optional(),
  segmentationDimensions: z.array(z.string().max(200)).max(24).optional(),
  filters: z.array(analysisBriefFilterSchema).max(12).optional(),
  timeWindow: z
    .object({
      description: z.string().max(800),
      grainPreference: z
        .enum(["daily", "weekly", "monthly", "yearly", "unspecified"])
        .optional(),
    })
    .optional(),
  comparisonBaseline: z
    .enum(["yoy", "prior_period", "vs_rest", "none", "unspecified"])
    .optional(),
  clarifyingQuestions: z.array(z.string().max(350)).max(6),
  epistemicNotes: z.array(z.string().max(500)).max(8),
  successCriteria: z.string().max(1200).optional(),
  /** Phase-1: coarse question-shape label that skills dispatch on. */
  questionShape: questionShapeSchema.optional(),
  /**
   * Phase-1: dimensions that might plausibly drive the outcome metric.
   * Distinct from segmentationDimensions (which the user has already named);
   * this is the set the driver-discovery skill should test.
   */
  candidateDriverDimensions: z.array(z.string().max(200)).max(24).optional(),
  /** Phase-2: user asked to turn this turn into a dashboard. */
  requestsDashboard: z.boolean().optional(),
  /**
   * Phase-1 time_window_diff: two explicit filter sets the user named
   * for a period-A vs period-B comparison (e.g. "Mar-22" filters vs
   * "Apr-25" filters on a temporal facet column). Both sides required
   * for the skill to dispatch; single-period questions use `filters`
   * instead.
   *
   * Example: questionShape="comparison" + comparisonPeriods = {
   *   a: [{ column:"Month · Order Date", op:"in", values:["2022-03"] }],
   *   b: [{ column:"Month · Order Date", op:"in", values:["2025-04"] }],
   * }
   */
  comparisonPeriods: z
    .object({
      a: z.array(analysisBriefFilterSchema).min(1).max(8),
      b: z.array(analysisBriefFilterSchema).min(1).max(8),
      aLabel: z.string().max(80).optional(),
      bLabel: z.string().max(80).optional(),
    })
    .optional(),
});

export type AnalysisBrief = z.infer<typeof analysisBriefSchema>;

// Dashboards
export const dashboardTableSpecSchema = z.object({
  caption: z.string().min(1),
  columns: z.array(z.string()).min(1),
  // A row is an array of cell values aligned to `columns`.
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});

export type DashboardTableSpec = z.infer<typeof dashboardTableSpecSchema>;

export const dashboardGridItemSchema = z.object({
  i: z.string().max(120),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  minW: z.number().optional(),
  minH: z.number().optional(),
});

export const dashboardGridLayoutsSchema = z.record(
  z.string().max(8),
  z.array(dashboardGridItemSchema)
);

export const dashboardNarrativeRoleSchema = z.enum([
  "summary",
  "limitations",
  "recommendations",
  "custom",
]);

export const dashboardNarrativeBlockSchema = z.object({
  id: z.string().max(120),
  role: dashboardNarrativeRoleSchema,
  title: z.string().max(200),
  body: z.string().max(20000),
  order: z.number().optional(),
});

export type DashboardNarrativeBlock = z.infer<typeof dashboardNarrativeBlockSchema>;

/**
 * A pivot tile on a dashboard sheet. Lifted from the per-message
 * `pivotStateSchema` so a frozen pivot snapshot (rows/columns/values/filters
 * + view tab + chart axes) can live alongside chart tiles. Data is fetched
 * client-side via the existing pivot query endpoint scoped to
 * `sourceSessionId`.
 */
export const dashboardPivotSpecSchema = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  pivotConfig: pivotStateSchema.shape.config,
  filterSelections: pivotStateSchema.shape.filterSelections,
  analysisView: pivotStateSchema.shape.analysisView,
  chart: pivotStateSchema.shape.chart,
  sourceSessionId: z.string().max(200).optional(),
  sourceMessageId: z.string().max(200).optional(),
  createdAt: z.number().optional(),
});

export type DashboardPivotSpec = z.infer<typeof dashboardPivotSpecSchema>;

export const dashboardSheetSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  charts: z.array(chartSpecSchema),
  pivots: z.array(dashboardPivotSpecSchema).max(12).optional(),
  tables: z.array(dashboardTableSpecSchema).optional(),
  narrativeBlocks: z.array(dashboardNarrativeBlockSchema).max(40).optional(),
  /** react-grid-layout `layouts` keyed by breakpoint (lg, md, sm, xs, xxs). */
  gridLayout: dashboardGridLayoutsSchema.optional(),
  order: z.number().optional(),
});

export type DashboardSheet = z.infer<typeof dashboardSheetSchema>;

export const dashboardCollaboratorSchema = z.object({
  userId: z.string(), // User email/ID
  permission: z.enum(["view", "edit"]), // Permission level
});

/**
 * Slim AnswerEnvelope persisted alongside the dashboard so the export
 * pipeline (cover slide, exec summary, recommendations, methodology) can
 * render rich content without re-running the agent. Mirrors the subset
 * of `narratorOutputSchema` that downstream surfaces actually consume.
 */
export const dashboardAnswerEnvelopeSchema = z.object({
  tldr: z.string().max(280).optional(),
  findings: z
    .array(
      z.object({
        headline: z.string().max(200),
        evidence: z.string().max(600),
        magnitude: z.string().max(80).optional(),
      })
    )
    .max(5)
    .optional(),
  implications: z
    .array(
      z.object({
        statement: z.string().max(280),
        soWhat: z.string().max(280),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(4)
    .optional(),
  recommendations: z
    .array(
      z.object({
        action: z.string().max(200),
        rationale: z.string().max(280),
        horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
      })
    )
    .max(4)
    .optional(),
  methodology: z.string().max(500).optional(),
  caveats: z.array(z.string().max(200)).max(3).optional(),
  domainLens: z.string().max(500).optional(),
  magnitudes: z
    .array(
      z.object({
        label: z.string().max(120),
        value: z.string().max(120),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(8)
    .optional(),
});

export type DashboardAnswerEnvelope = z.infer<typeof dashboardAnswerEnvelopeSchema>;

/**
 * Wave-FA1 · Active filter spec.
 *
 * Per-session, non-destructive overlay applied at row-load and DuckDB query
 * time. The canonical dataset (currentDataBlob / rawData / blobInfo) is never
 * mutated by filter changes — see `server/lib/activeFilter/`.
 *
 * Conditions across columns are AND. Within an `in` condition, values are OR.
 * `range` requires a numeric column (min/max optional individually). `dateRange`
 * uses ISO strings and supports either bound being absent.
 *
 * Defined here (above `dashboardSchema`) so the dashboard can reference it
 * for filter-provenance metadata; `ChatDocument.activeFilter` consumes it too.
 */
export const activeFilterConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("in"),
    column: z.string().min(1).max(200),
    values: z.array(z.string()).max(5000),
  }),
  z.object({
    kind: z.literal("range"),
    column: z.string().min(1).max(200),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    kind: z.literal("dateRange"),
    column: z.string().min(1).max(200),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
]);
export type ActiveFilterCondition = z.infer<typeof activeFilterConditionSchema>;

export const activeFilterSpecSchema = z.object({
  conditions: z.array(activeFilterConditionSchema).max(50),
  /** Bumped on every change; used as a cache-key component. */
  version: z.number().int().nonnegative(),
  updatedAt: z.number(),
});
export type ActiveFilterSpec = z.infer<typeof activeFilterSpecSchema>;

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
  /** W4 · slim envelope captured at dashboard-creation time so the export
   *  pipeline can render exec summary / methodology / recommendations
   *  without re-running the agent. */
  answerEnvelope: dashboardAnswerEnvelopeSchema.optional(),
  /**
   * Wave-FA6 · Snapshot of the session's `activeFilter` at dashboard-creation
   * time. The chart data inside the dashboard is already filtered (charts are
   * captured as snapshots, not refreshed live), so this field is purely
   * provenance metadata: the dashboard view renders a banner explaining what
   * slice of the dataset the dashboard was built from. Absent on dashboards
   * created without an active filter.
   */
  capturedActiveFilter: activeFilterSpecSchema.optional(),
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

export const addPivotToDashboardRequestSchema = z.object({
  pivot: dashboardPivotSpecSchema,
  sheetId: z.string().optional(),
});

export const removePivotFromDashboardRequestSchema = z.object({
  index: z.number().min(0),
  sheetId: z.string().optional(),
});

export const updateTableCaptionRequestSchema = z.object({
  caption: z.string().min(1),
  sheetId: z.string().optional(),
});

export const createReportDashboardRequestSchema = z.object({
  name: z.string().min(1).max(200),
  question: z.string().max(4000).optional(),
  summaryBody: z.string().max(20000),
  limitationsBody: z.string().max(10000).optional(),
  recommendationsBody: z.string().max(10000).optional(),
  charts: z.array(chartSpecSchema).max(24).optional().default([]),
  table: dashboardTableSpecSchema.optional(),
});

export type CreateReportDashboardRequest = z.infer<
  typeof createReportDashboardRequestSchema
>;

/**
 * Phase 2 — agent-emitted dashboard spec.
 *
 * A self-contained proposal the chat renders inline as a preview card
 * before the user commits. `POST /api/dashboards/from-spec` persists it
 * in one Cosmos write via `createDashboardFromSpec`.
 *
 * Sheet shape mirrors the Cosmos `DashboardSheet` fields we support today
 * (charts / narrative blocks / tables / gridLayout) so the persistence
 * path is a thin reshape rather than a new data model.
 */
export const dashboardTemplateSchema = z.enum([
  "executive",
  "deep_dive",
  "monitoring",
]);

export type DashboardTemplate = z.infer<typeof dashboardTemplateSchema>;

export const dashboardSheetSpecSchema = z.object({
  id: z.string().max(120),
  name: z.string().min(1).max(200),
  narrativeBlocks: z.array(dashboardNarrativeBlockSchema).max(40).optional(),
  charts: z.array(chartSpecSchema).max(24).optional(),
  pivots: z.array(dashboardPivotSpecSchema).max(12).optional(),
  tables: z.array(dashboardTableSpecSchema).max(8).optional(),
  gridLayout: dashboardGridLayoutsSchema.optional(),
  order: z.number().optional(),
});

export type DashboardSheetSpec = z.infer<typeof dashboardSheetSpecSchema>;

export const dashboardSpecSchema = z.object({
  name: z.string().min(1).max(200),
  template: dashboardTemplateSchema,
  sheets: z.array(dashboardSheetSpecSchema).min(1).max(6),
  defaultSheetId: z.string().max(120).optional(),
  /** Original user question — kept on the spec for provenance and exports. */
  question: z.string().max(4000).optional(),
  /** Slim envelope of structured findings/recommendations/methodology to
   *  render in the export's cover, exec summary, and methodology slides. */
  answerEnvelope: dashboardAnswerEnvelopeSchema.optional(),
  /**
   * Wave-FA6 · Snapshot of the session's `activeFilter` at the moment the
   * spec was authored. Persists to `dashboard.capturedActiveFilter` so the
   * dashboard view can render a provenance banner ("Captured under filter:
   * Region ∈ {North}"). Chart data is already filtered at capture time —
   * this is metadata, not a re-applied predicate.
   */
  capturedActiveFilter: activeFilterSpecSchema.optional(),
});

export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;

export const createDashboardFromSpecRequestSchema = z.object({
  spec: dashboardSpecSchema,
  /**
   * Phase 2.E · Optional session this dashboard was created from. When
   * supplied, the server stamps `chatDocument.lastCreatedDashboardId`
   * so the `patch_dashboard` agent tool can resolve follow-up edits
   * without the user re-stating the dashboard id.
   */
  sessionId: z.string().max(200).optional(),
});

export type CreateDashboardFromSpecRequest = z.infer<
  typeof createDashboardFromSpecRequestSchema
>;

/**
 * Phase 2.E — atomic follow-up edits to an existing dashboard.
 *
 * Used by the chat "add a margin chart to the dashboard we just built"
 * flow (server side only in this PR; agent tool wiring lands later).
 * Server applies in order: remove → add → rename — so the caller never
 * has to think about index shifts.
 */
export const dashboardPatchSchema = z.object({
  addCharts: z
    .array(
      z.object({
        chart: chartSpecSchema,
        sheetId: z.string().max(120).optional(),
      })
    )
    .max(8)
    .optional(),
  removeCharts: z
    .array(
      z.object({
        sheetId: z.string().max(120),
        chartIndex: z.number().int().min(0).max(200),
      })
    )
    .max(20)
    .optional(),
  renameSheet: z
    .object({
      sheetId: z.string().max(120),
      name: z.string().min(1).max(200),
    })
    .optional(),
});

export type DashboardPatch = z.infer<typeof dashboardPatchSchema>;

export const patchDashboardRequestSchema = z.object({
  patch: dashboardPatchSchema,
});

export type PatchDashboardRequest = z.infer<typeof patchDashboardRequestSchema>;

export const patchDashboardSheetRequestSchema = z
  .object({
    narrativeBlocks: z.array(dashboardNarrativeBlockSchema).max(40).optional(),
    gridLayout: dashboardGridLayoutsSchema.optional(),
  })
  .refine(
    (d) => d.narrativeBlocks !== undefined || d.gridLayout !== undefined,
    { message: "Provide narrativeBlocks and/or gridLayout" }
  );

export const exportDashboardRequestSchema = z.object({
  format: z.enum(["pdf", "pptx"]),
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

