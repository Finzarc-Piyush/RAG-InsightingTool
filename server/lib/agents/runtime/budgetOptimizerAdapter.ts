/**
 * ============================================================================
 * budgetOptimizerAdapter.ts — turn the MMM budget optimiser's math into
 * human-readable recommendations / magnitudes / methodology text
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The "MMM" (Marketing-Mix Model) budget optimiser is a tool that, given how
 *   much a brand spent per channel (TV, digital, etc.) and the sales that
 *   resulted, computes the OPTIMAL way to re-split the same total budget to
 *   sell more. This file takes that raw numeric result and converts it into the
 *   exact display shapes the chat UI already knows how to render: a ranked list
 *   of "recommendations" (do X, because Y), short "magnitude" pills for the
 *   answer header (projected lift, biggest shift), and a one-paragraph
 *   methodology/caveats blurb ("domain lens").
 *
 * WHY IT MATTERS
 *   The narrator LLM is normally allowed to write recommendations itself, but
 *   for budget reallocation the NUMBERS must come from the optimiser, not from
 *   a model that might hallucinate. This adapter produces deterministic,
 *   math-backed text the caller uses to OVERRIDE the LLM's version — so spend
 *   deltas and projected lift the user sees are exactly what the model computed.
 *
 * KEY PIECES
 *   - isBudgetRedistributeOperationResult — type guard: is this op a budget result?
 *   - buildRecommendationsFromBudgetOptimizer — ranked per-channel actions (biggest reallocation first)
 *   - buildMagnitudesFromBudgetOptimizer — short header pills (lift, total held, biggest shift)
 *   - buildDomainLensFromBudgetOptimizer — methodology + caveats paragraph
 *
 * HOW IT CONNECTS
 *   Consumes a `BudgetRedistributeResponse` from `../../dataOps/mmmService.js`
 *   (the Python MMM service result). The agent loop calls these builders after
 *   the `run_budget_optimizer` tool runs and splices the output over the
 *   narrator's `answerEnvelope.{recommendations,magnitudes,domainLens}`.
 */
import type { BudgetRedistributeResponse } from "../../dataOps/mmmService.js";
import { formatCompactNumber } from "../../formatCompactNumber.js";

export interface NarratorRecommendation {
  action: string;
  rationale: string;
  horizon?: "now" | "this_quarter" | "strategic";
}

export interface AnswerMagnitude {
  label: string;
  value: string;
  confidence?: "low" | "medium" | "high";
}

export interface BudgetOptimizerOperationResult {
  kind: "budget_redistribute";
  payload: BudgetRedistributeResponse;
}

export function isBudgetRedistributeOperationResult(
  op: unknown
): op is BudgetOptimizerOperationResult {
  return (
    !!op &&
    typeof op === "object" &&
    (op as { kind?: unknown }).kind === "budget_redistribute" &&
    !!(op as { payload?: unknown }).payload
  );
}

const MAX_RECOMMENDATIONS = 4;

/**
 * Build deterministic recommendations from the optimizer payload.
 *
 * Strategy: rank channels by absolute delta (largest reallocation first). Skip
 * channels where the delta is below a meaningful threshold (≤2% of current
 * spend AND <5% of total budget). Always lead with a headline action that
 * states the projected lift; channel-level actions follow.
 */
