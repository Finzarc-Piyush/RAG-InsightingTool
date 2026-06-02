/**
 * ============================================================================
 * dashboardIntent.ts — decide if a turn should produce a dashboard
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Classifies, with no AI, whether the user wants a dashboard from this turn.
 *   ("Deterministic" = pure rules, same input → same answer.) Three outcomes:
 *     - "auto_create": the user explicitly asked (regex matched their words) OR
 *       the brief LLM flagged it → server builds AND saves it; client navigates.
 *     - "offer": the turn made several charts (>= 3) but no one asked → server
 *       builds the spec but does NOT save; client shows a "Build Dashboard"
 *       button the user can click.
 *     - "none": single-chart or no-chart turn → nothing happens.
 *
 * WHY IT MATTERS
 *   Regex-first means the feature still works even if the brief LLM forgets to
 *   set its flag — the explicit phrasing alone is enough to trigger a build.
 *
 * KEY PIECES
 *   - DashboardIntent — the "auto_create" | "offer" | "none" result type.
 *   - EXPLICIT_RX — regex matching "build me a dashboard / report / ..." phrasing.
 *   - MULTI_CHART_OFFER_THRESHOLD — the >= 3 charts cutoff for "offer".
 *   - classifyDashboardIntent(args) — returns the intent for the turn.
 *
 * HOW IT CONNECTS
 *   Output feeds dashboardAutogenGate.ts (dashboardBuildDecision), which turns
 *   the intent into build/persist booleans inside the agent loop.
 */

/**
 * Deterministic dashboard intent classifier. See header above for the three
 * tracks (auto_create / offer / none) and why regex comes first.
 */

export type DashboardIntent = "auto_create" | "offer" | "none";

/**
 * Matches phrases like:
 *   "build me a dashboard", "create a sales report", "make this a monitoring view",
 *   "turn into a dashboard", "give me an executive summary".
 *
 * The verb and the noun must be within 40 chars on the same line. Word
 * boundaries on both ends prevent matches inside other words.
 */
export const EXPLICIT_RX =
  /\b(build|create|make|generate|design|put together|turn(?: this)? into|give me|show me|i (?:want|need))\b[\s\S]{0,40}\b(dashboard|report|monitoring view|executive summary)\b/i;

export const MULTI_CHART_OFFER_THRESHOLD = 3;

export function classifyDashboardIntent(args: {
  question: string;
  chartCount: number;
  brief?: { requestsDashboard?: boolean };
}): DashboardIntent {
  if (EXPLICIT_RX.test(args.question)) return "auto_create";
  if (args.brief?.requestsDashboard === true) return "auto_create";
  if (args.chartCount >= MULTI_CHART_OFFER_THRESHOLD) return "offer";
  return "none";
}
