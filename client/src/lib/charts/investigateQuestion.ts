/**
 * investigateQuestion.ts — build the "Investigate further" deep-dive prompt for
 * a chart.
 *
 * Clicking "Investigate further" on a chart should NOT just restate what the
 * chart already shows — the user asked for "deeper analyses and more actionable
 * insights instead of plain observations." So the posted question is phrased to
 * be DIAGNOSTIC + STRATEGIC, which `queryIntentAuthority.classifyQueryIntent`
 * (server) maps to a `full` depth budget: the agent runs the complete loop,
 * reaches for causal tools (drivers / decomposition), and emits business
 * actions — rather than a shallow lookup.
 *
 * Pure + framework-free so it is unit-testable and reusable from any surface.
 */

/** The minimal chart shape we read — a loose subset of ChartSpec v1. */
export interface ChartSubjectLike {
  title?: string;
  x?: string;
  y?: string;
  seriesColumn?: string;
}

/** Best-effort human label for what a chart depicts. */
export function chartSubject(chart: ChartSubjectLike): string {
  const title = (chart.title ?? "").trim();
  if (title) return title;
  const y = (chart.y ?? "").trim();
  const x = (chart.x ?? "").trim();
  if (y && x) return `${y} by ${x}`;
  return x || y || "this chart";
}

/**
 * Build the deep-dive question for a chart. Intentionally diagnostic +
 * strategic (drivers, why, segments, actions) so the server runs a full
 * decision-grade analysis. Never contains the conjunction "or".
 */
export function buildChartInvestigationPrompt(chart: ChartSubjectLike): string {
  const subject = chartSubject(chart);
  const series = (chart.seriesColumn ?? "").trim();
  const bySeries = series ? ` across ${series}` : "";
  return (
    `Investigate "${subject}"${bySeries} in depth: what is driving this pattern and why is it happening, ` +
    `which segments contribute most to the gap, and what specific, prioritised actions should we take? ` +
    `Quantify the key drivers.`
  );
}
