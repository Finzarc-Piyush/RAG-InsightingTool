import { useMemo, useState } from "react";
import type { ChartSpec } from "@/shared/schema";
import { applyChartFilters } from "@/lib/chartFilters";
import type { ActiveChartFilters } from "@/lib/chartFilters";
import {
  buildPivotModel,
  flattenPivotTree,
} from "@/lib/pivot/buildPivotModel";
import type { FilterSelections } from "@/lib/pivot/types";
import { PivotGrid } from "@/pages/Home/Components/pivot/PivotGrid";
import { chartSpecToPivotConfig } from "./chartSpecToPivotConfig";

/**
 * Read-only pivot view of a chart's bundled data.
 *
 * Two data-source modes:
 *   - default: rows come from `chart.data`, optionally narrowed by `filters`
 *     via `applyChartFilters` (matches the dashboard tile contract).
 *   - explicit: caller passes `data` directly (e.g. fullscreen modal already
 *     filtered the rows upstream — pass them through verbatim to avoid
 *     double-filtering).
 *
 * Mounts `PivotGrid` with no field-panel / sort / slice-filter callbacks, so
 * the only interaction available is row-group expand/collapse.
 */

interface ChartTilePivotViewProps {
  chart: ChartSpec;
  /** Effective filter for the tile (e.g. DR4 dashboard global ∪ per-tile override). */
  filters?: ActiveChartFilters;
  /**
   * Explicit pre-filtered rows. When provided, `chart.data` and `filters` are
   * ignored — used by surfaces (like the chat fullscreen modal) that have
   * already produced a filtered slice upstream.
   */
  data?: Record<string, unknown>[];
}

const EMPTY_FILTER_SELECTIONS: FilterSelections = {};

export function ChartTilePivotView({
  chart,
  filters,
  data,
}: ChartTilePivotViewProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const derived = useMemo(() => chartSpecToPivotConfig(chart), [chart]);

  const filtered = useMemo(() => {
    if (!derived) return [];
    if (Array.isArray(data)) return data;
    const rows = (chart.data ?? []) as Record<string, unknown>[];
    if (!filters) return rows;
    return applyChartFilters(rows, filters);
  }, [chart.data, filters, derived, data]);

  const model = useMemo(() => {
    if (!derived) return null;
    return buildPivotModel(
      filtered,
      derived.config,
      derived.valueSpecs,
      EMPTY_FILTER_SELECTIONS,
    );
  }, [derived, filtered]);

  const flatRows = useMemo(() => {
    if (!model) return [];
    return flattenPivotTree(model.tree, collapsed);
  }, [model, collapsed]);

  const handleToggleCollapse = (pathKey: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) {
        next.delete(pathKey);
      } else {
        next.add(pathKey);
      }
      return next;
    });
  };

  if (!derived || !model) {
    return (
      <div
        role="alert"
        className="h-full w-full flex flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-muted/30 px-4 py-6 text-center"
      >
        <div className="text-sm font-medium text-foreground">
          Pivot view unavailable
        </div>
        <div className="text-xs text-muted-foreground">
          This chart's data shape can't be summarised as a pivot.
        </div>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div
        role="alert"
        className="h-full w-full flex flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-muted/30 px-4 py-6 text-center"
      >
        <div className="text-sm font-medium text-foreground">No rows</div>
        <div className="text-xs text-muted-foreground">
          The current filter excludes every row in this chart.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto">
      <PivotGrid
        model={model}
        flatRows={flatRows}
        onToggleCollapse={handleToggleCollapse}
        layout="embedded"
      />
    </div>
  );
}
