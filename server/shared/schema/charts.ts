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
/**
 * Wave WI1 · InsightSpec — richer, dynamic-aware sibling of the legacy
 * `chart.keyInsight: string` field.
 *
 * Pre-WI1 the per-chart insight was a single static string baked at chart
 * creation; on filter change or other interactivity, the user saw stale
 * prose. WI1 introduces a structured `chart.insight: InsightSpec` field
 * carrying:
 *
 *   - `default` — the baked-at-creation insight (what `keyInsight` was).
 *     Stays load-bearing for renderers that don't yet consume `generator`.
 *   - `generator` — describes how to *re-derive* the insight when the
 *     surrounding state changes (e.g., when the user adds a filter via
 *     the WD1 popover, or when WI4 fires an "explain this slice" click).
 *     Future waves (WI2) wire a small LLM call against `generator.args`;
 *     today the field is optional + opaque, so back-compat is preserved.
 *   - `confidenceTier` — `low | medium | high` for confidence-aware
 *     rendering (W9-quality follow-up). Renderers can shrink prose +
 *     add hedging when `low`.
 *   - `citations` — array of domain pack ids referenced (e.g.
 *     `kpi-and-metric-glossary`). Drives the WI3 citation hover-card UI;
 *     the existing W22 `checkDomainLensCitations` infra validates these
 *     server-side.
 *   - `regeneratedAt` — ISO timestamp of the last regen. Lets the client
 *     show "Updated 2 min ago" / cache-invalidate by interaction event.
 *
 * Back-compat: `chart.keyInsight` stays — it's the simple path for chart
 * specs created before WI1. Renderers prefer `insight.default` when
 * present, fall back to `keyInsight` otherwise.
 */
export const insightSpecSchema = z.object({
  /** Baked-at-creation insight text. Rendered when the dynamic
   *  generator hasn't (yet) produced a fresh insight. ≤ 500 chars to
   *  match the existing `businessCommentary` cap so renderers can share
   *  styling envelopes. */
  default: z.string().max(500),
  /** Optional re-generation hook. WI2 wires the `"llm"` kind to a
   *  MINI-tier LLM call; today the field is opaque + back-compat. */
  generator: z
    .object({
      kind: z.enum(["llm", "deterministic"]),
      /** Free-form args for the generator. Shape is generator-specific
       *  (e.g., for `kind: "llm"` we expect `{ promptKey, contextRefs }`).
       *  Kept as a passthrough record so future generators can extend
       *  without a schema bump. */
      args: z.record(z.unknown()).optional(),
    })
    .optional(),
  /** Confidence tier driving prose length + hedging (W9 quality wave). */
  confidenceTier: z.enum(["low", "medium", "high"]).optional(),
  /** Domain pack ids cited in `default`; validated against the supplied
   *  domain context server-side (W22 infrastructure). */
  citations: z.array(z.string().min(1).max(80)).max(8).optional(),
  /** ISO timestamp of the last regeneration (server-set). */
  regeneratedAt: z.string().max(40).optional(),
});

export type InsightSpec = z.infer<typeof insightSpecSchema>;

/** Helper: lift a legacy `keyInsight` string into an `InsightSpec`
 *  preserving the default-text contract. Used by migration paths in
 *  follow-up waves; pure, deterministic, safe in tests. */
export function legacyKeyInsightToInsightSpec(
  keyInsight: string | undefined,
): InsightSpec | undefined {
  if (typeof keyInsight !== "string") return undefined;
  const trimmed = keyInsight.trim();
  if (!trimmed) return undefined;
  return { default: trimmed.slice(0, 500) };
}

/**
 * Wave S2 · how a categorical bar/column chart is ordered (the legacy v1
 * `ChartSpec` row-ordering preference). `by:"value"` orders by the measured
 * value (sum across series for multi-series); `by:"category"` orders by the
 * x-axis itself (numeric → 0→100, dates → chronological, buckets → 0-10/10-20…,
 * else A→Z). This shape MUST stay in lock-step with the `ChartSortSpec`
 * interface in server/shared/chartSort.ts (linked structurally, not imported,
 * so the comparator module stays dependency-free).
 *
 * NB: distinct from `chartSortSpecSchema` below, which is the ChartSpecV2
 * encoding-sort grammar (`{field, op, order}`).
 */
export const barSortSpecSchema = z.object({
  by: z.enum(["value", "category"]),
  direction: z.enum(["asc", "desc"]),
});
export type BarSortSpec = z.infer<typeof barSortSpecSchema>;

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
  /**
   * Metric-semantics sidecar (W5) stamped by processChartData via
   * financeMetricAuthority — NON-breaking, optional, never widens `aggregate`.
   * `metricAdditivity` records whether the Y metric may be summed; `aggPolicy`
   * records HOW it was combined across the dimension (recompute Σnum/Σden,
   * weighted_mean, mean, or sum) so titles/labels can say "Avg"/"Σ/Σ" not "Total".
   */
  metricAdditivity: z.enum(["additive", "non_additive"]).optional(),
  aggPolicy: z.enum(["sum", "mean", "weighted_mean", "recompute"]).optional(),
  /**
   * MW3 · category sort direction for categorical bar charts. "desc" (default)
   * shows best-first; "asc" surfaces the WORST performers first (bottom-N, for
   * management-by-exception). Honoured by processChartData (server) and the
   * client renderer's top↔bottom toggle.
   */
  sortDirection: z.enum(["asc", "desc"]).optional(),
  /**
   * Wave S2 · user-selectable / server-baked chart ordering. Supersedes the
   * value-only `sortDirection` (which is kept as a back-compat alias —
   * `resolveSort` reads `sort ?? sortDirection ?? auto-default`). Newly built
   * bar/column charts bake their resolved sort here so the choice persists;
   * pre-existing specs that lack this field render in their saved row order and
   * are never retroactively reordered. See server/shared/chartSort.ts.
   */
  sort: barSortSpecSchema.optional(),
  /**
   * MW3 · optional cap on charted categories (e.g. a "Worst 10" view). Omitted
   * = ALL categories — a manager must be able to reach every record, so the
   * primary dashboard breakdowns never silently truncate.
   */
  maxRows: z.number().int().positive().max(10_000).optional(),
  /**
   * Off-day handling · weekday names (e.g. ["Sunday"]) to EXCLUDE from this
   * chart before aggregation. Set when the user accepts the non-blocking
   * "exclude Sundays?" affordance on a daily date-axis chart whose recurring
   * off-day (≈0) was detected. Filtering rows upstream of aggregation makes the
   * average working-day-aware with no special math. Per-chart scope; the
   * session-wide escalation uses the active filter instead.
   */
  excludedWeekdays: z
    .array(
      z.enum([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ])
    )
    .max(7)
    .optional(),
  data: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).optional(),
  xDomain: z.tuple([z.number(), z.number()]).optional(), // [min, max] for X-axis
  yDomain: z.tuple([z.number(), z.number()]).optional(), // [min, max] for Y-axis
  trendLine: z.array(z.record(z.union([z.string(), z.number()]))).optional(), // Two points defining the trend line: [{ [x]: min, [y]: y1 }, { [x]: max, [y]: y2 }]
  keyInsight: z.string().optional(), // Key insight about the chart
  /**
   * Wave WI1 · richer, dynamic-aware insight. Coexists with the simpler
   * `keyInsight` string for back-compat — renderers prefer
   * `insight.default` when present, fall back to `keyInsight` otherwise.
   * Future waves (WI2, WI4) populate `generator` so the panel can
   * regenerate on filter change.
   */
  insight: insightSpecSchema.optional(),
  /**
   * W12 · 1–2 sentence framing of the chart against FMCG/Marico domain
   * priors. Populated by `generateChartInsights` only when domain context
   * is enabled and the chart's metric matches a known KPI (volume, value,
   * share, distribution, ACV, MSL, etc.). Rendered under the keyInsight
   * card. Cap matches keyInsight (≤500 chars) so renderers can share
   * styling.
   */
  businessCommentary: z.string().max(500).optional(),
  /**
   * W-GMK2 · short, user-facing explanation of why this x-axis was picked
   * (e.g. "Showing Quarter · Period (filtered to PeriodKind = Quarter,
   * sorted chronologically)"). Rendered as a subtitle under the title by
   * `InteractiveChartCard`. Populated by `resolvePeriodAxis` when the chart
   * has a time axis; absent otherwise.
   */
  axisReason: z.string().max(300).optional(),
  /**
   * W-GMK9 · per-chart override for inline data labels. Mirrors v2's
   * `config.dataLabels`. When undefined the renderer defaults to true
   * (labels on, collision-thinned). InteractiveChartCard's "Show
   * labels" checkbox toggles this field.
   */
  dataLabels: z.boolean().optional(),
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

