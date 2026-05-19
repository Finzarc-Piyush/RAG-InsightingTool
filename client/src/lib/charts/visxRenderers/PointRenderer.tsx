/**
 * Visx renderer for the `point` mark (scatter / bubble).
 *
 *   - Both x and y are quantitative.
 *   - Optional `color` encoding → distinct categorical groups.
 *   - Optional `size` encoding → marker radius (bubble chart).
 *   - Hover tooltip with [x, y, color, size] context.
 */

import { useMemo, useRef } from "react";
import { Group } from "@visx/group";
import { Circle } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import {
  useTooltip,
  TooltipWithBounds,
  defaultStyles as visxTooltipStyles,
} from "@visx/tooltip";
import { localPoint } from "@visx/event";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  numericExtent,
  paddedDomain,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { glyphPath, shapeFromIndex } from "@/lib/charts/glyphs";
import {
  formatChartValue,
  makeAxisTickFormatter,
} from "@/lib/charts/format";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { targetYTickCount } from "@/lib/charts/yAxisTickCount";
import {
  ChartLegend,
  useChartLegendState,
  seriesOpacity,
  type ChartLegendItem,
} from "@/components/charts/ChartLegend";
import { useDashboardTileContext } from "@/pages/Dashboard/lib/dashboardTileContext";
import {
  dispatchCrossFilter,
  isCrossFilterActive,
  toFilterValue,
} from "@/pages/Dashboard/lib/crossFilter";

export interface PointRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 36, left: 48 };
const DEFAULT_RADIUS = 4;
const SIZE_RANGE: [number, number] = [3, 22];

