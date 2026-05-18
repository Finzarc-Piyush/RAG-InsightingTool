import { Suspense, lazy } from "react";
import { AlertTriangle, BarChart3, Table2, Trash2 } from "lucide-react";
import type { ChartSpec } from "@/shared/schema";
import type { ActiveChartFilters } from "@/lib/chartFilters";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ChartShim } from "@/components/charts/ChartShim";
import { cn } from "@/lib/utils";
import { TileHeader } from "./TileHeader";
import { TileInsightFooter } from "./TileInsightFooter";
import { ChartTilePivotView } from "@/components/charts/ChartTilePivotView";
import { chartSpecToPivotConfig } from "@/components/charts/chartSpecToPivotConfig";
import { useChartTileViewMode } from "../hooks/useChartTileViewMode";
import { DashboardTileProvider } from "../lib/dashboardTileContext";

// Lazy load to mirror DashboardTiles' Suspense pattern.
const ChartRenderer = lazy(() =>
  import("@/pages/Home/Components/ChartRenderer").then((m) => ({
    default: m.ChartRenderer,
  })),
);

/**
 * Wave DR18D · chart tile body extracted into its own component so
 * the per-tile chart/pivot view-mode hook (useChartTileViewMode) can
 * run with stable identity. Pre-DR18D the chart case rendered inline
 * inside `DashboardTiles.renderTileContent` — a function called from
 * the parent's render — which can't host hooks.
 *
 * Visual contract is preserved verbatim:
 *   - same outer Card with `dashboard-tile-grab-area` and
 *     `data-dashboard-tile="chart"` (load-bearing for react-grid-layout
 *     swap-on-collision and the DR3 regression test)
 *   - same `TileHeader` with title, inapplicable-filter badge (DR4),
 *     and edit-mode delete action
 *   - same `<ErrorBoundary><Suspense><ChartShim/></Suspense></ErrorBoundary>`
 *     for chart rendering
 *   - same `TileInsightFooter` (DR18B) inside the same Card
 *
 * What's new:
 *   - `useChartTileViewMode(dashboardId, tile.id)` drives a
 *     chart/pivot toggle button in the TileHeader's `actions` slot.
 *   - When `mode === 'pivot'`, the ChartShim block is replaced with
 *     `<ChartTilePivotView>`. The keyInsight footer stays — same
 *     insight applies to both views.
 *   - Toggle button is hidden when `chartSpecToPivotConfig(chart)`
 *     returns null (chart can't sensibly pivot — no x, no y, no data).
 */

interface ChartTileBodyProps {
  tile: { kind: "chart"; id: string; title: string; chart: ChartSpec; index: number };
  dashboardId: string;
  canEdit: boolean;
  isEditing: boolean;
  inapplicableColumns: string[];
  filters: ActiveChartFilters | undefined;
  onFiltersChange: (next: ActiveChartFilters) => void;
  onDeleteClick: () => void;
  onEditInsight: () => void;
}

export function ChartTileBody({
  tile,
  dashboardId,
  canEdit,
  isEditing,
  inapplicableColumns,
  filters,
  onFiltersChange,
  onDeleteClick,
  onEditInsight,
}: ChartTileBodyProps) {
  const { mode, toggle } = useChartTileViewMode(dashboardId, tile.id);
  const canPivot = chartSpecToPivotConfig(tile.chart) !== null;
  // Force chart view when this chart can't be pivoted, even if a
  // stale `pivot` value is in sessionStorage from a prior chart shape.
  const effectiveMode = canPivot ? mode : "chart";

  const titleNode = tile.title || `Chart ${tile.index + 1}`;

  const headerActions = (
    <div className="flex items-center gap-1">
      {canPivot ? (
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => {
              if (effectiveMode !== "chart") toggle();
            }}
            aria-pressed={effectiveMode === "chart"}
            title="View as chart"
            className={cn(
              "px-1.5 py-1 text-xs transition-colors",
              effectiveMode === "chart"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
          >
            <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">View as chart</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (effectiveMode !== "pivot") toggle();
            }}
            aria-pressed={effectiveMode === "pivot"}
            title="View as pivot table"
            className={cn(
              "px-1.5 py-1 text-xs transition-colors border-l border-border",
              effectiveMode === "pivot"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
          >
            <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">View as pivot table</span>
          </button>
        </div>
      ) : null}
      {canEdit ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          aria-label="Remove chart from dashboard"
          onClick={onDeleteClick}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );

  return (
    <Card
      className="relative flex h-full flex-col overflow-hidden border border-border/60 bg-card shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group"
      data-dashboard-tile="chart"
    >
      <TileHeader
        title={titleNode}
        badge={
          inapplicableColumns.length > 0 ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              title={`Filters not in this chart's data: ${inapplicableColumns.join(", ")}`}
              data-testid="tile-inapplicable-badge"
            >
              Filter doesn't apply
            </span>
          ) : undefined
        }
        actions={headerActions}
      />
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0 px-4 pb-4">
        <div className="flex-1 min-h-[120px] min-w-0" data-dashboard-chart-node>
          <DashboardTileProvider tileId={tile.id}>
          {effectiveMode === "pivot" ? (
            <ChartTilePivotView chart={tile.chart} filters={filters} />
          ) : (
            <ErrorBoundary
              fallback={
                <div
                  role="alert"
                  className="h-full w-full flex flex-col items-center justify-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center"
                >
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  <div className="text-sm font-medium text-foreground">
                    Couldn't load this chart
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Reload the page to retry.
                  </div>
                </div>
              }
            >
              <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <ChartShim
                  spec={tile.chart}
                  legacy={() => (
                    <ChartRenderer
                      chart={tile.chart}
                      index={tile.index}
                      isSingleChart={false}
                      showAddButton={false}
                      useChartOnlyModal
                      fillParent
                      enableFilters
                      filters={filters}
                      onFiltersChange={onFiltersChange}
                    />
                  )}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          </DashboardTileProvider>
        </div>
        {tile.chart.keyInsight ? (
          <TileInsightFooter
            insight={tile.chart.keyInsight}
            dashboardId={dashboardId}
            tileId={tile.id}
            canEdit={canEdit}
            isEditing={isEditing}
            onEdit={onEditInsight}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