/**
 * Stable identity for a chart across persistence (storage dedup) and
 * re-hydration (re-attaching stripped `data` on session reload). Keys on the
 * fields that SURVIVE the message-chart strip (`type`, `title`, `x`, `y`,
 * `seriesColumn`) — i.e. everything except `data`/`trendLine`. Using the full
 * axis identity (not just `type::title`) is what lets two charts that share a
 * title but differ in breakdown — e.g. a primary "Adherence Rate" by Cluster
 * and an investigated follow-up "Adherence Rate" by ASM — each persist and
 * re-hydrate their OWN data instead of colliding and rendering empty on reload.
 * Backward-compatible: derived from metadata both old and new docs retain.
 */
export function chartIdentityKey(
  c: Pick<ChartSpec, "type" | "title"> & {
    x?: string | null;
    y?: string | null;
    seriesColumn?: string | null;
  }
): string {
  return `${c.type ?? ""}::${c.title ?? ""}::${c.x ?? ""}::${c.y ?? ""}::${c.seriesColumn ?? ""}`;
}

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
   *
   * @deprecated W-GMK6 · use `dataLabels` instead. `barLabels` is kept
   * for back-compat — when set true, it implies `dataLabels` for the
   * Bar renderer only.
   */
  barLabels: z.boolean().optional(),
  /**
   * W-GMK6 · render in-chart value labels on every mark (Bar / Line /
   * Area / Point) with greedy collision filtering so labels appear ON
   * by default and silently drop when their bounding boxes would overlap.
   * Renderers default to `true` when this field is undefined so the
   * user-requested "labels by default" behaviour kicks in across all
   * mark types. Set to `false` to hide all data labels.
   */
  dataLabels: z.boolean().optional(),
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
  // Tolerant of a common LLM shape drift (some deployments return `notes` as an
  // array of caveats) — coerce array → joined string so the dataset-profile
  // call doesn't waste a full retry round-trip on the upload critical path.
  notes: z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v.filter((x) => typeof x === "string").join("; ")
        : v,
    z.string().optional(),
  ),
  /** WF8: Disambiguate currency for columns whose symbol is ambiguous
   * (e.g. "$" → USD/CAD/AUD/SGD/HKD, "kr" → SEK/DKK/NOK, "¥" →
   * JPY/CNY). The LLM picks the ISO code from market values, brand
   * names, and dataset description. uploadQueue applies these
   * overrides to dataSummary.columns[i].currency.isoCode. Optional —
   * empty when no ambiguous symbols exist. */
  // Tolerant of LLM shape drift: some deployments return `currencyOverrides` as
  // a single object or a {columnName: isoCode} map instead of an array. Coerce
  // to the array shape so we don't burn a retry round-trip; correct arrays pass
  // through unchanged.
  currencyOverrides: z
    .preprocess((v) => {
      if (v == null || Array.isArray(v)) return v;
      if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.columnName === "string" && typeof o.isoCode === "string") {
          return [o];
        }
        return Object.entries(o)
          .filter(([, iso]) => typeof iso === "string")
          .map(([columnName, isoCode]) => ({ columnName, isoCode }));
      }
      return v;
    }, z
      .array(
        z.object({
          columnName: z.string(),
          isoCode: z.string().min(3).max(3),
        })
      )
      .optional()),
});

export type DatasetProfile = z.infer<typeof datasetProfileSchema>;

/**
 * Wave W-DPC1 · Cached dataset-profile doc (Cosmos `dataset_profiles`).
 *
 * Keyed by `(username, datasetFingerprint)` so re-uploads of the same workbook
 * shape reuse a prior profile instead of re-running the upload-critical-path
 * `inferDatasetProfile` LLM call. `contextHash` captures the permanent + domain
 * context that also feed the call, so a context change invalidates the entry;
 * `schemaVersion` invalidates everything when the profile prompt/shape changes.
 * Only the `DatasetProfile` is cached — never the materialized data table.
 */
export const datasetProfileCacheDocSchema = z.object({
  id: z.string(),
  username: z.string(),
  datasetFingerprint: z.string(),
  contextHash: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  profile: datasetProfileSchema,
  updatedAt: z.number(),
});

export type DatasetProfileCacheDoc = z.infer<typeof datasetProfileCacheDocSchema>;

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

/**
 * W56 · Semantic & metrics layer — type foundation.
 *
 * The semantic layer is the "metrics catalog" the planner speaks against
 * instead of raw column names. A SemanticModel is per-session, derived once
 * at upload from DataSummary + datasetProfile + wide-format proposal +
 * dimensionHierarchies (W57), and editable in the admin UI (W61). The
 * compiler (W58) turns {metric, breakdownBy, filters, window} into a
 * QueryPlanBody, replacing ~70% of planner ad-hoc DuckDB calls and lifting
 * accuracy ~300% / cutting wrong-column errors ~66% per industry
 * benchmarks (Cube, Looker LookML).
 *
 * Distinct from `dimensionHierarchySchema` (above) which represents
 * "rollup values inside one column" (e.g., 'All India' = parent of
 * North/South/East/West). `semanticHierarchy` is the orthogonal concept:
 * an ordered chain of separate dimensions (Country → Region → City) used
 * for drill-down navigation. The two coexist.
 */

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/**
 * A single Metric in the semantic layer — the things users ask about
 * ("Net Sales", "Volume Share", "Average Selling Price"). Each Metric
 * compiles to a SQL aggregation expression against the dataset columns.
 */