export function buildRecommendationsFromBudgetOptimizer(
  r: BudgetRedistributeResponse
): NarratorRecommendation[] {
  const out: NarratorRecommendation[] = [];
  const totalBudget = r.total_budget_used || 1;
  const ranked = [...r.channels]
    .map((c) => ({
      ...c,
      absDelta: Math.abs(c.optimal_total_spend - c.current_total_spend),
      delta: c.optimal_total_spend - c.current_total_spend,
    }))
    .sort((a, b) => b.absDelta - a.absDelta);

  const meaningful = ranked.filter(
    (c) =>
      c.absDelta / totalBudget >= 0.005 ||
      Math.abs(c.delta_pct) >= 2
  );

  if (r.projected_lift_pct >= 0.5) {
    out.push({
      action: `Reallocate to the optimal mix to lift outcome by ${r.projected_lift_pct.toFixed(1)}%`,
      rationale: `Constrained SLSQP on a fitted MMM (R²=${r.fit_metrics.r_squared.toFixed(2)}, n=${r.fit_metrics.n_observations} weeks) projects this lift while holding total budget at ${formatMoney(totalBudget)}.`,
      horizon: "now",
    });
  }

  for (const c of meaningful.slice(0, MAX_RECOMMENDATIONS - out.length)) {
    const direction = c.delta >= 0 ? "Increase" : "Decrease";
    const magnitude = formatMoney(c.absDelta);
    const pct = `${c.delta >= 0 ? "+" : ""}${c.delta_pct.toFixed(1)}%`;
    const elasticity = c.elasticity.toFixed(3);
    const ciLo = c.elasticity_ci95[0].toFixed(3);
    const ciHi = c.elasticity_ci95[1].toFixed(3);
    out.push({
      action: `${direction} ${c.name} by ${magnitude} (${pct}) — to ${formatMoney(c.optimal_total_spend)}`,
      rationale: `Elasticity ${elasticity} (CI95 [${ciLo}, ${ciHi}]). ${
        c.delta >= 0
          ? "Marginal ROI is highest among current channels."
          : "Diminishing returns at current spend levels — capital is better deployed elsewhere."
      }`,
      horizon: "now",
    });
  }

  return out.slice(0, MAX_RECOMMENDATIONS);
}

/**
 * Build short magnitude pills for the Message header. We surface the lift,
 * total budget held constant, and the single biggest reallocation. The
 * narrator's LLM-produced magnitudes are still allowed; we only prepend.
 */
export function buildMagnitudesFromBudgetOptimizer(
  r: BudgetRedistributeResponse
): AnswerMagnitude[] {
  const top = [...r.channels].sort(
    (a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct)
  )[0];
  const out: AnswerMagnitude[] = [
    {
      label: "Projected lift",
      value: `${r.projected_lift_pct.toFixed(1)}%`,
      confidence: confidenceFromCaveats(r),
    },
    {
      label: "Total budget held",
      value: formatMoney(r.total_budget_used),
      confidence: "high",
    },
  ];
  if (top) {
    out.push({
      label: `Biggest shift · ${top.name}`,
      value: `${top.delta_pct >= 0 ? "+" : ""}${top.delta_pct.toFixed(1)}%`,
      confidence: confidenceFromCaveats(r),
    });
  }
  return out.slice(0, 6);
}

/**
 * One-paragraph framing that explains methodology + caveats. Used to seed
 * answerEnvelope.domainLens when the narrator's LLM-produced lens is empty.
 */
export function buildDomainLensFromBudgetOptimizer(
  r: BudgetRedistributeResponse
): string {
  const caveats = r.model_caveats.length ? ` Caveats: ${r.model_caveats.join(", ")}.` : "";
  return [
    `Marketing-mix model: geometric adstock + Hill saturation + ridge regression on weekly spend × outcome × time, with a constrained SLSQP optimizer over the fitted response surface (R²=${r.fit_metrics.r_squared.toFixed(2)}, n=${r.fit_metrics.n_observations} weeks).`,
    `Bounds limited to ${0.5}×–${2.0}× current per-channel spend by default — the optimizer cannot extrapolate beyond observed ranges.${caveats}`,
  ].join(" ");
}

function confidenceFromCaveats(
  r: BudgetRedistributeResponse
): "low" | "medium" | "high" {
  const caveats = r.model_caveats;
  if (caveats.includes("low_confidence_short_history") || caveats.includes("weak_fit_low_r2")) {
    return "low";
  }
  if (caveats.includes("confounded_elasticities_multicollinearity")) return "medium";
  if (r.fit_metrics.r_squared >= 0.7) return "high";
  return "medium";
}

// Compact magnitude formatting is owned by the shared authority
// (formatCompactNumber) — uppercase K (this module previously emitted a
// lowercase "k"), magnitude-appropriate decimals, native negative handling.
function formatMoney(x: number): string {
  return formatCompactNumber(x);
}
