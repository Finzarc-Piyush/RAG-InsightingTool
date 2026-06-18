/**
 * Visx renderer for the `combo` mark — grouped bars on left axis +
 * a line on a secondary right axis. The most common BI overlay
 * (revenue bars + margin% line, etc.).
 *
 * Encoding contract:
 *   x         → categorical or temporal
 *   y         → quantitative (rendered as bars)
 *   y2        → quantitative (rendered as the line)
 *   color     → optional categorical (multi-series bars)
 */

import { memo, useMemo } from "react";
import { Group } from "@visx/group";
import { Bar, LinePath } from "@visx/shape";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  distinctOrdered,
  numericExtent,
  paddedDomain,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { makeAxisTickFormatter } from "@/lib/charts/format";
import { targetYTickCount } from "@/lib/charts/yAxisTickCount";
import {
  maxXAxisLabels,
  pickEvenlySpacedTicks,
} from "@/lib/charts/xAxisLabelCap";
import { useDashboardTileContext } from "@/pages/Dashboard/lib/dashboardTileContext";
import {
  dispatchCrossFilter,
  isCrossFilterActive,
  toFilterValue,
} from "@/pages/Dashboard/lib/crossFilter";
// Wave WD3-wiring-rest-cat · cmd / ctrl-click on the categorical bars
// → drill-through. Secondary-axis line marks stay un-wired (mirrors
// the WD2-wiring-rest-cat carve-out — a continuous trend has no
// per-mark categorical brush target).
import {
  dispatchDrillThrough,
  isModifierClick,
} from "@/pages/Dashboard/lib/drillThrough";

export interface ComboRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 56, bottom: 36, left: 56 };