export function PointRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: PointRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  const colorCh = resolveChannel(spec.encoding.color);
  const sizeCh = resolveChannel(spec.encoding.size);
  const shapeCh = resolveChannel(spec.encoding.shape);

  if (!xCh || !yCh) {
    throw new Error("point mark requires x and y encodings");
  }
  // WD2-wiring-rest-point · dashboard-tile cross-filter dispatch is
  // CONDITIONAL on `colorCh` being non-null. Pure quantitative (x, y)
  // scatters have no categorical field to filter on — the dispatch
  // would carry a continuous number that can't be matched to an
  // existing categorical filter selection. When `colorCh` is set,
  // clicking a point dispatches `{ column: colorCh.field, value:
  // toFilterValue(<raw color>), sourceTileId }` so a click on any
  // point in the "North" group toggles a Region=North brush.
  const dashboardTile = useDashboardTileContext();
  const crossFilterReady = !!dashboardTile && !!colorCh;
  // WD2-dim-point · per-point dim factor for marks whose `rawColor`
  // isn't in the active categorical cross-filter on `colorCh.field`.
  // Diverges from WD2-dim-trend's per-series shape: scatter marks are
  // individually filter-targetable (each point's dispatch carries its
  // own `rawColor`), so the dim is also per-point. Gated on colorCh —
  // pure quantitative scatters (no color encoding) have no categorical
  // field to filter against; nothing to dim. Mirrors the
  // `crossFilterReady` gate above so the two opt-in conditions stay
  // aligned (dispatch + dim share the same applicability domain).
  const dashboardFilters = dashboardTile?.filters;
  const colorFilterSel = colorCh
    ? dashboardFilters?.[colorCh.field]
    : undefined;
  const dashboardDimActive =
    !!colorCh &&
    !!colorFilterSel &&
    colorFilterSel.type === "categorical" &&
    colorFilterSel.values.length > 0;

  // Color category map
  const colorIndex = useMemo(() => {
    if (!colorCh) return null;
    const seen = new Map<string, number>();
    let i = 0;
    for (const r of data) {
      const k = asString(colorCh.accessor(r));
      if (!seen.has(k)) seen.set(k, i++);
    }
    return seen;
  }, [colorCh, data]);

  // Shape category map (independent of color so users can encode 2 dims)
  const shapeIndex = useMemo(() => {
    if (!shapeCh) return null;
    const seen = new Map<string, number>();
    let i = 0;
    for (const r of data) {
      const k = asString(shapeCh.accessor(r));
      if (!seen.has(k)) seen.set(k, i++);
    }
    return seen;
  }, [shapeCh, data]);

  // Size scale
  const sizeScale = useMemo(() => {
    if (!sizeCh) return null;
    const ext = numericExtent(data, (r) => asNumber(sizeCh.accessor(r)));
    return scaleLinear<number>({ domain: ext, range: SIZE_RANGE });
  }, [sizeCh, data]);

  const xScale = useMemo(() => {
    const ext = numericExtent(data, (r) => asNumber(xCh.accessor(r)));
    const padded = paddedDomain(ext, 0.05);
    return scaleLinear<number>({
      domain: padded,
      range: [0, innerWidth],
      nice: true,
    });
  }, [data, xCh, innerWidth]);

  const yScale = useMemo(() => {
    const ext = numericExtent(data, (r) => asNumber(yCh.accessor(r)));
    const padded = paddedDomain(ext, 0.05);
    return scaleLinear<number>({
      domain: padded,
      range: [innerHeight, 0],
      nice: true,
    });
  }, [data, yCh, innerHeight]);

  const points = useMemo(() => {
    return data
      .map((r, i) => {
        const x = asNumber(xCh.accessor(r));
        const y = asNumber(yCh.accessor(r));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const sizeVal = sizeCh ? asNumber(sizeCh.accessor(r)) : Number.NaN;
        const radius = sizeScale && Number.isFinite(sizeVal)
          ? sizeScale(sizeVal)
          : DEFAULT_RADIUS;
        // Preserve the type-original color value (Date / number / boolean
        // / string) for cross-filter dispatch; `colorKey` is the
        // stringified form used for legend / opacity lookups.
        const rawColor = colorCh ? colorCh.accessor(r) : undefined;
        const colorKey = colorCh ? asString(rawColor) : "";
        const colorIdx = colorIndex ? colorIndex.get(colorKey) ?? 0 : 0;
        const shapeKey = shapeCh ? asString(shapeCh.accessor(r)) : "";
        const shapeIdx = shapeIndex ? shapeIndex.get(shapeKey) ?? 0 : 0;
        return {
          i,
          x,
          y,
          radius,
          color: qualitativeColor(colorIdx),
          colorKey,
          rawColor,
          shapeKey,
          shapeIdx,
          sizeVal,
          raw: r,
        };
      })
      .filter(<T,>(v: T | null): v is T => v !== null);
  }, [data, xCh, yCh, sizeCh, sizeScale, colorCh, colorIndex, shapeCh, shapeIndex]);

  const containerRef = useRef<SVGSVGElement | null>(null);
  const {
    tooltipOpen,
    tooltipLeft,
    tooltipTop,
    tooltipData,
    showTooltip,
    hideTooltip,
  } = useTooltip<{ point: (typeof points)[number] }>();

  const xTickFormat = useMemo(
    () => makeAxisTickFormatter(xCh.field),
    [xCh.field],
  );
  const yTickFormat = useMemo(
    () => makeAxisTickFormatter(yCh.field),
    [yCh.field],
  );

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Scatter chart";

  // Build legend items from the color category index when color encoding is set.
  const legendItems: ChartLegendItem[] = useMemo(() => {
    if (!colorIndex) return [];
    return Array.from(colorIndex.entries()).map(([key, idx]) => ({
      key,
      color: qualitativeColor(idx),
    }));
  }, [colorIndex]);
  const legend = useChartLegendState(legendItems);
  const showLegend = legendItems.length > 1;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <div className="relative flex flex-col" style={{ width, height }}>
      {showLegend && (
        <ChartLegend
          items={legendItems}
          state={legend.state}
          onHover={legend.onHover}
          onClick={legend.onClick}
          onShowAll={legend.onShowAll}
          className="mb-1 px-1"
        />
      )}
      <svg
        ref={containerRef}
        width={width}
        height={Math.max(0, height - (showLegend ? 28 : 0))}
        role="img"
        aria-label={accessibleLabel}
        onMouseLeave={hideTooltip}
      >
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
          {points.map((p) => {
            const op = legendItems.length > 0
              ? seriesOpacity(p.colorKey, legend.state)
              : 1;
            if (op === 0) return null;
            const cx = xScale(p.x) ?? 0;
            const cy = yScale(p.y) ?? 0;
            // WD2-dim-point · per-point dim against the active
            // categorical cross-filter on colorCh.field. `colorCh!` is
            // safe inside the non-null assertion because
            // `dashboardDimActive` AND-gates on `!!colorCh`. Single
            // `dimMul` lifted once per point so the fill (0.7 * op)
            // and the stroke (op) both consume the same factor —
            // keeps a dimmed point visually coherent (fill and ring
            // fade together).
            const isDashboardDimmed =
              dashboardDimActive &&
              !isCrossFilterActive(
                dashboardFilters!,
                colorCh!.field,
                p.rawColor,
              );
            const dimMul = isDashboardDimmed ? 0.4 : 1;
            const onPointMove = (e: React.MouseEvent<SVGElement>) => {
              const local = localPoint(e);
              showTooltip({
                tooltipLeft: local?.x ?? 0,
                tooltipTop: local?.y ?? 0,
                tooltipData: { point: p },
              });
            };
            const onPointClick = crossFilterReady
              ? () => {
                  dispatchCrossFilter({
                    column: colorCh!.field,
                    value: toFilterValue(p.rawColor),
                    sourceTileId: dashboardTile!.tileId,
                  });
                }
              : undefined;
            const cursorStyle = crossFilterReady
              ? { cursor: "pointer" as const }
              : undefined;
            // Use a glyph path when shape encoding is set; circle otherwise.
            if (shapeCh) {
              const shape = shapeFromIndex(p.shapeIdx);
              return (
                <path
                  key={`pt-${p.i}`}
                  d={glyphPath(shape, p.radius)}
                  transform={`translate(${cx},${cy})`}
                  fill={p.color}
                  fillOpacity={0.7 * op * dimMul}
                  stroke={p.color}
                  strokeOpacity={op * dimMul}
                  strokeWidth={1}
                  style={cursorStyle}
                  onMouseMove={onPointMove}
                  onMouseLeave={hideTooltip}
                  onClick={onPointClick}
                />
              );
            }
            return (
              <Circle
                key={`pt-${p.i}`}
                cx={cx}
                cy={cy}
                r={p.radius}
                fill={p.color}
                fillOpacity={0.7 * op * dimMul}
                stroke={p.color}
                strokeOpacity={op * dimMul}
                strokeWidth={1}
                style={cursorStyle}
                onMouseMove={onPointMove}
                onMouseLeave={hideTooltip}
                onClick={onPointClick}
              />
            );
          })}
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            stroke="hsl(var(--border))"
            tickStroke="hsl(var(--border))"
            tickFormat={(v) => xTickFormat(v as number)}
            tickLabelProps={() => ({
              fill: "hsl(var(--muted-foreground))",
              fontSize: 11,
              fontFamily: "var(--font-sans)",
              textAnchor: "middle",
            })}
            numTicks={targetYTickCount(innerWidth)}
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
          />
        </Group>
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          style={{ ...visxTooltipStyles, background: "transparent", padding: 0 }}
        >
          <ChartTooltip
            title={
              tooltipData.point.colorKey || `(${tooltipData.point.x}, ${tooltipData.point.y})`
            }
            rows={[
              {
                color: tooltipData.point.color,
                label: xCh.field,
                value: formatChartValue(tooltipData.point.x, xCh.field),
              },
              {
                color: tooltipData.point.color,
                label: yCh.field,
                value: formatChartValue(tooltipData.point.y, yCh.field),
              },
              ...(sizeCh
                ? [
                    {
                      color: tooltipData.point.color,
                      label: sizeCh.field,
                      value: formatChartValue(
                        tooltipData.point.sizeVal,
                        sizeCh.field,
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </TooltipWithBounds>
      )}
    </div>
  );
}
