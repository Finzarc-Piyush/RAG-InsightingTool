/**
 * Visx renderer for the `point` mark (scatter / bubble).
 *
 *   - Both x and y are quantitative.
 *   - Optional `color` encoding → distinct categorical groups.
 *   - Optional `size` encoding → marker radius (bubble chart).
 *   - Hover tooltip with [x, y, color, size] context.
 */

import { useEffect, useMemo, useRef, useState } from "react";
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
import { placeLabelsNoOverlap } from "@/lib/charts/labelCollision";
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
import {
  dispatchDrillThrough,
  isModifierClick,
} from "@/pages/Dashboard/lib/drillThrough";
import {
  BRUSH_MIN_PX,
  dispatchExplainSlice,
  isBrushDrag,
  makeBox2dRegion,
} from "@/pages/Dashboard/lib/explainSlice";

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

  // Wave WI4-wiring-point · 2D brush state for the explain-this-slice
  // intent. Scatter is the only chart kind with TWO independently-
  // continuous axes, so the brush captures a rectangle in pixel space
  // (both x and y dimensions) — distinct from the 1D brush in Line /
  // Area / Bar where only the x-axis is brushed. brushStart and
  // brushEnd carry {x, y} pixel coords inside the inner-plot space
  // (svg coord minus MARGIN.left / MARGIN.top); null when no brush is
  // active. brushExplainRef captures `e.altKey === true` at brushDown
  // — ref (not state) because the alt flag doesn't drive a re-render.
  const [brushStart, setBrushStart] = useState<
    { x: number; y: number } | null
  >(null);
  const [brushEnd, setBrushEnd] = useState<
    { x: number; y: number } | null
  >(null);
  const brushExplainRef = useRef<boolean>(false);

  useEffect(() => {
    setBrushStart(null);
    setBrushEnd(null);
  }, [data]);

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

  // Wave WI4-wiring-point · 2D brush handlers gated on `dashboardTile`
  // (outside a dashboard the explain panel has no receiver). The
  // three handlers (`onBrushDown` / `onBrushMove` / `onBrushUp`)
  // mirror the WI4-wiring-area shape but track both x AND y pixel
  // coords because the box2d brush spans two dimensions.
  const onBrushDown = (e: React.MouseEvent<SVGElement>) => {
    const pt = localPoint(e);
    if (!pt) return;
    const x = pt.x - MARGIN.left;
    const y = pt.y - MARGIN.top;
    if (x < 0 || x > innerWidth) return;
    if (y < 0 || y > innerHeight) return;
    brushExplainRef.current = e.altKey === true;
    setBrushStart({ x, y });
    setBrushEnd({ x, y });
  };

  const onBrushMove = (e: React.MouseEvent<SVGElement>) => {
    if (brushStart === null) return;
    if (!(e.buttons & 1)) return;
    const pt = localPoint(e);
    if (!pt) return;
    const x = Math.max(0, Math.min(innerWidth, pt.x - MARGIN.left));
    const y = Math.max(0, Math.min(innerHeight, pt.y - MARGIN.top));
    setBrushEnd({ x, y });
  };

  const onBrushUp = () => {
    if (brushStart === null || brushEnd === null) {
      brushExplainRef.current = false;
      setBrushStart(null);
      setBrushEnd(null);
      return;
    }
    // Both axes must cross BRUSH_MIN_PX for a 2D rectangle to count as
    // a drag — a 100×3 sliver is still a click in either axis alone.
    // The constructor's zero-area rejection is a separate downstream
    // guard; this gate is the click-vs-drag split that matches the
    // 1D brushes' isBrushDrag check on the load-bearing dimension.
    const isDrag =
      isBrushDrag(brushStart.x, brushEnd.x, BRUSH_MIN_PX) &&
      isBrushDrag(brushStart.y, brushEnd.y, BRUSH_MIN_PX);
    if (!isDrag) {
      brushExplainRef.current = false;
      setBrushStart(null);
      setBrushEnd(null);
      return;
    }
    if (brushExplainRef.current && dashboardTile) {
      // Invert pixel coords back to data space. yScale's range is
      // [innerHeight, 0] (inverted) so its invert maps low-pixel-y
      // to high-data-y — the constructor normalises so the data-space
      // yMin / yMax come out correctly regardless of pixel drag
      // direction.
      const x1Data = xScale.invert(brushStart.x);
      const x2Data = xScale.invert(brushEnd.x);
      const y1Data = yScale.invert(brushStart.y);
      const y2Data = yScale.invert(brushEnd.y);
      const region = makeBox2dRegion(
        x1Data,
        x2Data,
        y1Data,
        y2Data,
        yCh.field,
      );
      if (region) {
        dispatchExplainSlice({
          chartId: dashboardTile.tileId,
          column: xCh.field,
          region,
          sourceTileId: dashboardTile.tileId,
          filters: dashboardFilters,
        });
      }
    }
    brushExplainRef.current = false;
    setBrushStart(null);
    setBrushEnd(null);
  };

  const onSvgMouseLeave = () => {
    hideTooltip();
    if (brushStart !== null) {
      brushExplainRef.current = false;
      setBrushStart(null);
      setBrushEnd(null);
    }
  };

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
        onMouseLeave={onSvgMouseLeave}
        onMouseDown={dashboardTile ? onBrushDown : undefined}
        onMouseMove={dashboardTile ? onBrushMove : undefined}
        onMouseUp={dashboardTile ? onBrushUp : undefined}
        style={
          brushStart !== null
            ? { cursor: "crosshair" }
            : undefined
        }
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
          {brushStart !== null && brushEnd !== null && (
            <rect
              x={Math.min(brushStart.x, brushEnd.x)}
              y={Math.min(brushStart.y, brushEnd.y)}
              width={Math.abs(brushEnd.x - brushStart.x)}
              height={Math.abs(brushEnd.y - brushStart.y)}
              fill="hsl(var(--primary))"
              fillOpacity={0.1}
              stroke="hsl(var(--primary))"
              strokeOpacity={0.4}
              strokeDasharray="3 3"
              pointerEvents="none"
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
              // Wave WI4-wiring-point · suppress tooltip during an
              // active brush so it doesn't flicker between points the
              // brush drag passes over. Same guard shape BarRenderer
              // uses for its onMouseMove.
              if (brushStart !== null) return;
              const local = localPoint(e);
              showTooltip({
                tooltipLeft: local?.x ?? 0,
                tooltipTop: local?.y ?? 0,
                tooltipData: { point: p },
              });
            };
            // WD3-wiring-rest-point · cmd / ctrl-click branches to
            // drill-through INSTEAD of cross-filter — same single-event-
            // handler shape as the WD3-wiring-rest-cat family because
            // PointRenderer's onClick already lives at the per-mark
            // level (per-point dispatch was the WD2 design). Drill is
            // gated on the SAME `crossFilterReady` AND-gate as cross-
            // filter (pure quant scatters with no colorCh have no
            // categorical drill target either — the two opt-in domains
            // are identical). Value passed RAW (NOT toFilterValue-
            // coerced) — server-side canonicalisation picks Date /
            // number / categorical comparison per the inferred column
            // type. The `return;` after the drill dispatch is single-
            // intent-load-bearing: without it a cmd-click would
            // dispatch BOTH events.
            const onPointClick = crossFilterReady
              ? (e: React.MouseEvent<SVGElement>) => {
                  if (isModifierClick(e)) {
                    dispatchDrillThrough({
                      chartId: dashboardTile!.tileId,
                      column: colorCh!.field,
                      value: p.rawColor,
                      sourceTileId: dashboardTile!.tileId,
                      filters: dashboardFilters,
                    });
                    return;
                  }
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
          {/* Wave W-GMK8 · inline data labels on points. Greedy bbox
              collision drops labels where adjacent points would overlap. */}
          {(() => {
            const cfg = (spec.config ?? {}) as { dataLabels?: boolean };
            if (cfg.dataLabels === false) return null;
            const candidates: Array<{
              cx: number;
              cy: number;
              text: string;
              priority: number;
            }> = [];
            for (const p of points) {
              const op = legendItems.length > 0
                ? seriesOpacity(p.colorKey, legend.state)
                : 1;
              if (op === 0) continue;
              const cx = xScale(p.x);
              const cy = yScale(p.y);
              if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
              candidates.push({
                cx: cx as number,
                cy: cy as number,
                text: formatChartValue(p.y, yCh.field),
                priority: Math.abs((p.y as number) ?? 0),
              });
            }
            const placed = placeLabelsNoOverlap(candidates, {
              fontSize: 10,
              padding: 2,
              bounds: { x: 0, y: 0, w: innerWidth, h: innerHeight },
            });
            return placed.map((p, i) => (
              <text
                key={`dl-${i}`}
                x={p.cx}
                y={p.cy - 8}
                fontSize={10}
                fontFamily="var(--font-sans)"
                fill="hsl(var(--foreground))"
                textAnchor="middle"
                pointerEvents="none"
              >
                {p.text}
              </text>
            ));
          })()}
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