function ComboRendererImpl({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: ComboRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  const y2Ch = resolveChannel(spec.encoding.y2);

  if (!xCh || !yCh || !y2Ch) {
    throw new Error("combo mark requires x, y, and y2 encodings");
  }
  // WD2-wiring-rest-cat · dashboard-tile cross-filter dispatch. The
  // bars (not the secondary line) are the categorical click target —
  // clicking a bar dispatches CROSS_FILTER_EVENT with the bar's x value.
  const dashboardTile = useDashboardTileContext();
  // WD2-dim-cat · dim non-matching bars at 0.4 of their baseline 0.85
  // fillOpacity when an active categorical cross-filter on `xCh.field`
  // doesn't include the bar's rawX. The secondary-axis line is left
  // untouched — it's click-inert per the WD2-wiring-rest-cat contract
  // and dimming a continuous line based on a categorical filter would
  // break the visual coherence of the trend.
  const dashboardFilters = dashboardTile?.filters;
  const xFilterSel = dashboardFilters?.[xCh.field];
  const dashboardDimActive =
    !!xFilterSel &&
    xFilterSel.type === "categorical" &&
    xFilterSel.values.length > 0;

  const xValues = useMemo(
    () => distinctOrdered(data, xCh.accessor),
    [data, xCh],
  );
  // Width-aware category-label budget (no fixed cap): fit as many horizontal
  // labels as the plot width allows.
  const xCategoryTicks = useMemo(
    () =>
      pickEvenlySpacedTicks(
        xValues,
        maxXAxisLabels({
          axisWidthPx: innerWidth,
          labels: xValues,
          fontSizePx: 11,
          rotationDeg: 0,
        }),
      ),
    [xValues, innerWidth],
  );

  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: xValues,
        range: [0, innerWidth],
        padding: 0.25,
      }),
    [xValues, innerWidth],
  );

  const yScale = useMemo(() => {
    const ext = numericExtent(data, (r) => asNumber(yCh.accessor(r)));
    return scaleLinear<number>({
      domain: paddedDomain([Math.min(0, ext[0]), Math.max(0, ext[1])], 0.05),
      range: [innerHeight, 0],
      nice: true,
    });
  }, [data, yCh, innerHeight]);

  const y2Scale = useMemo(() => {
    const ext = numericExtent(data, (r) => asNumber(y2Ch.accessor(r)));
    return scaleLinear<number>({
      domain: paddedDomain(ext, 0.1),
      range: [innerHeight, 0],
      nice: true,
    });
  }, [data, y2Ch, innerHeight]);

  const xTickFormat = useMemo(
    () => makeAxisTickFormatter(xCh.field),
    [xCh.field],
  );
  const yTickFormat = useMemo(
    () => makeAxisTickFormatter(yCh.field),
    [yCh.field],
  );
  const y2TickFormat = useMemo(
    () => makeAxisTickFormatter(y2Ch.field),
    [y2Ch.field],
  );

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Combo chart";

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <svg width={width} height={height} role="img" aria-label={accessibleLabel}>
      <Group left={MARGIN.left} top={MARGIN.top}>
        <GridRows
          scale={yScale}
          width={innerWidth}
          stroke="hsl(var(--border))"
          strokeOpacity={0.25}
          strokeDasharray="2,2"
          numTicks={targetYTickCount(innerHeight)}
        />
        {yScale.domain()[0] <= 0 && yScale.domain()[1] >= 0 && (
          <line
            x1={0}
            x2={innerWidth}
            y1={yScale(0)}
            y2={yScale(0)}
            stroke="hsl(var(--border))"
            strokeOpacity={0.7}
          />
        )}
        {/* Bars */}
        {data.map((row, i) => {
          // Preserve the type-original x value for cross-filter dispatch;
          // `xRaw` is only stringified for the band scale lookup.
          const rawX = xCh.accessor(row);
          const xRaw = asString(rawX);
          const yRaw = asNumber(yCh.accessor(row));
          const x = xScale(xRaw);
          if (x === undefined || !Number.isFinite(yRaw)) return null;
          const yPos = yScale(yRaw);
          const barHeight = innerHeight - yPos;
          if (barHeight <= 0) return null;
          const isDashboardDimmed =
            dashboardDimActive &&
            !isCrossFilterActive(dashboardFilters!, xCh.field, rawX);
          return (
            <Bar
              key={`bar-${i}-${xRaw}`}
              x={x}
              y={yPos}
              width={xScale.bandwidth()}
              height={barHeight}
              fill={qualitativeColor(0)}
              fillOpacity={0.85 * (isDashboardDimmed ? 0.4 : 1)}
              rx={2}
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
                          column: xCh.field,
                          value: rawX,
                          sourceTileId: dashboardTile.tileId,
                          filters: dashboardFilters,
                        });
                        return;
                      }
                      dispatchCrossFilter({
                        column: xCh.field,
                        value: toFilterValue(rawX),
                        sourceTileId: dashboardTile.tileId,
                      });
                    }
                  : undefined
              }
            />
          );
        })}
        {/* Line on y2 */}
        <LinePath
          data={data}
          x={(r) => {
            const x = xScale(asString(xCh.accessor(r)));
            return (x ?? 0) + xScale.bandwidth() / 2;
          }}
          y={(r) => y2Scale(asNumber(y2Ch.accessor(r))) ?? 0}
          stroke={qualitativeColor(2)}
          strokeWidth={2.25}
          curve={curveMonotoneX}
          fill="none"
        />
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          stroke="hsl(var(--border))"
          tickStroke="hsl(var(--border))"
          tickFormat={(v: unknown) => xTickFormat(v)}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            textAnchor: "middle",
          })}
          tickValues={xCategoryTicks}
        />
        <AxisLeft
          scale={yScale}
          stroke="hsl(var(--border))"
          tickStroke="hsl(var(--border))"
          tickFormat={(v) => yTickFormat(v as number)}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            textAnchor: "end",
            dx: -4,
            dy: 3,
          })}
          numTicks={targetYTickCount(innerHeight)}
          label={yCh.field}
          labelProps={{
            fill: "hsl(var(--muted-foreground))",
            fontSize: 10,
          }}
        />
        <AxisRight
          left={innerWidth}
          scale={y2Scale}
          stroke="hsl(var(--border))"
          tickStroke="hsl(var(--border))"
          tickFormat={(v) => y2TickFormat(v as number)}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            textAnchor: "start",
            dx: 4,
            dy: 3,
          })}
          numTicks={targetYTickCount(innerHeight)}
        />
      </Group>
    </svg>
  );
}

// FE-4 · Memoized leaf renderer. Props (spec / data / width / height /
// ariaLabel) are stable value props supplied by <PremiumChart>, so a
// shallow prop comparison safely skips re-renders when an unrelated
// sibling in a mapped chart list updates.
export const ComboRenderer = memo(ComboRendererImpl);
ComboRenderer.displayName = "ComboRenderer";
