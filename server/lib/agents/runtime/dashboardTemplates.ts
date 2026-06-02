/**
 * ============================================================================
 * dashboardTemplates.ts — places chart tiles on a dashboard grid by hand
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the agent builds a dashboard, the LLM only decides the story and which
 *   "template" to use (executive / deep_dive / monitoring). It does NOT decide
 *   where each chart sits on the page. This file does that part with plain code:
 *   given a template name and how many charts there are, it computes a grid
 *   layout — x/y position, width, height — for each chart tile. "Grid layout"
 *   here means the coordinates the front-end library react-grid-layout uses to
 *   arrange tiles on a 12-column grid.
 *
 * WHY IT MATTERS
 *   Layout math is deterministic and cheap, so keeping it off the LLM saves
 *   tokens, avoids hallucinated/overlapping coordinates, and gives every
 *   dashboard a consistent look per template. The chart tile ids it emits
 *   ("chart-0", "chart-1", ...) must match what the client's DashboardView.tsx
 *   expects, or tiles won't render.
 *
 * KEY PIECES
 *   - chartGridItemsForTemplate — returns grid entries for N charts under a
 *     given template (executive = hero + 3-up; deep_dive = uniform 3-up;
 *     monitoring = compact 3-up).
 *   - applyDashboardTemplateLayout — mutates a DashboardSpec in place, adding an
 *     `lg`-breakpoint layout to each sheet that has charts. Idempotent: skips
 *     sheets that already have a sufficient layout.
 *
 * HOW IT CONNECTS
 *   Types come from shared/schema.js (DashboardSpec, DashboardTemplate). Called
 *   by the dashboard builder after the LLM returns its narrative+template. Only
 *   the `lg` (large) breakpoint is set here; smaller screens fall back to the
 *   client's own stable-place helper. Narrative tiles are not laid out here.
 */
import type { DashboardSpec, DashboardTemplate } from "../../../shared/schema.js";

type GridItem = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number };

const COLS = 12;
// 3-up: charts span 4 of 12 columns by default. Height bumped to 16 to leave
// room for the inline keyInsight rendered below each chart in DashboardTiles.tsx.
const CHART_DEFAULT = { w: 4, h: 16, minW: 3, minH: 6 };

interface ChartCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

function executiveCells(count: number): ChartCell[] {
  const cells: ChartCell[] = [];
  if (count === 0) return cells;
  // Hero: full-width, slightly taller.
  cells.push({ x: 0, y: 0, w: 12, h: 16 });
  if (count === 1) return cells;
  // Remaining charts in a 3-up grid below the hero.
  const remaining = count - 1;
  for (let i = 0; i < remaining; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    cells.push({ x: col * 4, y: 16 + row * 16, w: 4, h: 16 });
  }
  return cells;
}

function deepDiveCells(count: number): ChartCell[] {
  // Uniform 3-column grid, w=4 h=16 (chart + inline insight).
  const cells: ChartCell[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    cells.push({ x: col * 4, y: row * 16, w: 4, h: 16 });
  }
  return cells;
}

function monitoringCells(count: number): ChartCell[] {
  // Uniform 3-column compact grid, w=4 h=8.
  const cells: ChartCell[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    cells.push({ x: col * 4, y: row * 8, w: 4, h: 8 });
  }
  return cells;
}

const CELLS_BY_TEMPLATE: Record<
  DashboardTemplate,
  (count: number) => ChartCell[]
> = {
  executive: executiveCells,
  deep_dive: deepDiveCells,
  monitoring: monitoringCells,
};

/**
 * Produces grid-layout entries for each chart tile on the given sheet based
 * on the spec's template. Returns undefined when the sheet has no charts.
 */
export function chartGridItemsForTemplate(
  template: DashboardTemplate,
  chartCount: number
): GridItem[] | undefined {
  if (chartCount <= 0) return undefined;
  const cells = (CELLS_BY_TEMPLATE[template] ?? deepDiveCells)(chartCount);
  return cells.map((c, i) => ({
    i: `chart-${i}`,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    minW: CHART_DEFAULT.minW,
    minH: CHART_DEFAULT.minH,
  }));
}

/**
 * Mutates (in place) the sheet containing charts so it carries a gridLayout
 * for the `lg` breakpoint. Sheets without charts are skipped. Idempotent:
 * existing `lg` layout is preserved if present.
 */
export function applyDashboardTemplateLayout(spec: DashboardSpec): void {
  for (const sheet of spec.sheets) {
    const chartCount = Array.isArray(sheet.charts) ? sheet.charts.length : 0;
    if (chartCount === 0) continue;
    const existingLg = sheet.gridLayout?.lg;
    if (Array.isArray(existingLg) && existingLg.length >= chartCount) continue;
    const items = chartGridItemsForTemplate(spec.template, chartCount);
    if (!items) continue;
    sheet.gridLayout = {
      ...(sheet.gridLayout ?? {}),
      lg: items,
    };
  }
}
