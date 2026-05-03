/**
 * Phase 2 — deterministic `gridLayout` generators for agent-emitted
 * DashboardSpecs. Keeps layout logic off the LLM (the LLM picks narrative
 * + template name; we place the tiles). Output maps directly onto the
 * `lg` breakpoint react-grid-layout consumes; smaller breakpoints fall
 * back to the client's stable-place helper.
 *
 * Chart tile ids must match what DashboardView.tsx produces:
 *   chart-${index}    — index inside sheet.charts[].
 *
 * Current scope is charts only — narrative tiles inherit the client's
 * default stable-place layout.
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
