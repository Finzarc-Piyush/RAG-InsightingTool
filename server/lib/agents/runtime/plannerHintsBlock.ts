/**
 * ============================================================================
 * plannerHintsBlock.ts — assemble the deterministic hint block injected into
 * the planner's prompt
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This is the glue that wires three pure helpers into the planner's prompt.
 *   From the user question + analysis brief + dataset summary it builds ONE
 *   compact text block the planner's user message appends, containing, in order:
 *     1. TOOL_ROUTER_HINT — ranked tool suggestions (from selectTool.ts), based
 *        on an intent it infers from the question text + brief.
 *     2. EXTERNAL_CLAIM_MARKERS — when the question mentions things the dataset
 *        alone can't answer (competitor share, market size, etc.), a note
 *        telling the planner to add a `web_search` step.
 *   It also exports a static one-line "confidence directive" that is added to
 *   the planner's SYSTEM message to nudge it toward tools that emit statistical
 *   evidence (n / p-value / R² / CI width).
 *
 * WHY IT MATTERS
 *   It centralises planner prompt-hint construction so `planner.ts` stays the
 *   single integration point. Without it those helpers would exist but nothing
 *   in the planner path would read them, and the planner would lose its
 *   deterministic tool steer and its prompt to fetch external context.
 *
 * KEY PIECES
 *   - buildPlannerHintsBlock — main: returns { block, intent, topRecommendation, hasExternalClaim }
 *   - inferAnalystIntent — map question text (regex rules) + brief shape onto an AnalystIntent
 *   - buildDatasetHints — derive boolean dataset hints from column names (no row scanning)
 *   - PLANNER_CONFIDENCE_DIRECTIVE — static system-prompt line favouring statistical tools
 *
 * HOW IT CONNECTS
 *   Pure (question + summary + brief in, string out). Calls `selectTool` /
 *   `renderToolRouterPromptBlock` (selectTool.ts) and `detectExternalClaims` /
 *   `summarizeExternalClaims` (utils/externalClaimDetector.js). Consumed by
 *   `planner.ts`, which concatenates `block` after the question line.
 */

import type { AnalysisBrief, DataSummary, QuestionShape } from "../../../shared/schema.js";
import {
  detectExternalClaims,
  summarizeExternalClaims,
  type ExternalClaimReport,
} from "./utils/externalClaimDetector.js";
import {
  renderToolRouterPromptBlock,
  selectTool,
  type AnalystIntent,
  type DatasetHints,
  type ToolRecommendation,
} from "./selectTool.js";

/**
 * Static directive describing the downstream narrator confidence-tier
 * classifier. Concatenated into the planner SYSTEM message (not the per-question
 * user block) by `planner.ts`. Keeps system-prompt drift bounded while
 * signalling that statistical evidence buys narrator confidence (and prose
 * budget).
 */
export const PLANNER_CONFIDENCE_DIRECTIVE =
  "- WQ1 · downstream narrator hedges findings by statistical confidence (n / p-value / R² / CI width). When the question's payoff justifies it, prefer tools that emit those fields (run_significance_test, run_two_segment_compare, run_correlation with R², run_price_elasticity) over point-estimate-only paths so the narrator can cite \"high-confidence\" rather than defaulting to \"medium\".";

/**
 * Map `analysisBrief.questionShape` (7 values) onto the `selectTool`
 * AnalystIntent enum (15 values). Conservative — the question-text classifier
 * below refines into the more specific intents (cohort / rfm / basket / etc.).
 */
const SHAPE_TO_INTENT: Record<QuestionShape, AnalystIntent> = {
  driver_discovery: "correlation",
  variance_diagnostic: "drill_down",
  trend: "trend",
  comparison: "comparison",
  exploration: "general_analytical",
  descriptive: "ranking",
  budget_reallocation: "general_analytical",
};

/**
 * Question-text regex catalogue. Each rule lists a high-confidence intent
 * and the patterns that fire it. Evaluated in declaration order; first
 * match wins. Patterns are word-boundary anchored + case-insensitive.
 */
const QUESTION_INTENT_RULES: { intent: AnalystIntent; pattern: RegExp }[] = [
  { intent: "cohort_retention", pattern: /\bcohort\b|\bretention\b|\bchurn\b/i },
  { intent: "rfm_segmentation", pattern: /\brfm\b|\brecency,?\s+frequency/i },
  {
    intent: "market_basket",
    pattern: /\bmarket\s+basket\b|\bcross[-\s]?sell\b|\bup[-\s]?sell\b|\bbought\s+together\b|\bassociation\s+rule/i,
  },
  { intent: "price_elasticity", pattern: /\belasticit/i },
  { intent: "forecast", pattern: /\bforecast\b|\bproject(?:ion|ed)?\b|\bpredict(?:ion|ed|s)?\b/i },
  { intent: "anomaly", pattern: /\banomal/i },
  { intent: "seasonality", pattern: /\bseasonalit/i },
  {
    intent: "growth",
    pattern: /\bgrowth\b|\bgrew\b|\bgrowing\b|\byoy\b|\bqoq\b|\bmom\b|\bwow\b/i,
  },
  { intent: "drill_down", pattern: /\bdrill[-\s]?down\b|\bbreak(?:down)?\s+by\b/i },
  {
    intent: "ranking",
    pattern: /\btop\s+\d|\bbottom\s+\d|\branking\b|\bleaderboard\b|\bhighest\b|\blowest\b|\bbest\s+performing\b|\bworst\s+performing\b/i,
  },
  { intent: "trend", pattern: /\btrend\b|\bover\s+time\b|\bevolv/i },
  { intent: "comparison", pattern: /\bcompare\b|\b\s+vs\.?\s+\b|\bversus\b/i },
];