export const semanticMetricSchema = z.object({
  /** Canonical identifier; stable across model versions; used in metric query API. */
  name: z.string().min(1).max(80).regex(SNAKE_CASE),
  /** Human-readable label for UI + planner prompt. */
  label: z.string().min(1).max(120),
  /**
   * SQL aggregation expression — pure aggregation, no SELECT / JOIN /
   * subqueries. Examples:
   *   - `SUM(gross_sales) - SUM(returns)`
   *   - `AVG(price)`
   *   - `SUM(value_sales) / NULLIF(SUM(volume_sales), 0)`
   * Compiler (W58) validates referenced columns exist in the dataset.
   */
  expression: z.string().min(1).max(2000),
  /**
   * Base columns the expression references. Lets the compiler validate
   * and lets validateModel (W63) lint warn on orphan references.
   * Empty array is allowed for constant expressions.
   */
  references: z.array(z.string().min(1).max(200)).max(20).default([]),
  /** Display format hint passed to chart/pivot renderers. */
  format: z
    .enum(["number", "percent", "currency", "ratio", "duration"])
    .default("number"),
  /** ISO 4217 code (e.g., "INR", "USD") — required when `format === "currency"`. */
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, "ISO 4217 (3 uppercase letters)")
    .optional(),
  /** Decimal places to render; 0..6. Renderer default applies if omitted. */
  decimals: z.number().int().min(0).max(6).optional(),
  /**
   * Description shown in the admin UI and woven into the planner prompt.
   * Cite domain pack ids verbatim when the metric framing comes from a
   * pack (e.g., `kpi-and-metric-glossary`). 1000 char cap.
   */
  description: z.string().max(1000).optional(),
  /** Whether the planner can use this metric. Disable for draft/internal metrics. */
  exposed: z.boolean().default(true),
  /** Origin: "auto" inferred, "user" admin-edited, "domain" from a domain pack. */
  source: z.enum(["auto", "user", "domain"]).default("auto"),
});

export type SemanticMetric = z.infer<typeof semanticMetricSchema>;

/**
 * A Dimension is a column projected as a queryable breakdown axis. Drives
 * `breakdownBy` in metric queries + the dashboard global filter picker's
 * type-appropriate UI (categorical / temporal / numeric_binned / geo).
 */
export const semanticDimensionSchema = z.object({
  name: z.string().min(1).max(80).regex(SNAKE_CASE),
  label: z.string().min(1).max(120),
  /** Underlying column the dimension projects from. */
  column: z.string().min(1).max(200),
  /** Semantic kind — drives filter UI + chart type recommendations. */
  kind: z.enum(["categorical", "temporal", "numeric_binned", "geo"]),
  /**
   * For `kind: "temporal"` — declared grain. Omit when the column supports
   * all grains (the agent already derives this via `temporalFacetColumns`).
   */
  temporalGrain: z
    .enum(["day", "week", "month", "quarter", "year"])
    .optional(),
  description: z.string().max(1000).optional(),
  exposed: z.boolean().default(true),
  source: z.enum(["auto", "user", "domain"]).default("auto"),
});

export type SemanticDimension = z.infer<typeof semanticDimensionSchema>;

/**
 * A multi-level dimension chain used for drill-down navigation
 * (e.g., Country → Region → City). Distinct from `dimensionHierarchy`
 * which represents in-column rollup totals.
 *
 * `levels` references dimension names (NOT columns) so the chain is
 * stable across column renames. Compiler (W58) resolves to columns via
 * the dimensions catalog.
 */
export const semanticHierarchySchema = z.object({
  name: z.string().min(1).max(80).regex(SNAKE_CASE),
  label: z.string().min(1).max(120),
  /** Ordered top→bottom; refer to `semanticDimensionSchema.name` values. */
  levels: z.array(z.string().min(1).max(80).regex(SNAKE_CASE)).min(2).max(8),
  description: z.string().max(500).optional(),
  source: z.enum(["auto", "user", "domain"]).default("auto"),
});

export type SemanticHierarchy = z.infer<typeof semanticHierarchySchema>;

/**
 * The semantic model for a session. Stored on `ChatDocument.semanticModel`
 * (added in W57). The compiler reads this; the planner sees it as a prompt
 * block (W59); the admin UI edits it (W61).
 */
export const semanticModelSchema = z.object({
  /** Bumped on every edit; used as the cache key for compiled queries (W64). */
  version: z.number().int().min(1).default(1),
  /** Free-text name shown in admin UI. */
  name: z.string().min(1).max(120).default("Default model"),
  metrics: z.array(semanticMetricSchema).max(200).default([]),
  dimensions: z.array(semanticDimensionSchema).max(200).default([]),
  hierarchies: z.array(semanticHierarchySchema).max(50).default([]),
  /** ISO timestamp of last edit (server-set). */
  updatedAt: z.string().max(40).optional(),
  /** Email of last editor (server-set). */
  updatedBy: z.string().max(200).optional(),
});

export type SemanticModel = z.infer<typeof semanticModelSchema>;

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

/**
 * Wave PAG1 · Pivot aggregator enum — mirrors the client `PivotAgg` union
 * at `client/src/lib/pivot/types.ts`. Re-exported through the shared schema
 * so the server can stamp the agent's aggregation function onto the message
 * envelope without manual sync. The client engine in `buildPivotModel.ts`
 * only implements these five operations; the agent-side `operation` enum is
 * richer (sum/mean/avg/count/min/max/median/percent_change/countIf/sumIf),
 * and the server-side mapper folds `avg → mean`, `sumIf → sum`, `countIf →
 * count`, and drops `median`/`percent_change` so the client default fires.
 */
export const pivotAggEnum = z.enum(["sum", "mean", "count", "min", "max"]);
export type PivotAggLiteral = z.infer<typeof pivotAggEnum>;

/**
 * Wave P1 · Cap for inline agent-result-row embedding on `pivotDefaults`.
 * When the agent's analytical step produces a non-scalar result with
 * `computedAggregations` (e.g. "AOV by region" → groupBy + ratio alias),
 * the pivot needs to render the computed alias columns — but the
 * interactive pivot pre-P1 re-queries the base `data` table where those
 * alias columns don't exist. P1 embeds the agent's result rows on the
 * message so the pivot operates on them directly. Capped to keep
 * persisted-message size sane (10 cols × 200 rows × ~30 bytes ≈ 60KB
 * worst case).
 */
export const PIVOT_AGENT_RESULT_MAX_ROWS = 200;

