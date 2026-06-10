/**
 * Wave Z3 · pure state helpers for the chart-tile insight footer.
 *
 * Pre-Z3 the footer rendered only when `tile.chart.keyInsight` was truthy, so
 * an auto-built dashboard chart (whose insight is patched in asynchronously by
 * the server — Workstream I) showed NO footer at all in the window before the
 * patch lands. Z3 always renders the footer and resolves which state to show:
 *   - "present" — a static insight or a fresh regen entry exists.
 *   - "loading" — a regen is in flight (and there's nothing to show yet).
 *   - "empty"   — no insight yet; offer a "Generate insight" CTA.
 *
 * Pure — the testable seam; the footer JSX is thin.
 */
export type InsightFooterMode = "present" | "loading" | "empty";

function hasText(s: string | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

export function resolveInsightFooterMode(
  keyInsight: string | undefined,
  regenEntryText: string | undefined,
  loading: boolean,
): InsightFooterMode {
  if (hasText(regenEntryText) || hasText(keyInsight)) return "present";
  if (loading) return "loading";
  return "empty";
}

/** The prose to render: a fresh regen entry wins over the static insight. */
export function pickFooterText(
  entryText: string | undefined,
  insight: string | undefined,
): string {
  if (hasText(entryText)) return entryText as string;
  return insight ?? "";
}