/** Infer the most specific AnalystIntent supported by the tool router. */
export function inferAnalystIntent(
  question: string,
  analysisBrief?: AnalysisBrief,
): AnalystIntent {
  const q = (question ?? "").trim();
  if (q) {
    for (const rule of QUESTION_INTENT_RULES) {
      if (rule.pattern.test(q)) return rule.intent;
    }
  }
  const shape = analysisBrief?.questionShape;
  if (shape && shape in SHAPE_TO_INTENT) return SHAPE_TO_INTENT[shape];
  return "general_analytical";
}

/** Heuristic check: does any column name match one of the given patterns? */
function anyColumnMatches(
  columns: readonly { name: string }[],
  patterns: RegExp[],
): boolean {
  for (const col of columns) {
    for (const p of patterns) {
      if (p.test(col.name)) return true;
    }
  }
  return false;
}

/**
 * Build the `DatasetHints` struct `selectTool` consumes. Conservative —
 * undefined hints fall through as "maybe present" so the router doesn't
 * over-filter. The detector ONLY inspects column names + the summary's
 * `numericColumns` / `dateColumns` arrays; it does not scan row content.
 */
export function buildDatasetHints(
  summary: DataSummary | undefined,
  claimReport?: ExternalClaimReport,
): DatasetHints {
  if (!summary) {
    return {
      hasExternalClaimMarkers: claimReport?.hasExternalClaim ?? false,
    };
  }
  const cols = summary.columns ?? [];
  const numericColumns = summary.numericColumns ?? [];
  const dateColumns = summary.dateColumns ?? [];
  return {
    hasTransactions: anyColumnMatches(cols, [
      /transaction/i,
      /\border\s*(id|number|no)\b/i,
      /\binvoice\b/i,
      /\breceipt\b/i,
      /\bbasket\b/i,
    ]),
    hasPriceQuantity:
      anyColumnMatches(cols, [/\bprice\b|\bunit\s*price\b|\brate\b/i]) &&
      anyColumnMatches(cols, [/\bquantity\b|\bqty\b|\bunits?\b/i]),
    hasEntities: anyColumnMatches(cols, [
      /\bcustomer\b/i,
      /\buser(_?id)?\b/i,
      /\baccount\b/i,
      /\bstore\b/i,
      /\bsku\b/i,
      /\bproduct(_?id|_?code)?\b/i,
    ]),
    hasTemporal: dateColumns.length > 0,
    hasHierarchy:
      anyColumnMatches(cols, [/\bregion\b/i]) &&
      anyColumnMatches(cols, [/\b(state|district|city|zone)\b/i]),
    hasNumericMetric: numericColumns.length > 0,
    hasExternalClaimMarkers: claimReport?.hasExternalClaim ?? false,
  };
}

export interface PlannerHintsBlockResult {
  /** Combined prompt block (empty when no signal at all). */
  block: string;
  /** Diagnostic: the intent the router resolved. */
  intent: AnalystIntent;
  /** Diagnostic: top-of-list recommendation, or null when intent has none. */
  topRecommendation: ToolRecommendation | null;
  /** Diagnostic: whether the external-claim detector fired. */
  hasExternalClaim: boolean;
}

/**
 * Build the full planner user-prompt hints block. Returns an empty `block`
 * when neither helper produced signal (no router suggestion + no claims).
 * The caller — `planner.ts` — concatenates `block` into the user message
 * directly after the question line. `intent` / `topRecommendation` /
 * `hasExternalClaim` are surfaced for logging / `flow_decision` SSE rows.
 */
export function buildPlannerHintsBlock(
  question: string,
  summary?: DataSummary,
  analysisBrief?: AnalysisBrief,
): PlannerHintsBlockResult {
  const claimReport = detectExternalClaims(question ?? "");
  const intent = inferAnalystIntent(question ?? "", analysisBrief);
  const hints = buildDatasetHints(summary, claimReport);
  const recommendations = selectTool(intent, hints);

  const routerBlock =
    recommendations.length > 0
      ? `### TOOL_ROUTER_HINT (analyst-intent → ranked tools; deterministic, follow unless the question's specifics rule it out)\nIntent: ${intent}\n${renderToolRouterPromptBlock(recommendations)}`
      : "";

  let claimBlock = "";
  if (claimReport.hasExternalClaim) {
    const summary = summarizeExternalClaims(claimReport);
    const excerpts = claimReport.claims
      .slice(0, 4)
      .map((c) => `  - ${c.type} (${c.confidence}): "${c.excerpt}"`)
      .join("\n");
    claimBlock = [
      "### EXTERNAL_CLAIM_MARKERS (question references external claims the dataset alone cannot answer)",
      summary.promptLine,
      excerpts,
      "Add a `web_search` step before synthesis so the narrator can ground these claims.",
    ].join("\n");
  }

  const parts = [routerBlock, claimBlock].filter((p) => p.length > 0);
  const block = parts.length > 0 ? `${parts.join("\n\n")}\n\n` : "";

  return {
    block,
    intent,
    topRecommendation: recommendations[0] ?? null,
    hasExternalClaim: claimReport.hasExternalClaim,
  };
}
