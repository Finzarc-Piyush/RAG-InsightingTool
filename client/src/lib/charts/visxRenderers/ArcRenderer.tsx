/**
 * Visx renderer for the `arc` mark (pie / donut).
 *
 * Reads the categorical field from `encoding.x` (or `encoding.color`)
 * and the numeric magnitude from `encoding.y`. Supports donut mode
 * via `config.theme` extensions in future waves; for now renders a
 * standard pie with an inner radius slot reserved.
 */

import { memo, useMemo } from "react";
import { Group } from "@visx/group";
import { Pie } from "@visx/shape";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { formatChartValue } from "@/lib/charts/format";
import { useDashboardTileContext } from "@/pages/Dashboard/lib/dashboardTileContext";
import {
  dispatchCrossFilter,
  isCrossFilterActive,
  toFilterValue,
} from "@/pages/Dashboard/lib/crossFilter";
// Wave WD3-wiring-rest-cat · cmd / ctrl-click → drill-through.
import {
  dispatchDrillThrough,
  isModifierClick,
} from "@/pages/Dashboard/lib/drillThrough";

export interface ArcRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
  /** When set, renders a donut with this fraction of outer radius hollowed. */
  innerRadiusFraction?: number;
}

interface Slice {
  key: string;
  /**
   * Raw, type-preserved category value (not stringified). Used for
   * cross-filter dispatch so chart-mark clicks on numeric / boolean /
   * Date categories produce a stable filter value — `toFilterValue`
   * coerces consistently with the rest of WD2.
   */
  rawKey: unknown;
  value: number;
  color: string;
}

function ArcRendererImpl({
  spec,
  data,
  width,
  height,
  ariaLabel,
  innerRadiusFraction = 0.5,
}: ArcRendererProps) {
  // Category from x or color; magnitude from y.
  const labelCh =
    resolveChannel(spec.encoding.x) ?? resolveChannel(spec.encoding.color);
  const valueCh = resolveChannel(spec.encoding.y);

  if (!labelCh || !valueCh) {
    throw new Error("arc mark requires a category (x or color) and value (y) encoding");
  }

  const slices: Slice[] = useMemo(() => {
    // Aggregate by label in case data isn't pre-aggregated.
    // Preserve the raw value of the FIRST row seen per key so the
    // cross-filter dispatch carries a type-preserved category.
    const totals = new Map<string, { value: number; rawKey: unknown }>();
    for (const r of data) {
      const rawKey = labelCh.accessor(r);
      const k = asString(rawKey);
      const v = asNumber(valueCh.accessor(r));
      if (!Number.isFinite(v)) continue;
      const prev = totals.get(k);
      if (prev) {
        prev.value += v;
      } else {
        totals.set(k, { value: v, rawKey });
      }
    }
    let i = 0;
    return Array.from(totals.entries())
      .filter(([, agg]) => agg.value > 0)
      .map(([key, agg]) => ({
        key,
        rawKey: agg.rawKey,
        value: agg.value,
        color: qualitativeColor(i++),
      }));
  }, [data, labelCh, valueCh]);

  const total = useMemo(
    () => slices.reduce((s, x) => s + x.value, 0) || 1,
    [slices],
  );

  const radius = Math.min(width, height) / 2 - 8;
  const inner = Math.max(0, radius * innerRadiusFraction);
  // WD2-wiring-rest-cat · when this pie / donut renders inside a dashboard
  // tile, clicking a slice dispatches a CROSS_FILTER_EVENT carrying
  // {column: labelCh.field, value: toFilterValue(rawKey), sourceTileId}
  // that DashboardView toggles into globalFilters via applyCrossFilter.
  // Outside a dashboard tile (chat / explorer) `dashboardTile` is null
  // and the click is a no-op — matches BarRenderer's wiring.
  const dashboardTile = useDashboardTileContext();
  // WD2-dim-cat · dim non-matching slices at 0.4 opacity when the
  // dashboard has an active categorical cross-filter on `labelCh.field`.
  // Mirrors BarRenderer's WD2-dim-bar treatment; mutually exclusive
  // with the chat/explorer `grid.filter` path (no grid context here).
  const dashboardFilters = dashboardTile?.filters;
  const xFilterSel = dashboardFilters?.[labelCh.field];
  const dashboardDimActive =
    !!xFilterSel &&
    xFilterSel.type === "categorical" &&
    xFilterSel.values.length > 0;

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Pie chart";

  if (radius <= 0) return null;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={accessibleLabel}
    >
      <Group top={height / 2} left={width / 2}>
        <Pie
          data={slices}
          pieValue={(s) => s.value}
          outerRadius={radius}
          innerRadius={inner}
          padAngle={0.005}
          cornerRadius={2}
        >
          {(pie) =>
            pie.arcs.map((arc) => {
              const path = pie.path(arc) ?? "";
              const [cx, cy] = pie.path.centroid(arc);
              const pct = (arc.data.value / total) * 100;
              const showLabel = pct >= 5;
              const isDashboardDimmed =
                dashboardDimActive &&
                !isCrossFilterActive(
                  dashboardFilters!,
                  labelCh.field,
                  arc.data.rawKey,
                );
              return (
                <g key={`arc-${arc.data.key}`}>
                  <path
                    d={path}
                    fill={arc.data.color}
                    fillOpacity={isDashboardDimmed ? 0.4 : 1}
                    style={dashboardTile ? { cursor: "pointer" } : undefined}
                    onClick={
                      dashboardTile
                        ? (event: React.MouseEvent<SVGElement>) => {
                            // Wave WD3-wiring-rest-cat · cmd/ctrl-click
                            // → drill-through (open underlying-rows
                            // side-sheet) instead of cross-filter.
                            if (isModifierClick(event)) {
                              dispatchDrillThrough({
                                chartId: dashboardTile.tileId,
                                column: labelCh.field,
                                value: arc.data.rawKey,
                                sourceTileId: dashboardTile.tileId,
                                filters: dashboardFilters,
                              });
                              return;
                            }
                            dispatchCrossFilter({
                              column: labelCh.field,
                              value: toFilterValue(arc.data.rawKey),
                              sourceTileId: dashboardTile.tileId,
                            });
                          }
                        : undefined
                    }
                  />
                  {showLabel && (
                    <text
                      x={cx}
                      y={cy}
                      dy=".33em"
                      fontSize={11}
                      fontFamily="var(--font-sans)"
                      fill="hsl(var(--background))"
                      textAnchor="middle"
                      pointerEvents="none"
                    >
                      {formatChartValue(pct / 100, undefined, {
                        format: "percent",
                        precision: 0,
                      })}
                    </text>
                  )}
                </g>
              );
            })
          }
        </Pie>
      </Group>
    </svg>
  );
}

// FE-4 · Memoized leaf renderer. Props (spec / data / width / height /
// ariaLabel) are stable value props supplied by <PremiumChart>, so a
// shallow prop comparison safely skips re-renders when an unrelated
// sibling in a mapped chart list updates.
export const ArcRenderer = memo(ArcRendererImpl);
ArcRenderer.displayName = "ArcRenderer";
