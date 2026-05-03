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

import { useMemo } from "react";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { EChartsBase, type ChartTheme, type EChartsType } from "./EChartsBase";

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
  itemStyle?: { color?: string };
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

  // Build hierarchy: if color is set, group by it as parent; else flat.
  const tree = useMemo<TreemapNode[]>(() => {
    if (!groupCh) {
      const totals = new Map<string, number>();
      for (const r of data) {
        const k = asString(labelCh.accessor(r));
        const v = asNumber(valueCh.accessor(r));
        if (!Number.isFinite(v) || v <= 0) continue;
        totals.set(k, (totals.get(k) ?? 0) + v);
      }
      return Array.from(totals.entries()).map(([name, value]) => ({
        name,
        value,
      }));
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
      children: Array.from(inner.entries()).map(([name, value]) => ({
        name,
        value,
      })),
    }));
  }, [data, labelCh, valueCh, groupCh]);

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
               <div style="color:${theme.mutedForeground};font-size:11px;">${info.value?.toLocaleString?.() ?? info.value}</div>
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
