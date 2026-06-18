import type { ChartSpec, DashboardTableSpec } from "@/shared/schema";

/**
 * WD-add · derive a `DashboardTableSpec` from a chart's embedded rows.
 *
 * The dashboard "Add → Table from session" flow reuses the existing
 * chart-from-session picker: the user picks a chart, and we add its
 * underlying data as a standalone table tile. The session-details
 * endpoint hydrates charts with their `data` arrays, so the rows are
 * already present — no extra fetch, no server change.
 *
 * Column order mirrors how the chart reads: encoded dimensions first
 * (`x`, then `seriesColumn`), measure last (`y`), then any remaining
 * keys in first-seen order. Returns `null` when the chart carries no
 * embedded rows (agent-generated charts whose data wasn't shipped on
 * the spec) — the caller surfaces a "no rows to add" state.
 */
export function chartSpecToTableSpec(
  chart: ChartSpec,
): DashboardTableSpec | null {
  const data = Array.isArray((chart as { data?: unknown }).data)
    ? ((chart as { data?: Array<Record<string, unknown>> }).data ?? [])
    : [];
  if (data.length === 0) return null;

  // Collect columns in first-seen order across ALL rows (a later row may
  // carry a key absent from row 0 — e.g. a sparse series column).
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        cols.push(key);
      }
    }
  }
  if (cols.length === 0) return null;

  // Front-load the encoded axes so the table reads dimension → measure.
  // De-dupe via Set: a count/histogram chart (y reuses the x field) or a
  // malformed spec (seriesColumn === x) would otherwise repeat a column.
  const preferred = [
    ...new Set(
      [chart.x, chart.seriesColumn, chart.y].filter(
        (c): c is string => typeof c === "string" && seen.has(c),
      ),
    ),
  ];
  const ordered = [...preferred, ...cols.filter((c) => !preferred.includes(c))];

  const rows: Array<Array<string | number | null>> = data.map((row) =>
    ordered.map((col) => {
      const cell = (row as Record<string, unknown>)?.[col];
      if (cell === null || cell === undefined) return null;
      if (typeof cell === "number" || typeof cell === "string") return cell;
      // Booleans / objects aren't valid table cells — stringify defensively
      // so the spec passes `dashboardTableSpecSchema` (string|number|null).
      return String(cell);
    }),
  );

  const title = typeof chart.title === "string" ? chart.title.trim() : "";
  const caption =
    title || (chart.y && chart.x ? `${chart.y} by ${chart.x}` : "Table");

  return { caption, columns: ordered, rows };
}
