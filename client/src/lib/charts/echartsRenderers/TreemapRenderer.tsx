/**
 * Lazy-loaded ECharts renderer for the `treemap` mark.
 *
 * Encoding:
 *   x  → category (label)
 *   y  → quantitative size
 *   color → optional categorical (sub-grouping by parent)
 *
 * For hierarchical data (parent / child), the row is expected to
 * carry both fields and the converter assembles a nested tree. For
 * flat data, treemap renders a single-level partition by category.
 */

import { useCallback, useMemo } from "react";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { EChartsBase, type ChartTheme, type EChartsType } from "./EChartsBase";
import { useDashboardTileContext } from "@/pages/Dashboard/lib/dashboardTileContext";
import {
  dispatchCrossFilter,
  isCrossFilterActive,
  toFilterValue,
} from "@/pages/Dashboard/lib/crossFilter";
import {
  dispatchDrillThrough,
  isModifierClick,
} from "@/pages/Dashboard/lib/drillThrough";

export interface TreemapRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

interface TreemapNode {
  name: string;
  value?: number;
  children?: TreemapNode[];
  // WD2-dim-echarts-treemap · `opacity` widens the per-dataItem
  // itemStyle so non-matching leaves can carry their dim factor
  // (0.4) inline. ECharts respects per-dataItem `itemStyle.opacity`
  // as an override on top of the series-level itemStyle.
  itemStyle?: { color?: string; opacity?: number };
}

