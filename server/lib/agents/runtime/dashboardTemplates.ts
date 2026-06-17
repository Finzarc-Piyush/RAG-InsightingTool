/**
 * ============================================================================
 * dashboardTemplates.ts — places chart tiles on a dashboard grid by code
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the agent builds a dashboard, the LLM only decides the story and which
 *   "template" to use (executive / deep_dive / monitoring). It does NOT decide
 *   where each chart sits. This file does that with plain code: given a template
 *   and the actual charts, it computes a 12-column react-grid-layout placement
 *   (x/y/width/height) for each chart tile.
 *
 *   Box WIDTH is content-aware: it delegates to the shared layout authority
 *   (planChartLayout in shared/dashboardLayout.ts), so a time-series / heatmap /
 *   many-category chart gets a wide box and a pie / scatter / small-bar a
 *   standard one, with the executive template leading on a full-width hero. Rows
 *   always fill the grid width — no orphan gaps (the old rigid 3-up left a hole
 *   when the last row was short). Box HEIGHT here is only a SEED: the client
 *   recomputes each chart's height from its placed width (chartAspectRows) on
 *   load, so a too-tall/short server value never survives into the render.
 *
 * WHY IT MATTERS
 *   Centralising the width decision in ONE shared authority means the saved
 *   /dashboard and the inline chat answer compose charts identically, and there
 *   are no more hardcoded per-template cell coordinates to drift. Tile ids
 *   ("chart-0", "chart-1", …) must match what DashboardView.tsx expects.
 *
 * KEY PIECES
 *   - chartGridItemsForTemplate — grid entries for a sheet's charts under a
 *     template. executive = hero + content-aware grid; deep_dive = content-aware
 *     grid; monitoring = compact content-aware grid.
 *   - applyDashboardTemplateLayout — stamps an `lg` layout onto each chart-
 *     bearing sheet. Idempotent: skips sheets that already have enough layout.
 */
import type {
  ChartSpec,
  DashboardSpec,
  DashboardTemplate,
} from "../../../shared/schema.js";
import { planChartLayout, chartRowsForSpan } from "../../../shared/dashboardLayout.js";

type GridItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
};

const COLS = 12;
const CHART_MIN = { minW: 3, minH: 6 };

// Monitoring tiles are intentionally compact (a denser KPI wall); every other
// template sizes each chart's height to its placed WIDTH via the shared
// aspect-ratio authority (chartRowsForSpan) — identical to what the client
// renderer computes — so a wide hero is tall and a third-width box is short,
// with no fixed tall slot leaving dead space.
const COMPACT_ROWS = 8; // monitoring template

function seedRows(span: number, compact: boolean): number {
  return compact ? COMPACT_ROWS : chartRowsForSpan(span);
}

/**
 * Produce grid-layout entries for a sheet's charts under the given template.
 * Widths come from the shared content-aware planner; this function only packs
 * those spans into x/y coordinates row by row (the planner already makes each
 * row's spans sum to COLS, so a row advances x by each span and wraps when
 * full). Returns undefined when the sheet has no charts.
 */
export function chartGridItemsForTemplate(
  template: DashboardTemplate,
  charts: ReadonlyArray<ChartSpec>,
): GridItem[] | undefined {
  if (charts.length === 0) return undefined;
  const compact = template === "monitoring";
  const plan = planChartLayout(charts, {
    columns: COLS,
    emphasizeFirst: template === "executive",
  });

  const items: GridItem[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  plan.forEach((p, i) => {
    if (x + p.span > COLS) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const h = seedRows(p.span, compact);
    items.push({ i: `chart-${i}`, x, y, w: p.span, h, ...CHART_MIN });
    x += p.span;
    rowHeight = Math.max(rowHeight, h);
  });
  return items;
}

/**
 * Mutates (in place) each chart-bearing sheet so it carries a `lg`-breakpoint
 * gridLayout. Sheets without charts are skipped. Idempotent: an existing `lg`
 * layout with enough entries is preserved (covers user edits / agent layouts).
 */
export function applyDashboardTemplateLayout(spec: DashboardSpec): void {
  for (const sheet of spec.sheets) {
    const charts = Array.isArray(sheet.charts) ? sheet.charts : [];
    if (charts.length === 0) continue;
    const existingLg = sheet.gridLayout?.lg;
    if (Array.isArray(existingLg) && existingLg.length >= charts.length) continue;
    const items = chartGridItemsForTemplate(spec.template, charts);
    if (!items) continue;
    sheet.gridLayout = {
      ...(sheet.gridLayout ?? {}),
      lg: items,
    };
  }
}
