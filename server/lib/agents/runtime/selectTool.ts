/**
 * Wave WT6 · `selectTool` — pure planner tool-router helper.
 *
 * Maps a question intent + lightweight dataset hints onto an ordered
 * list of tool recommendations with rationale. Closes the "tool router
 * upgrade" item from Workstream 5 of the [1000x master
 * plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md): give the planner a
 * deterministic starting recommendation instead of leaving the
 * `run_analytical_query` vs `execute_query_plan` choice to LLM intuition.
 *
 * This wave ships the **pure mapper**. The wiring that surfaces the
 * recommendation in the planner system prompt + tool manifest belongs
 * to a follow-up wave (touches [planner.ts](server/lib/agents/runtime/planner.ts)
 * which is integration-point code, deserves its own atomic isolation).
 *
 * Design:
 *  - Intent is a small enum the helper itself defines. The upstream
 *    classifier (analysisBrief, questionShape) can map its richer shape
 *    set onto this enum; the helper stays stable across classifier
 *    evolution.
 *  - Dataset hints are a small struct of booleans — the helper does
 *    NOT inspect actual dataset content. Just enough to disambiguate
 *    `cohort` from `ranking` when both could apply.
 *  - Output is ORDERED — the planner is told to prefer the first
 *    recommendation; subsequent entries are fallbacks. Each entry
 *    carries a `rationale` string suitable for surfacing in the
 *    `flow_decision` SSE row when the planner deviates.
 */

export type AnalystIntent =
  | "cohort_retention"
  | "rfm_segmentation"
  | "market_basket"
  | "price_elasticity"
  | "ranking"
  | "trend"
  | "comparison"
  | "drill_down"
  | "anomaly"
  | "forecast"
  | "fact_check"
  | "growth"
  | "seasonality"
  | "correlation"
  | "general_analytical";

export interface DatasetHints {
  /** Dataset has a transaction/basket identifier column. */
  hasTransactions?: boolean;
  /** Dataset has price-like and quantity-like numeric columns. */
  hasPriceQuantity?: boolean;
  /** Dataset has an entity column (customer / store / SKU id). */
  hasEntities?: boolean;
  /** Dataset has a temporal column. */
  hasTemporal?: boolean;
  /** Dataset has multi-level categorical hierarchies. */
  hasHierarchy?: boolean;
  /** Dataset has a numeric metric column. */
  hasNumericMetric?: boolean;
  /** Whether the upstream filter detector found external-claim markers
   *  (typically populated by WQ2's externalClaimDetector). */
  hasExternalClaimMarkers?: boolean;
}

export type RecommendationConfidence = "high" | "medium" | "low";

export interface ToolRecommendation {
  /** Tool name as registered in `registerTools.ts`. */
  toolName: string;
  /** One-line rationale suitable for `flow_decision` SSE payloads. */
  rationale: string;
  /** How confident the helper is that this tool is the best pick. */
  confidence: RecommendationConfidence;
}

/** Tool catalogue keyed by canonical tool name — kept in sync with
 *  `registerTools.ts` manually. Adding a new tool requires adding an
 *  entry here only if it's a candidate for the router. */
const TOOL_RATIONALES: Record<string, string> = {
  run_cohort_analysis:
    "Build a cohort × period-offset retention matrix.",
  run_rfm_segmentation:
    "Score entities on Recency / Frequency / Monetary with canonical segment labels.",
  run_market_basket:
    "Mine 1-LHS association rules (antecedent → consequent) with support / confidence / lift.",
  run_price_elasticity:
    "Fit a log-log OLS regression for price-quantity elasticity.",
  run_hierarchical_drill:
    "Roll a high-cardinality dimension into top-N + Other for readable breakdowns.",
  run_breakdown_ranking:
    "Rank groups by a metric (top-N / bottom-N) with optional composite ranking.",
  compute_growth:
    "Compute period-over-period growth (YoY / QoQ / MoM / WoW).",
  detect_seasonality:
    "Detect within-year recurring seasonality (month / quarter of year).",
  run_forecast:
    "Project a time series forward with trend and optional seasonality.",
  run_anomaly_detection:
    "Surface outliers via IQR + z-score on a numeric series.",
  run_correlation:
    "Compute pairwise correlations across numeric columns.",
  web_search:
    "Fetch external context for claims the dataset alone cannot answer.",
  execute_query_plan:
    "Execute a structured query plan (DuckDB) with named aggregations + filters.",
  run_analytical_query:
    "Run an ad-hoc SQL query when no structured tool applies.",
  run_significance_test:
    "Run a statistical significance test (Welch's t / paired t / χ²).",
  run_two_segment_compare:
    "Compare two segments on a metric with magnitude + significance.",
};