export function TreemapRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: TreemapRendererProps) {
  const labelCh = resolveChannel(spec.encoding.x);
  const valueCh = resolveChannel(spec.encoding.y);
  const groupCh = resolveChannel(spec.encoding.color);

  if (!labelCh || !valueCh) {
    throw new Error("treemap mark requires x (label) and y (value) encodings");
  }

  // Wave WD2-wiring-echarts · cross-filter dispatch on leaf clicks.
  // Treemap params shape: `{ name, value, data: { name, value, children? } }`.
  // We dispatch only when there are no children (i.e., the user clicked a
  // leaf, not a parent group); clicking a parent group with `nodeClick: false`
  // is already a no-op for the built-in zoom, so adding a parent-group
  // dispatch would surprise the user. Outside a dashboard tile the click
  // is unbound — `useDashboardTileContext` returns null, the handler is
  // `undefined`, and `EChartsBase` doesn't wire `inst.on('click', ...)`.
  const dashboardTile = useDashboardTileContext();
  // WD2-dim-echarts-treemap · per-dataItem dim factor on leaves whose
  // `name` isn't in the active categorical cross-filter on
  // `labelCh.field`. Lifted ABOVE the click handler (was below pre-
  // WD3-wiring-echarts) so the click handler can capture
  // `dashboardFilters` in its closure for the drill-through filters
  // snapshot. ECharts canvases re-render whenever `optionsKey`
  // changes, and `optionsKey = JSON.stringify({ tree, w, h })` already
  // covers the per-item opacity through `tree`'s nested itemStyle
  // objects.
  const dashboardFilters = dashboardTile?.filters;
  const labelFilterSel = dashboardFilters?.[labelCh.field];
  const dashboardDimActive =
    !!labelFilterSel &&
    labelFilterSel.type === "categorical" &&
    labelFilterSel.values.length > 0;
  // WD3-wiring-echarts · cmd / ctrl-click branches to drill-through
  // instead of cross-filter. ECharts wraps the native MouseEvent at
  // `params.event.event` (the ZRender event wrapping the DOM event);
  // `isModifierClick` accepts the sparse `{ metaKey?, ctrlKey? }`
  // shape so the chain works with no foundation changes. Same leaf-
  // only carve-out as the WD2 dispatch: parents (the `groupCh` value,
  // when present) stay un-wired because they're structural hierarchy.
  const onChartClick = useCallback(
    (params: unknown) => {
      if (!dashboardTile) return;
      const p = params as {
        data?: { name?: unknown; children?: unknown[] };
        event?: { event?: { metaKey?: boolean; ctrlKey?: boolean } };
      };
      const name = p?.data?.name;
      const isLeaf = !Array.isArray(p?.data?.children) || p.data.children.length === 0;
      if (!isLeaf || name == null) return;
      if (isModifierClick(p?.event?.event)) {
        dispatchDrillThrough({
          chartId: dashboardTile.tileId,
          column: labelCh.field,
          value: name,
          sourceTileId: dashboardTile.tileId,
          filters: dashboardFilters,
        });
        return;
      }
      dispatchCrossFilter({
        column: labelCh.field,
        value: toFilterValue(name),
        sourceTileId: dashboardTile.tileId,
      });
    },
    [dashboardTile, labelCh.field, dashboardFilters],
  );

  // Build hierarchy: if color is set, group by it as parent; else flat.
  const tree = useMemo<TreemapNode[]>(() => {
    const dimLeaf = (name: string): TreemapNode["itemStyle"] | undefined =>
      dashboardDimActive &&
      !isCrossFilterActive(dashboardFilters!, labelCh.field, name)
        ? { opacity: 0.4 }
        : undefined;
    if (!groupCh) {
      const totals = new Map<string, number>();
      for (const r of data) {
        const k = asString(labelCh.accessor(r));
        const v = asNumber(valueCh.accessor(r));
        if (!Number.isFinite(v) || v <= 0) continue;
        totals.set(k, (totals.get(k) ?? 0) + v);
      }
      return Array.from(totals.entries()).map(([name, value]) => {
        const itemStyle = dimLeaf(name);
        return itemStyle ? { name, value, itemStyle } : { name, value };
      });
    }
    const groups = new Map<string, Map<string, number>>();
    for (const r of data) {
      const g = asString(groupCh.accessor(r));
      const k = asString(labelCh.accessor(r));
      const v = asNumber(valueCh.accessor(r));
      if (!Number.isFinite(v) || v <= 0) continue;
      const inner = groups.get(g) ?? new Map<string, number>();
      inner.set(k, (inner.get(k) ?? 0) + v);
      groups.set(g, inner);
    }
    return Array.from(groups.entries()).map(([gName, inner]) => ({
      name: gName,
      children: Array.from(inner.entries()).map(([name, value]) => {
        const itemStyle = dimLeaf(name);
        return itemStyle ? { name, value, itemStyle } : { name, value };
      }),
    }));
  }, [data, labelCh, valueCh, groupCh, dashboardDimActive, dashboardFilters]);

  const optionsKey = useMemo(
    () => JSON.stringify({ tree, w: width, h: height }),
    [tree, width, height],
  );

  return (
    <EChartsBase
      width={width}
      height={height}
      ariaLabel={
        ariaLabel ??
        spec.config?.accessibility?.ariaLabel ??
        spec.config?.title?.text ??
        "Treemap"
      }
      optionsKey={optionsKey}
      onChartClick={dashboardTile ? onChartClick : undefined}
      buildOptions={(_echarts: EChartsType, theme: ChartTheme) => ({
        backgroundColor: "transparent",
        textStyle: {
          fontFamily: "var(--font-sans)",
          color: theme.foreground,
        },
        tooltip: {
          // Custom HTML formatter so the tooltip uses our semantic-token card.
          formatter: (info: { name: string; value: number }) =>
            `<div style="padding:6px 8px;font-family:var(--font-sans);">
               <div style="font-weight:600;color:${theme.foreground};">${info.name}</div>
               <div style="color:${theme.mutedForeground};font-size:11px;">${info.value?.toLocaleString?.(undefined, { maximumFractionDigits: 2 }) ?? info.value}</div>
             </div>`,
          backgroundColor: theme.background,
          borderColor: theme.border,
          borderWidth: 1,
          textStyle: { color: theme.foreground },
          extraCssText: `border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.08);`,
        },
        series: [
          {
            type: "treemap",
            data: tree,
            roam: false,
            nodeClick: false,
            breadcrumb: { show: tree.some((n) => !!n.children) },
            label: {
              show: true,
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: theme.background,
            },
            itemStyle: {
              borderColor: theme.background,
              borderWidth: 1,
              gapWidth: 2,
            },
            levels: [
              {
                itemStyle: {
                  borderColor: theme.background,
                  borderWidth: 0,
                  gapWidth: 4,
                },
                colorSaturation: [0.45, 0.85],
              },
              {
                colorSaturation: [0.35, 0.7],
                itemStyle: {
                  borderColorSaturation: 0.6,
                  borderWidth: 1,
                  gapWidth: 1,
                },
              },
            ],
            color: theme.qualitative.filter(Boolean),
          },
        ],
      })}
    />
  );
}
