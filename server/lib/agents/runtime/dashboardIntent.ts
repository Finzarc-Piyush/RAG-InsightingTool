/**
 * Deterministic dashboard intent classifier.
 *
 * Two tracks:
 *   - "auto_create": user explicitly asks (regex match) OR brief LLM set
 *     `requestsDashboard=true`. Server builds + persists; client auto-navigates.
 *   - "offer": multi-chart turn (>= 3 charts) without an explicit ask. Server
 *     builds the spec but does NOT persist; client renders a "Build Dashboard"
 *     button the user can click.
 *   - "none": single-chart / no-chart turn. Nothing emitted.
 *
 * Regex-first so the feature does not silently no-op when the brief LLM forgets
 * to set the flag. Brief LLM remains a backup signal.
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