export const pivotDefaultsSchema = z.object({
  rows: z.array(z.string()).optional(),
  values: z.array(z.string()).optional(),
  /** Optional pivot Columns axis (non-numeric dimensions); engine uses first only when multiple. */
  columns: z.array(z.string()).optional(),
  /** Categorical fields in the pivot Filters well (slice dimensions not on rows/columns). */
  filterFields: z.array(z.string()).optional(),
  /** Initial slice selections (field → selected values); `in` filters only in v1. */
  filterSelections: z.record(z.array(z.string())).optional(),
  /**
   * Wave PAG1 · Per-value pivot aggregator hints derived from the agent's
   * `execute_query_plan.aggregations[]`. Keyed by source column name. When
   * present, the client uses this to pre-set the value chip aggregator
   * (e.g. Mean for an "average X per Y" question) instead of falling back
   * to the numeric-default Sum. Omitted entirely for filter-projection
   * plans (PVT1 invariant) and for unmapped operations like `median`.
   */
  valueAggregators: z.record(pivotAggEnum).optional(),
  /**
   * Wave P1 · Discriminator for the pivot data source.
   *   - `"base"` (or omitted): the pivot re-queries the base `data` table
   *     via DuckDB (today's default behaviour for every pivot).
   *   - `"agent_result"`: the pivot operates on `agentResultRows` embedded
   *     here. Used when the agent's analytical step produced a non-scalar
   *     result with computed-alias columns that don't exist on the base
   *     table. The pivot skips DuckDB and aggregates the embedded rows
   *     in-memory.
   */
  dataSource: z.enum(["base", "agent_result"]).optional(),
  /**
   * Wave P1 · Inline-embedded agent result rows for `dataSource:"agent_result"`.
   * Cap: `PIVOT_AGENT_RESULT_MAX_ROWS` (200) rows; the merger drops back
   * to base-table mode when the agent's result exceeds the cap.
   */
  agentResultRows: z.array(z.record(z.unknown())).optional(),
  /** Wave P1 · Column order for the embedded result (drives the pivot's available-fields list). */
  agentResultColumns: z.array(z.string()).optional(),
  /**
   * Wave V-PV1 · A frozen, context-derived display label for this pivot in the
   * sidebar (e.g. the question that produced it). The client shows it ahead of
   * the structural auto-name: `customName ?? contextLabel ?? pivotAutoName ?? Pivot N`.
   * A user rename (`customName`) always wins; this is never auto-overwritten.
   */
  contextLabel: z.string().max(120).optional(),
});
export type PivotDefaults = z.infer<typeof pivotDefaultsSchema>;

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

/**
 * W3 / W8 · structured AnswerEnvelope shape. Extracted as a named schema so
 * both `messageSchema` (Cosmos persistence) and `chatResponseSchema` (the
 * SSE wire shape returned by `validateAndEnrichResponse`) reference the
 * same definition. Without this, the SSE/persist pipeline would silently
 * strip the envelope at `chatResponseSchema.parse` (zod's default behavior
 * removes unknown keys), leaving the AnswerCard with nothing to render
 * during the active turn even though `runAgentTurn` produced one.
 *
 * Fields are individually optional — narrator may emit any subset, and the
 * synthesizer fallback path emits none. Renderers must preserve array
 * order. Caps are loose by design (WTL3) — the deterministic gates
 * enforce *presence*, not length.
 */
/**
 * W-SR1 · "Why this might be happening" — the quarantined, hedged causal lane.
 *
 * The measured layer (findings / implications / magnitudes) stays strictly
 * causation-free; plausible MECHANISMS live ONLY here, clearly separated and
 * labeled, so a reader never mistakes a hedged guess for a measured fact.
 *
 *   - `explanation` — the hedged "why" (the contract requires a hedge term and
 *     forbids a number inside it; the deterministic verifier rail enforces both).
 *   - `basis` — grounding source: "data" (a real dataset column supports it),
 *     "domain" (a cited FMCG/Marico pack), or "general" (world knowledge, e.g.
 *     "women-and-children-first"). `general` is permitted ONLY in this field.
 *   - `confidence` — clamped to what the basis can support: data→up to high,
 *     domain→up to medium, general→up to low. The clamp is a structural,
 *     unbypassable parse-time guard against confidence inflation (it normalizes
 *     DOWN, never rejects, so a single over-claim never nukes an answer).
 *   - `testable` — true when the data could (partly) confirm the mechanism.
 *
 * One shared definition reused by the narrator, synthesizer-fallback, message,
 * and dashboard envelopes — so a driver that parses on one parses on all
 * (no drift; L-019). Optional everywhere → old persisted messages validate.
 */
const LIKELY_DRIVER_MAX_CONFIDENCE = {
  data: "high",
  domain: "medium",
  general: "low",
} as const;
const LIKELY_DRIVER_CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

export const likelyDriverSchema = z
  .object({
    explanation: z.string().max(600),
    basis: z.enum(["data", "domain", "general"]),
    confidence: z.enum(["low", "medium", "high"]),
    testable: z.boolean().optional(),
  })
  .transform((d) => {
    const cap = LIKELY_DRIVER_MAX_CONFIDENCE[d.basis];
    return LIKELY_DRIVER_CONFIDENCE_RANK[d.confidence] >
      LIKELY_DRIVER_CONFIDENCE_RANK[cap]
      ? { ...d, confidence: cap }
      : d;
  });

export type LikelyDriver = z.infer<typeof likelyDriverSchema>;

export const likelyDriversSchema = z.array(likelyDriverSchema).max(5).optional();

