/**
 * Visx renderer for the `funnel` mark — descending stages with
 * conversion-% drop labels.
 *
 * Stages are sorted by spec data order (the spec.data is the source
 * of truth for stage order). Bar width is proportional to value;
 * each stage centered horizontally. Drop label between stages shows
 * the conversion % from the previous stage.
 */

import { memo, useMemo } from "react";
import { Group } from "@visx/group";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveBarEncoding,
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

export interface FunnelRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 16, left: 16 };

function FunnelRendererImpl({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: FunnelRendererProps) {
  const enc = useMemo(() => resolveBarEncoding(spec), [spec]);
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  // WD2-wiring-rest-cat · dashboard-tile cross-filter dispatch. Outside
  // a dashboard tile `dashboardTile` is null and the click is a no-op.
  const dashboardTile = useDashboardTileContext();
  // WD2-dim-cat · dim non-matching funnel stages at 0.4 fillOpacity
  // when an active categorical cross-filter on `enc.x.field` doesn't
  // include the stage's rawLabel. The existing baseline 0.85 fillOpacity
  // is preserved for matching stages; non-matching stages multiply by 0.4.
  const dashboardFilters = dashboardTile?.filters;
  const xFilterSel = dashboardFilters?.[enc.x.field];
  const dashboardDimActive =
    !!xFilterSel &&
    xFilterSel.type === "categorical" &&
    xFilterSel.values.length > 0;

  const stages = useMemo(() => {
    return data
      .map((r) => ({
        label: asString(enc.x.accessor(r)),
        // Preserve the raw (type-original) stage value for cross-filter
        // dispatch — numeric / Date stages must not collapse to strings.
        rawLabel: enc.x.accessor(r),
        value: asNumber(enc.y.accessor(r)),
      }))
      .filter((s) => Number.isFinite(s.value) && s.value >= 0);
  }, [data, enc]);

  const maxValue = useMemo(
    () => stages.reduce((m, s) => (s.value > m ? s.value : m), 1),
    [stages],
  );

  const stageHeight = stages.length > 0 ? innerHeight / stages.length : 0;
  const stageGap = 4;
  const drawableStageH = Math.max(1, stageHeight - stageGap);

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Funnel chart";

  if (innerWidth <= 0 || innerHeight <= 0 || stages.length === 0) return null;

  return (
    <svg width={width} height={height} role="img" aria-label={accessibleLabel}>
      <Group left={MARGIN.left} top={MARGIN.top}>
        {stages.map((s, i) => {
          const w = (s.value / maxValue) * innerWidth;
          const x = (innerWidth - w) / 2;
          const y = i * stageHeight;
          const fill = qualitativeColor(i);
          const prev = stages[i - 1];
          const drop =
            prev && prev.value > 0
              ? ((prev.value - s.value) / prev.value) * 100
              : null;
          const isDashboardDimmed =
            dashboardDimActive &&
            !isCrossFilterActive(dashboardFilters!, enc.x.field, s.rawLabel);
          return (
            <g key={`funnel-${i}-${s.label}`}>
              <rect
                x={x}
                y={y}
                width={w}
                height={drawableStageH}
                fill={fill}
                fillOpacity={0.85 * (isDashboardDimmed ? 0.4 : 1)}
                rx={3}
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
                            column: enc.x.field,
                            value: s.rawLabel,
                            sourceTileId: dashboardTile.tileId,
                            filters: dashboardFilters,
                          });
                          return;
                        }
                        dispatchCrossFilter({
                          column: enc.x.field,
                          value: toFilterValue(s.rawLabel),
                          sourceTileId: dashboardTile.tileId,
                        });
                      }
                    : undefined
                }
              />
              <text
                x={innerWidth / 2}
                y={y + drawableStageH / 2 + 4}
                fontSize={12}
                fontFamily="var(--font-sans)"
                fill="hsl(var(--background))"
                fontWeight={600}
                textAnchor="middle"
                pointerEvents="none"
              >
                {s.label} · {formatChartValue(s.value, enc.y.field)}
              </text>
              {drop !== null && (
                <text
                  x={innerWidth / 2}
                  y={y - 2}
                  fontSize={10}
                  fontFamily="var(--font-sans)"
                  fill="hsl(var(--muted-foreground))"
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  ↓ {drop.toFixed(1)}% drop
                </text>
              )}
            </g>
          );
        })}
      </Group>
    </svg>
  );
}

// FE-4 · Memoized leaf renderer. Props (spec / data / width / height /
// ariaLabel) are stable value props supplied by <PremiumChart>, so a
// shallow prop comparison safely skips re-renders when an unrelated
// sibling in a mapped chart list updates.
export const FunnelRenderer = memo(FunnelRendererImpl);
FunnelRenderer.displayName = "FunnelRenderer";