/** The mapping table itself. Each intent maps to an ordered list of
 *  candidate tool names. The pure mapper layers dataset-hint
 *  disambiguation on top (e.g., cohort requires entity + temporal). */
const INTENT_TO_TOOLS: Record<AnalystIntent, string[]> = {
  cohort_retention: ["run_cohort_analysis", "execute_query_plan"],
  rfm_segmentation: ["run_rfm_segmentation", "execute_query_plan"],
  market_basket: ["run_market_basket", "execute_query_plan"],
  price_elasticity: ["run_price_elasticity", "run_correlation"],
  ranking: ["run_breakdown_ranking", "run_hierarchical_drill", "execute_query_plan"],
  trend: ["compute_growth", "detect_seasonality", "execute_query_plan"],
  comparison: ["run_two_segment_compare", "run_significance_test", "execute_query_plan"],
  drill_down: ["run_hierarchical_drill", "execute_query_plan"],
  anomaly: ["run_anomaly_detection", "run_correlation"],
  forecast: ["run_forecast", "compute_growth"],
  fact_check: ["web_search"],
  growth: ["compute_growth", "execute_query_plan"],
  seasonality: ["detect_seasonality", "compute_growth"],
  correlation: ["run_correlation", "run_significance_test"],
  general_analytical: ["execute_query_plan", "run_analytical_query"],
};

/** Hint-based filter: drop tools that require a dataset capability
 *  the caller's hints say is absent. Conservative — when a hint is
 *  undefined we assume "maybe present" and keep the tool. */
function toolPassesHints(toolName: string, hints: DatasetHints): boolean {
  switch (toolName) {
    case "run_cohort_analysis":
      return hints.hasEntities !== false && hints.hasTemporal !== false;
    case "run_rfm_segmentation":
      return (
        hints.hasEntities !== false &&
        hints.hasTemporal !== false &&
        hints.hasNumericMetric !== false
      );
    case "run_market_basket":
      return hints.hasTransactions !== false;
    case "run_price_elasticity":
      return hints.hasPriceQuantity !== false;
    case "compute_growth":
    case "detect_seasonality":
    case "run_forecast":
      return hints.hasTemporal !== false;
    case "run_hierarchical_drill":
      return hints.hasHierarchy !== false || hints.hasNumericMetric !== false;
    default:
      return true;
  }
}

/** Confidence ladder: the first recommendation gets `high` IFF it
 *  passes all relevant hints; otherwise `medium`. Fallbacks always
 *  `medium` or `low`. */
function pickConfidence(
  toolName: string,
  hints: DatasetHints,
  position: number,
): RecommendationConfidence {
  if (position === 0) {
    return toolPassesHints(toolName, hints) ? "high" : "medium";
  }
  if (position === 1) return "medium";
  return "low";
}

/** The public mapper. */
export function selectTool(
  intent: AnalystIntent,
  hints: DatasetHints = {},
): ToolRecommendation[] {
  const candidates = INTENT_TO_TOOLS[intent] ?? [];
  // Filter by hints first, but always keep at least the last fallback
  // so the planner has SOMETHING to lean on.
  const filtered = candidates.filter((t) => toolPassesHints(t, hints));
  const effective = filtered.length > 0 ? filtered : candidates;

  return effective.map((toolName, position) => ({
    toolName,
    rationale: TOOL_RATIONALES[toolName] ?? `Tool '${toolName}' is the canonical pick for ${intent}.`,
    confidence: pickConfidence(toolName, hints, position),
  }));
}

/** Optional helper: render a compact prompt-block summary the planner
 *  can paste into its system message. */
export function renderToolRouterPromptBlock(
  recommendations: ToolRecommendation[],
): string {
  if (recommendations.length === 0) return "No tool router recommendation.";
  const lines = recommendations.map(
    (r, i) =>
      `  ${i + 1}. ${r.toolName} (${r.confidence}) — ${r.rationale}`,
  );
  return [
    "Tool router recommends (in priority order):",
    ...lines,
    "Prefer the first recommendation unless the question's specifics rule it out — record the rationale for deviation.",
  ].join("\n");
}

/** Inspect the full intent table — useful for tests + introspection. */
export function listSupportedIntents(): AnalystIntent[] {
  return Object.keys(INTENT_TO_TOOLS) as AnalystIntent[];
}