export const messageAnswerEnvelopeSchema = z.object({
  tldr: z.string().max(600).optional(),
  findings: z
    .array(
      z.object({
        headline: z.string().max(400),
        evidence: z.string().max(3000),
        magnitude: z.string().max(160).optional(),
      })
    )
    .max(15)
    .optional(),
  methodology: z.string().max(3500).optional(),
  caveats: z.array(z.string().max(400)).max(10).optional(),
  nextSteps: z.array(z.string().max(400)).max(10).optional(),
  /**
   * W8 · "So what" reading of each headline finding. Each entry pairs the
   * observed `statement` with its business-meaning `soWhat`, framed using
   * the FMCG/Marico domain context when applicable. Optional confidence
   * lets the UI show a low/med/high pill.
   */
  implications: z
    .array(
      z.object({
        statement: z.string().max(600),
        soWhat: z.string().max(800),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(12)
    .optional(),
  /**
   * W8 · concrete recommended actions, grouped by horizon. Rendered as a
   * numbered list under headings ("Do now", "This quarter", "Strategic").
   *
   * IUX3 · `expectedImpact` is the manager-facing "what changes if we do this"
   * (e.g. "recover ~2pp metro share"). Optional + back-compat (older persisted
   * envelopes simply omit it). Named to mirror `businessActionItemSchema`.
   */
  recommendations: z
    .array(
      z.object({
        action: z.string().max(400),
        rationale: z.string().max(800),
        expectedImpact: z.string().max(240).optional(),
        horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
      })
    )
    .max(12)
    .optional(),
  /**
   * W8 · one-paragraph framing of the findings against FMCG/Marico domain
   * priors. Cite the pack id (e.g. `marico-haircare-portfolio`). Rendered
   * as an italic preamble pill above the body.
   */
  domainLens: z.string().max(2000).optional(),
  // W-SR1 · the hedged "Why this might be happening" causal lane (see
  // likelyDriversSchema). Optional → legacy persisted messages validate.
  likelyDrivers: likelyDriversSchema,
});

export type MessageAnswerEnvelope = z.infer<typeof messageAnswerEnvelopeSchema>;

/**
 * BAI1 · per-item shape for the post-verifier business action items. Extracted
 * as a named schema (mirrors the BAI2 extraction of `messageAnswerEnvelopeSchema`)
 * so `messageSchema.businessActions`, `chatResponseSchema.businessActions`, and
 * the dashboard schemas (DPF1) all reference one definition. Without a single
 * source of truth, drift between message-level and dashboard-level shapes
 * silently dropped fields at the spec → from-spec → Cosmos round-trip — exactly
 * the class of bug DPF1 closes for the four message-only dashboard fields.
 */
export const businessActionItemSchema = z.object({
  title: z.string().min(4).max(200),
  rationale: z.string().min(10).max(600),
  horizon: z.enum(["now", "this_quarter", "strategic"]),
  confidence: z.enum(["low", "medium", "high"]),
  dependencies: z.string().max(280).optional(),
  expectedImpact: z.string().max(200).optional(),
});

export type BusinessActionItem = z.infer<typeof businessActionItemSchema>;

/**
 * AMR1 · Pivot artifact captured during an agent turn. Each `execute_query_plan`
 * step that produced rows lands here so a future cache-hit (exact or semantic
 * ≥0.92, same dataVersion, same user) can restore the full pivot UI without
 * re-running the query. Aggregated rows are stored inline when small (≤2000
 * rows AND ≤200KB serialized) and offloaded to blob otherwise — the same
 * "Cosmos for hot metadata, blob for bulk" pattern the upload pipeline uses
 * via `blobStorage.uploadBufferToBlob`.
 *
 * The `plan` is intentionally `z.record(z.unknown())` (loose) for the same
 * reason `agentTrace` is loose: the strict `queryPlanBodySchema` lives in
 * `server/lib/queryPlanExecutor.ts` and can't be imported from this shared
 * boundary file. Runtime consumers re-validate when they replay the plan.
 *
 * Declared here (not next to `pastAnalysisDocSchema`) so it can also be
 * carried on the assistant `messageSchema` as a metadata-only ref on
 * cache-hit messages. Single source of truth, two consumers.
 */
export const PIVOT_INLINE_MAX_ROWS = 2000;
export const PIVOT_INLINE_MAX_BYTES = 200_000;

export const pastAnalysisPivotArtifactStorageInlineSchema = z.object({
  kind: z.literal("inline"),
  rows: z.array(z.record(z.unknown())),
});
export const pastAnalysisPivotArtifactStorageBlobSchema = z.object({
  kind: z.literal("blob"),
  blobName: z.string().min(1).max(400),
  bytes: z.number().int().nonnegative(),
});
export const pastAnalysisPivotArtifactStorageSchema = z.discriminatedUnion("kind", [
  pastAnalysisPivotArtifactStorageInlineSchema,
  pastAnalysisPivotArtifactStorageBlobSchema,
]);
export type PastAnalysisPivotArtifactStorage = z.infer<typeof pastAnalysisPivotArtifactStorageSchema>;

export const pastAnalysisPivotArtifactSchema = z.object({
  /** sha256(sessionId|turnId|stepId) — deterministic so replays/regenerates don't double-upload. */
  artifactId: z.string().min(1).max(128),
  /** Short narratorisable label for the pivot (e.g. "Top SKUs by Q3 value sales"). */
  questionContext: z.string().max(240).optional(),
  /** Loose — re-validated against `queryPlanBodySchema` at replay time. */
  plan: z.record(z.unknown()),
  pivotDefaults: pivotDefaultsSchema,
  columnHeaders: z.array(z.string()).max(64),
  rowCount: z.number().int().nonnegative(),
  storage: pastAnalysisPivotArtifactStorageSchema,
});
export type PastAnalysisPivotArtifact = z.infer<typeof pastAnalysisPivotArtifactSchema>;

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
  /**
   * Which spawned sub-questions were auto-investigated this turn (+ chart count).
   * Lets the persisted message flip the "Investigating further" chips to a green
   * "Investigated · N charts" badge on reload — otherwise that state is
   * live-SSE-only and vanishes when the turn ends.
   */
  investigatedSubQuestions: z
    .array(z.object({ id: z.string(), question: z.string(), chartCount: z.number() }))
    .max(16)
    .optional(),
  /** Agent synthesis CTAs; rendered as clickable follow-up chips (max 3). */
  followUpPrompts: z.array(z.string()).max(3).optional(),
  /** Phase-1: 2–4 numeric magnitudes that back the main claim. */
  magnitudes: z
    .array(
      z.object({
        label: z.string().max(200),
        value: z.string().max(120),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .optional(),
  /** Phase-1: one-line note on what the tools could not determine. */
  unexplained: z.string().max(1200).optional(),
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
  answerEnvelope: messageAnswerEnvelopeSchema.optional(),
  /**
   * Post-verifier business action items. Top-level on the message (not
   * nested in `answerEnvelope`) so rendering and persistence are decoupled
   * from the envelope-flow path. Populated by the `businessActionsAgent`
   * after the verifier returns `pass` AND at least 2 actions can be
   * grounded in the envelope's findings. Empty / absent means the agent
   * decided actions weren't warranted; the client renders no section.
   * Distinct from `answerEnvelope.recommendations` — those are analytical
   * next steps to run inside the app; these are decisions to act on
   * outside it.
   */
  businessActions: z.array(businessActionItemSchema).max(8).optional(),
  /** Set when this assistant message was produced by deterministic
   *  Automation replay (vs. a live agent turn). Drives the "↻ Automation"
   *  badge in MessageBubble. Optional + back-compat. */
  replayedFromAutomationId: z.string().max(200).optional(),
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
   * PVT5 · the agent ran an analytical step but the unified pivot-defaults
   * safety contract failed (e.g. > 4 axis fields, > 4 measures, or every
   * value field unresolvable to a base-table column). The chart and answer
   * are still correct; the client renders an elegant fallback explaining
   * the pivot couldn't be auto-generated for this query. Distinct from
   * `pivotDefaults` being absent — that just means no pivot was attempted.
   */
  pivotUnavailable: z.boolean().optional(),
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
  /**
   * AMR1 · Set when this assistant message was served from the
   * `past_analyses` cache (exact-match on normalizedQuestion or semantic
   * hit ≥0.92, same dataVersion + same user). Drives the
   * "Recalled from prior analysis" provenance chip and tells the client to
   * mount the full rich card (AnswerCard / BusinessActionsCard /
   * DataPreviewTable) using the rehydrated envelope + business actions +
   * pivot artifacts that ride alongside on the response payload.
   * Optional + back-compat — fresh agent turns leave it unset.
   */
  recalledFromPriorAnalysis: z
    .object({
      originalSessionId: z.string().max(200),
      originalTurnId: z.string().max(120),
      originalCreatedAt: z.number(),
      matchKind: z.enum(["exact", "semantic"]),
    })
    .optional(),
  /**
   * AMR1 · Metadata-only refs to the original turn's pivot artifacts.
   * Inline-stored artifacts include `rows`; blob-offloaded ones omit the
   * row data — the client fetches them on demand via the recall endpoint.
   * Populated only on cache-hit messages (paired with
   * `recalledFromPriorAnalysis`).
   */
  pivotArtifacts: z.array(pastAnalysisPivotArtifactSchema).max(12).optional(),
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
  // Sub-day grains (Wave H2). Computed on the fly; never materialized as facet columns.
  'hour',
  'hour_of_day',
  'minute',
  // Cyclical weekday facet — MATERIALIZED (pure-text "Monday"…"Sunday"), so the
  // "Day of week · X" column is real + filterable.
  'day_of_week',
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

// DUR1 · duration annotation for elapsed-time columns ("Working Hrs" =
// "03:31:57"). The column is STORED as a numeric measure in decimal hours so
// it averages/sums like any number; this annotation tells display layers to
// render it back as a duration ("3h 32m"). Distinct from `timeOfDay` (a clock
// reading kept as text).
export const columnDurationSchema = z.object({
  unit: z.literal("hours"),
  format: z.enum(["hm", "hms", "decimal"]).optional(),
});

export type ColumnDuration = z.infer<typeof columnDurationSchema>;

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

// Main-table detection metadata, populated at upload by the tableStructure
// detector when it scans the raw cell grid for the real header row / data
// bounds (handling title rows, junk, and multiple tables per sheet). All
// row/col fields are 0-based GRID indices (the reader maps them to 1-based
// sheet positions; the banner adds 1 for display). See `server/lib/tableStructure/`.
export const tableDetectionSchema = z.object({
  headerRowStart: z.number().int(),
  headerRowEnd: z.number().int(),
  dataRowStart: z.number().int(),
  dataRowEnd: z.number().int(),
  colStart: z.number().int(),
  colEnd: z.number().int(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400),
  source: z.enum(["tier1", "tier2", "fallback", "override"]),
  /** True when detection did something the user should verify — header not on
   * row 1, rows skipped, a side table ignored, or low confidence. Gates the
   * `TableDetectionBanner` (a clean sheet leaves this false and shows nothing). */
  nonTrivial: z.boolean(),
  secondaryTablesIgnored: z
    .array(
      z.object({
        rowStart: z.number().int(),
        rowEnd: z.number().int(),
        colStart: z.number().int(),
        colEnd: z.number().int(),
        reason: z.string().max(200),
      })
    )
    .max(16)
    .default([]),
  /** First ~30 rows × ~30 cols of the RAW grid (display text), so the
   * correction UI can show pre-header junk and let the user click the true
   * header row. Bounded so it rides the chat doc cheaply. */
  rawGridPreview: z.array(z.array(z.string())).optional(),
});

export type TableDetection = z.infer<typeof tableDetectionSchema>;

// User correction of a wrong detection, sent to POST /api/sessions/:id/retable.
// Only `headerRow` is required for v1; the rest default to "extend from the
// header to the natural bounds". All 0-based grid indices.
export const tableRegionOverrideSchema = z.object({
  headerRow: z.number().int().nonnegative(),
  dataRowStart: z.number().int().nonnegative().optional(),
  dataRowEnd: z.number().int().optional(),
  colStart: z.number().int().nonnegative().optional(),
  colEnd: z.number().int().nonnegative().optional(),
});

export type TableRegionOverride = z.infer<typeof tableRegionOverrideSchema>;

/**
 * SU-DT1 · A pairing between a time-of-day column (HH:MM:SS) and the date
 * column whose value carries the row's calendar date. Lets the planner
 * combine the two halves into a real datetime via add_computed_columns
 * (SU-DT2). Auto-detected at upload, overrideable by the user in chat
 * or via the SU-UX1 banner.
 */
export const dateTimeColumnPairSchema = z.object({
  timeColumn: z.string().min(1).max(200),
  dateColumn: z.string().min(1).max(200),
  source: z.enum(["auto", "user"]).default("auto"),
  description: z.string().max(500).optional(),
});

export type DateTimeColumnPair = z.infer<typeof dateTimeColumnPairSchema>;

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
    /** Wave T1 · post-parse date-range stats for a column classified as a
     * date. Populated at upload by `createDataSummary` over the full data,
     * not the 1000-row sample. Lets the planner pick a calibrated temporal
     * grain (Day vs Week vs Month vs Quarter) based on the dataset's actual
     * span. Only set on columns where `type === "date"` and at least one
     * cell parsed; absent on identifier-like / time-of-day / non-date
     * columns and on date columns whose cells all failed `parseFlexibleDate`. */
    dateRange: z
      .object({
        minIso: z.string(),
        maxIso: z.string(),
        distinctDayCount: z.number().int().nonnegative(),
        spanDays: z.number().int().nonnegative(),
        /** Wave H1 · 'sub_day' when the column carries ≥2 distinct non-midnight
         * times (intraday detail). The gate that lets the grain authority offer
         * an hour/minute/hour-of-day axis; absent/'day' ⇒ never sub-day. */
        temporalResolution: z.enum(["day", "sub_day"]).optional(),
        /** Distinct hours (0–23) observed — bounds the hour-of-day bucket count. */
        distinctHourCount: z.number().int().nonnegative().optional(),
      })
      .optional(),
    /** Currency tag for numeric columns whose cells carried a currency
     * symbol at parse time (e.g. "đ", "$", "R$"). See WF2/WF5. */
    currency: columnCurrencySchema.optional(),
    /** TOD1 · time-of-day columns (HH:MM:SS strings, no calendar date).
     * `sentinelValues` are non-time placeholder strings present in the column
     * (e.g. "Absent") that the planner must exclude from time comparisons. */
    timeOfDay: z
      .object({
        sentinelValues: z.array(z.string()).optional(),
      })
      .optional(),
    /** DUR1 · duration columns (elapsed-time, e.g. "Working Hrs" = "03:31:57").
     * Stored as a numeric measure in DECIMAL HOURS (so it averages/sums like
     * any number); this annotation tells the display layers to render it back
     * as a duration ("3h 32m"). Distinct from `timeOfDay`, which is a clock
     * reading kept as text. */
    duration: columnDurationSchema.optional(),
    /** SU-IC1 · structural classification for pre-computed "indicator"
     * columns — low-cardinality, boolean-like or shortlist-categorical
     * columns that directly answer common questions (e.g. "Clock-In <09:30"
     * with Yes/No/Absent). Set `kind` to "boolean" when the value set is
     * a Yes/No-shaped pair, "categorical" for short shortlists. The
     * positive/negative partition is filled by the SU-IC2 LLM enrichment
     * when the heuristic can't confidently disambiguate (e.g. "On"/"Off"). */
    indicator: z
      .object({
        kind: z.enum(["boolean", "categorical"]),
        positiveValues: z.array(z.string()).optional(),
        negativeValues: z.array(z.string()).optional(),
        sentinelValues: z.array(z.string()).optional(),
        source: z.enum(["auto", "llm", "user"]).default("auto"),
        /**
         * The metric's VALID MEASUREMENT UNIVERSE — the rows where this metric
         * is even applicable. Auto-inferred at upload (inferMetricApplicability):
         * a boolean indicator like "PJP Adherence" is only meaningful where
         * `PJP Planned Type ∈ ["Market Working"]`; off-days/absent rows are
         * structural zeros, not low scores. Rate steps AND these predicates into
         * numerator+denominator; degenerate breakdowns by `gateColumn` are
         * skipped; the headline scopes to this universe. Absent = no scoping.
         */
        applicabilityScope: z
          .array(
            z.object({
              gateColumn: z.string().max(200),
              inScopeValues: z.array(z.string().max(200)).max(48),
              rationale: z.string().max(300).optional(),
            })
          )
          .max(4)
          .optional(),
      })
      .optional(),
    /** SU-IC2 · natural-language phrasings the column directly answers
     * ("what % of staff clocked in before 9:30?"). Empty until the LLM
     * dataset-profile pass enriches the heuristic indicators. Capped at
     * 4 entries per column to keep the planner prompt compact. */
    answersQuestions: z.array(z.string().min(1).max(200)).max(4).optional(),
    /** W6 · metric-semantics tag stamped at enrichment by financeMetricAuthority.
     * `additivity` is the DURABLE answer to "may this column be SUMMED across a
     * dimension?" — the semantic model object isn't on the chart context, so this
     * is how the structured signal reaches processChartData (a non-additive column
     * is weighted-averaged/recomputed, never summed). `ratio*Column` name the
     * sibling parts so a ratio can be re-weighted by its denominator. See
     * docs/conventions/metric-additivity.md. */
    additivity: z.enum(["additive", "non_additive"]).optional(),
    additivityKind: z.enum(["additive", "ratio_percent", "per_unit", "index_score"]).optional(),
    ratioNumeratorColumn: z.string().max(200).optional(),
    ratioDenominatorColumn: z.string().max(200).optional(),
  })),
  numericColumns: z.array(z.string()),
  dateColumns: z.array(z.string()),
  /** Hidden __tf_* columns derived from dateColumns for coarse time group-bys */
  temporalFacetColumns: z.array(temporalFacetColumnMetaSchema).optional(),
  /** Set when the upload pipeline detected a wide-format input and
   * melted it to long form. See WF3/WF4/WF7. */
  wideFormatTransform: wideFormatTransformSchema.optional(),
  /** Set when the main-table detector found the real header/data bounds on a
   * messy sheet (title rows, junk, side tables). Sibling of
   * `wideFormatTransform`; surfaced by the `TableDetectionBanner`. */
  tableDetection: tableDetectionSchema.optional(),
  /** SU-DT1 · Pairings between time-of-day and date columns so the agent
   * can compose a combined datetime via add_computed_columns (SU-DT2). */
  dateTimeColumnPairs: z.array(dateTimeColumnPairSchema).max(20).optional(),
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
  /**
   * W7/W8 structured AnswerEnvelope. Same shape as `messageSchema.answerEnvelope`
   * (single source of truth: `messageAnswerEnvelopeSchema`). Including it on
   * the response schema keeps zod's default-strip from silently dropping the
   * envelope between `runAgentTurn` and the SSE / Cosmos-persist boundary —
   * without this, AnswerCard had nothing to render during the active turn
   * even though the agent loop produced a fully populated envelope.
   */
  answerEnvelope: messageAnswerEnvelopeSchema.optional(),
  /**
   * Top-level Business Action Items emitted by the post-verifier
   * `businessActionsAgent`. Round-trip through SSE so the client can render
   * them on the active turn (they are also patched onto the persisted
   * message later via `patchAssistantBusinessActions` for refresh).
   */
  businessActions: z.array(businessActionItemSchema).max(8).optional(),
  /** Phase-1 rich envelope — see messageSchema.magnitudes for details. */
  magnitudes: z
    .array(
      z.object({
        label: z.string().max(200),
        value: z.string().max(120),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .optional(),
  unexplained: z.string().max(1200).optional(),
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
  /**
   * AMR4 · cross-session recall provenance + rich payload. Set when the
   * response is served from the `past_analyses` cache (exact-match or
   * semantic ≥0.92, same dataVersion + same user). Drives the
   * "Recalled from prior analysis" provenance chip on the client and
   * tells `MessageBubble` to mount the full rich card (AnswerCard /
   * BusinessActionsCard / DataPreviewTable) using the rehydrated fields.
   * Absent on fresh agent turns.
   */
  recalledFromPriorAnalysis: z
    .object({
      originalSessionId: z.string().max(200),
      originalTurnId: z.string().max(120),
      originalCreatedAt: z.number(),
      matchKind: z.enum(["exact", "semantic"]),
    })
    .optional(),
  /**
   * AMR4 · pivot artifact metadata for a recalled (cache-hit) turn.
   * Inline-stored artifacts include `rows`; blob-offloaded ones omit them
   * (client fetches on demand via the AMR3c recall endpoint).
   */
  pivotArtifacts: z.array(pastAnalysisPivotArtifactSchema).max(12).optional(),
  /**
   * AMR4 · W13 investigation digest from the original turn — surfaces in
   * the InvestigationSummaryCard mount path on recalled cache-hits.
   */
  investigationSummary: investigationSummarySchema.optional(),
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
   * W6 · secondary KPI metrics for a MULTI-KPI dashboard. The dashboard charts
   * `outcomeMetricColumn` PLUS each of these by the key dimensions, so a "PJP
   * dashboard" surfaces adherence + compliance + attendance + punctuality, not
   * one metric. Populated deterministically (data-derived from the dataset's
   * boolean-indicator cluster) for indicator-centric dashboards; empty/absent
   * leaves the single-outcome behaviour unchanged.
   */
  outlineMetrics: z.array(z.string().max(200)).max(8).optional(),
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
// DPF1 · capacity caps raised to match `messageAnswerEnvelopeSchema` so the
// chat → dashboard round-trip no longer silently truncates findings,
// implications, recommendations, methodology, caveats, or domainLens. Caps
// only ever go up here; existing Cosmos docs and shorter outputs validate
// trivially. Lengthening is forward-compatible — see the WTL3 precedent on
// `messageAnswerEnvelopeSchema`.
export const dashboardAnswerEnvelopeSchema = z.object({
  tldr: z.string().max(600).optional(),
  findings: z
    .array(
      z.object({
        headline: z.string().max(400),
        evidence: z.string().max(3000),
        magnitude: z.string().max(160).optional(),
      })
    )
    .max(15)
    .optional(),
  implications: z
    .array(
      z.object({
        statement: z.string().max(600),
        soWhat: z.string().max(800),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(12)
    .optional(),
  recommendations: z
    .array(
      z.object({
        action: z.string().max(400),
        rationale: z.string().max(800),
        expectedImpact: z.string().max(240).optional(),
        horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
      })
    )
    .max(12)
    .optional(),
  methodology: z.string().max(3500).optional(),
  caveats: z.array(z.string().max(400)).max(10).optional(),
  domainLens: z.string().max(2000).optional(),
  // W-SR1 · the hedged causal lane MUST be declared here too — this is a
  // SEPARATE z.object from messageAnswerEnvelopeSchema and zod strips unknown
  // keys, so without this the chat→dashboard round-trip would silently lose the
  // drivers and the dashboard "Why" band (W-DX1) would never populate.
  likelyDrivers: likelyDriversSchema,
  magnitudes: z
    .array(
      z.object({
        label: z.string().max(200),
        value: z.string().max(160),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
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
  // Exclude specific category values (the inverse of `in`). Used by the off-day
  // "Apply to all charts" escalation to exclude a weekday session-wide on the
  // materialized "Day of week · X" column — chip reads "… excludes Sunday" and
  // is robust if new values appear (vs. enumerating every kept value).
  z.object({
    kind: z.literal("notIn"),
    column: z.string().min(1).max(200),
    values: z.array(z.string()).max(5000),
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

/**
 * MW4 · one below-org-average unit flagged for a manager's attention
 * (management-by-exception). Derived deterministically from the dashboard's
 * breakdown charts by computeAttentionAreas. Defined here (before both the
 * dashboard document and spec schemas that reference it).
 */
export const attentionAreaSchema = z.object({
  dimension: z.string().max(200),
  unit: z.string().max(200),
  metric: z.string().max(240),
  value: z.number(),
  benchmark: z.number(),
  variancePct: z.number(),
  status: z.enum(["red", "amber"]),
});
export type AttentionAreaSpec = z.infer<typeof attentionAreaSchema>;

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
  /**
   * DPF1 · message-mirroring fields so the dashboard captures everything
   * the user saw in chat. All optional + back-compat — pre-existing Cosmos
   * `Dashboard` documents parse unchanged.
   *
   * `businessActions` is patched in AFTER initial persistence (the post-
   * verifier `businessActionsAgent` resolves async, after the dashboard
   * auto-create has already fired) — see `patchDashboardBusinessActions`.
   * The other three are populated synchronously at auto-create time.
   */
  businessActions: z.array(businessActionItemSchema).max(8).optional(),
  followUpPrompts: z.array(z.string()).max(3).optional(),
  investigationSummary: investigationSummarySchema.optional(),
  priorInvestigationsSnapshot: z
    .array(priorInvestigationItemSchema)
    .max(5)
    .optional(),
  /** MW4 · management-by-exception attention areas (mirrors DashboardSpec). */
  attentionAreas: z.array(attentionAreaSchema).max(12).optional(),
  /**
   * Wave DR15 · Session this dashboard was created from. Optional —
   * existing Cosmos documents (and dashboards created via the bare
   * `POST /api/dashboards` "+ New" flow) parse cleanly without it.
   * Persisted only when a non-empty `sessionId` is supplied to the
   * `from-spec` / `from-analysis` create paths.
   *
   * Pre-DR15 the same value was passed into `createDashboardFromSpec`
   * but only used to stamp `chatDocument.lastCreatedDashboardId` for
   * agent follow-ups. There was no reverse link from a dashboard to
   * its source chat — dashboards were a dead-end for users wanting
   * to return to the analysis. This field carries that reverse link
   * so the dashboard surface can render an "Open chat" button.
   *
   * Note: dashboards SHARED with a user may carry a `sessionId` the
   * viewer cannot access. The client-side button is gated on
   * `!isShared` to avoid surfacing dead links.
   */
  sessionId: z.string().max(200).optional(),
  /**
   * Wave WR0 (incremental refresh) · provenance for a dashboard produced by a
   * data refresh ("Update data"). All optional + back-compat — existing Cosmos
   * documents parse unchanged.
   *
   * `dataRefreshSource` records the data-version transition + the chosen policy
   * + the "as of …" label; it is the field actually populated today (WR4
   * updates the dashboard IN PLACE — same id — so a refresh keeps the user on
   * the same URL; the data/answer history for rollback + compare lives on the
   * CHAT's `messageVersions`, not a second dashboard doc).
   *
   * `supersedesDashboardId` / `supersededByDashboardId` are RESERVED (currently
   * unpopulated): they exist for a possible future "keep a separate versioned
   * dashboard per refresh" mode. Kept optional so enabling that mode needs no
   * migration. Do not assume they are set when reading a refreshed dashboard.
   */
  dataRefreshSource: z
    .object({
      policy: z.enum(["replace", "append"]),
      fromDataVersion: z.number().optional(),
      toDataVersion: z.number().optional(),
      versionLabel: z.string().max(120).optional(),
      refreshedAt: z.number(),
    })
    .optional(),
  supersedesDashboardId: z.string().max(200).optional(),
  supersededByDashboardId: z.string().max(200).optional(),
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
  /**
   * Wave DR15 · optional source-session linkage. Mirrors the
   * `from-spec` request body. When supplied, persisted on the
   * resulting dashboard so the surface can render an "Open chat"
   * back-link.
   */
  sessionId: z.string().max(200).optional(),
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
  /**
   * DPF1 · message-mirroring fields. Round-trip from the agent's auto-create
   * (or the manual create-from-spec POST when the client augments the spec
   * with `message.*`) into the persisted `dashboard.*` of the same name.
   * `businessActions` is the exception — populated post-persist via the
   * BAI1-pattern patch helper (`patchDashboardBusinessActions`) since the
   * post-verifier `businessActionsAgent` resolves after auto-create has
   * already fired. All optional + back-compat.
   */
  businessActions: z.array(businessActionItemSchema).max(8).optional(),
  followUpPrompts: z.array(z.string()).max(3).optional(),
  investigationSummary: investigationSummarySchema.optional(),
  priorInvestigationsSnapshot: z
    .array(priorInvestigationItemSchema)
    .max(5)
    .optional(),
  /**
   * MW4 · management-by-exception. Below-org-average units derived
   * deterministically from the breakdown charts (computeAttentionAreas) so the
   * dashboard leads with the problem areas a manager should act on first.
   * Empty/absent = nothing flagged.
   */
  attentionAreas: z.array(attentionAreaSchema).max(12).optional(),
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
  // Wave C1 · editable Executive Summary band. The band's six card groups all
  // live on these two ALREADY-persisted top-level fields, so editing them is a
  // whole-field replace. MUST be `dashboardAnswerEnvelopeSchema` (NOT the
  // message variant) — that is the object the dashboard document persists; the
  // message schema is a SEPARATE z.object and zod would strip its extra keys
  // (magnitudes / likelyDrivers) on the round-trip. See lesson L-021.
  answerEnvelope: dashboardAnswerEnvelopeSchema.optional(),
  attentionAreas: z.array(attentionAreaSchema).max(12).optional(),
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

/**
 * Wave DR5 · atomic sheet reorder. Body carries the full ordered list of
 * sheet ids; the model rejects any submission whose id set does not
 * exactly match the dashboard's current sheets (no duplicates, no
 * missing, no extras).
 */
export const dashboardReorderSheetsRequestSchema = z.object({
  orderedSheetIds: z.array(z.string().min(1).max(200)).min(1).max(200),
});
export type DashboardReorderSheetsRequest = z.infer<
  typeof dashboardReorderSheetsRequestSchema
>;

