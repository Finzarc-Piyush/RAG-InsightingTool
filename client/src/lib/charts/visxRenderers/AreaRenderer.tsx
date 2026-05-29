/**
 * Visx renderer for the `area` mark. Reuses the LineRenderer pattern
 * but draws a closed area instead of a line. Multi-series areas stack
 * by default (matching v1 stacked-area behavior).
 *
 * Single-series: filled area beneath the line.
 * Multi-series:  stacked areas, each in chart-1..12.
 * Dual-axis y2 not supported on area (use line + area combo via combo mark).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Group } from "@visx/group";
import { AreaClosed, LinePath } from "@visx/shape";
import { scaleLinear, scalePoint, scaleTime } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import {
  useTooltip,
  TooltipWithBounds,
  defaultStyles as visxTooltipStyles,
} from "@visx/tooltip";
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
import { formatChartValue, makeAxisTickFormatter } from "@/lib/charts/format";
import { placeLabelsNoOverlap } from "@/lib/charts/labelCollision";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { targetYTickCount } from "@/lib/charts/yAxisTickCount";
import {
  MAX_X_AXIS_LABELS,
  pickEvenlySpacedTicks,
} from "@/lib/charts/xAxisLabelCap";
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
// Wave WD3-wiring-rest-trend · cmd / ctrl-click on the area surface
// routes the nearest-x lookup to drill-through instead of cross-filter.
import {
  dispatchDrillThrough,
  isModifierClick,
} from "@/pages/Dashboard/lib/drillThrough";
// Wave WI4-wiring-area · alt-drag on the area surface routes the
// brushed sub-domain to explain-this-slice. AreaRenderer has no
// pre-existing brush mechanics, so this wave ADDS the mouse-down /
// move / up state + a `<rect>` overlay from scratch (mirroring the
// LineRenderer shape) but DELIBERATELY OMITS the brush-to-zoom
// branch — Area charts are rarely zoomed and the disambiguation
// complexity LineRenderer has (plain drag = zoom, alt drag = explain)
// is not warranted here. Plain drag is a no-op; click paths
// (cross-filter, drill-through on cmd/ctrl) continue to flow through
// the existing onClick handler.
import {
  BRUSH_MIN_PX,
  dispatchExplainSlice,
  isBrushDrag,
  makeCategoricalRegion,
  makeTemporalRegion,
} from "@/pages/Dashboard/lib/explainSlice";

export interface AreaRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 36, left: 48 };

interface SeriesPoint {
  x: unknown;
  y: number;
}
interface Series {
  key: string;
  color: string;
  /**
   * WD2-dim-trend · type-original color value, preserved alongside the
   * stringified `key` so the dim check can call `isCrossFilterActive`
   * with the same shape the WD2 cross-filter event recorded. Undefined
   * for the single-series (no colorCh) case.
   */
  rawColor?: unknown;
  points: SeriesPoint[];
}

function asTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : Number.NaN;
  }
  return Number.NaN;
}

export function AreaRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: AreaRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  const colorCh = resolveChannel(spec.encoding.color);

  if (!xCh || !yCh) {
    throw new Error("area mark requires x and y encodings");
  }

  const isTemporal = xCh.type === "t";
  // WD2-wiring-rest-trend · dashboard-tile cross-filter dispatch. A
  // click anywhere inside the svg is treated as a brush onto the
  // nearest x value in any (non-stacked) series. Outside a dashboard
  // tile `dashboardTile` is null and the click is a no-op.
  const dashboardTile = useDashboardTileContext();
  // WD2-dim-trend · dim non-matching series at 0.4 of their existing
  // fill/stroke opacities when an active categorical cross-filter on
  // `colorCh.field` doesn't include the series's rawColor. Per-series
  // (not per-point) because area trends are continuous on x. Gated on
  // colorCh — single-series areas have no color field to filter against.
  const dashboardFilters = dashboardTile?.filters;
  const colorFilterSel = colorCh
    ? dashboardFilters?.[colorCh.field]
    : undefined;
  const dashboardDimActive =
    !!colorCh &&
    !!colorFilterSel &&
    colorFilterSel.type === "categorical" &&
    colorFilterSel.values.length > 0;

  // Wave WI4-wiring-area · brush state. AreaRenderer has no brush-to-
  // zoom (deliberate scope decision — Area charts rarely warrant zoom),
  // so this state is consumed ONLY by the WI4 alt-drag dispatcher. A
  // plain drag updates brushEnd as the cursor moves but doesn't fire
  // any dispatch at mouseUp; an alt-drag does. The `<rect>` overlay
  // renders during any drag (alt or plain) so the user sees the brush
  // affordance and can release alt before mouseUp to cancel.
  const [brushStart, setBrushStart] = useState<number | null>(null);
  const [brushEnd, setBrushEnd] = useState<number | null>(null);
  // Wave WI4-wiring-area · captures the alt-key state at brushDown so
  // the parameterless onBrushUp handler can branch to explain-this-
  // slice. useRef (not useState) because the flag doesn't drive a
  // re-render. Mirrors LineRenderer's `brushExplainRef` shape.
  const brushExplainRef = useRef<boolean>(false);

  // Wave WHov-area-crosshair · tooltip state for hover nearest-x snap.
  const {
    tooltipOpen,
    tooltipLeft,
    tooltipTop,
    tooltipData,
    showTooltip,
    hideTooltip,
  } = useTooltip<{
    xRaw: unknown;
    rows: Array<{ key: string; color: string; value: number }>;
  }>();

  // Wave WI4-wiring-area · reset brush state when the underlying data
  // changes (encoding shelf change, cross-filter applied, etc.). Stale
  // brush coords on stale data would render a misleading overlay.
  useEffect(() => {
    setBrushStart(null);
    setBrushEnd(null);
  }, [data]);

  const series: Series[] = useMemo(() => {
    if (!colorCh) {
      return [
        {
          key: yCh.field,
          color: qualitativeColor(0),
          points: data.map((r) => ({
            x: xCh.accessor(r),
            y: asNumber(yCh.accessor(r)),
          })),
        },
      ];
    }
    // WD2-dim-trend · preserve the type-original color value (first
    // occurrence per group) alongside the stringified key.
    const groups = new Map<
      string,
      { points: SeriesPoint[]; rawColor: unknown }
    >();
    for (const r of data) {
      const rawColor = colorCh.accessor(r);
      const k = asString(rawColor);
      const existing = groups.get(k);
      if (existing) {
        existing.points.push({
          x: xCh.accessor(r),
          y: asNumber(yCh.accessor(r)),
        });
      } else {
        groups.set(k, {
          points: [
            { x: xCh.accessor(r), y: asNumber(yCh.accessor(r)) },
          ],
          rawColor,
        });
      }
    }
    let i = 0;
    return Array.from(groups.entries()).map(([key, agg]) => ({
      key,
      color: qualitativeColor(i++),
      rawColor: agg.rawColor,
      points: agg.points,
    }));
  }, [data, xCh, yCh, colorCh]);

  // Stack multi-series areas: y becomes cumulative.
  const stacked = useMemo(() => {
    if (series.length <= 1) return series;
    // Build a unified ordered x domain.
    const xKeys = Array.from(
      new Set(
        data.map((r) => asString(xCh.accessor(r))),
      ),
    );
    const out: Series[] = [];
    const totals = new Map<string, number>();
    for (const s of series) {
      const stackedPoints = xKeys.map((xk) => {
        const found = s.points.find((p) => asString(p.x) === xk);
        const v = found?.y ?? 0;
        const prev = totals.get(xk) ?? 0;
        const next = prev + v;
        totals.set(xk, next);
        return {
          x: found?.x ?? xk,
          y: next,
          // Stash the per-series original value for tooltip / animation.
          _original: v,
        } as SeriesPoint & { _original: number };
      });
      out.push({ ...s, points: stackedPoints });
    }
    return out;
  }, [series, data, xCh]);

  const xScale = useMemo(() => {
    if (isTemporal) {
      const times = data
        .map((r) => asTime(xCh.accessor(r)))
        .filter((t) => Number.isFinite(t));
      const min = times.length ? Math.min(...times) : 0;
      const max = times.length ? Math.max(...times) : 1;
      return scaleTime({
        domain: [new Date(min), new Date(max)],
        range: [0, innerWidth],
      });
    }
    const xs = Array.from(new Set(data.map((r) => asString(xCh.accessor(r)))));
    return scalePoint<string>({
      domain: xs,
      range: [0, innerWidth],
      padding: 0.5,
    });
  }, [isTemporal, data, xCh, innerWidth]);

  const yScale = useMemo(() => {
    const flat: number[] = [];
    for (const s of stacked) for (const p of s.points) flat.push(p.y);
    const ext = numericExtent(
      flat.map((v) => ({ v })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    // Areas anchor at 0.
    return scaleLinear<number>({
      domain: [Math.min(0, ext[0]), Math.max(0, ext[1] * 1.05)],
      range: [innerHeight, 0],
      nice: true,
    });
  }, [stacked, innerHeight]);

  const xPx = (xRaw: unknown): number => {
    if (isTemporal) {
      const t = asTime(xRaw);
      return Number.isFinite(t)
        ? (xScale as ReturnType<typeof scaleTime<number>>)(new Date(t)) ?? 0
        : 0;
    }
    const s = asString(xRaw);
    const v = (xScale as ReturnType<typeof scalePoint<string>>)(s);
    return v ?? 0;
  };

  // Wave WI4-wiring-area · brush mouse handlers. The shape mirrors
  // LineRenderer's onBrushDown / onMouseMove / onBrushUp but without
  // the zoom branch in onBrushUp (Area doesn't need it). The handlers
  // co-exist with the existing onClick: a clean click (no drag) fires
  // mouseDown → mouseUp (small distance, reset state, return) → click
  // (existing cross-filter / drill-through logic); an alt-drag fires
  // mouseDown → mouseMove* → mouseUp (drag ≥ BRUSH_MIN_PX + alt held
  // → dispatchExplainSlice, reset state); a plain drag fires
  // mouseDown → mouseMove* → mouseUp (drag ≥ BRUSH_MIN_PX, no alt →
  // reset state, no dispatch). The browser does NOT fire `click` after
  // a drag, so the two handlers don't conflict.
  const onBrushDown = (e: React.MouseEvent<SVGElement>) => {
    const pt = localPoint(e);
    if (!pt) return;
    const x = pt.x - MARGIN.left;
    if (x < 0 || x > innerWidth) return;
    setBrushStart(x);
    setBrushEnd(x);
    brushExplainRef.current = e.altKey === true;
  };

  // Wave WHov-area-crosshair · combined handler: brush drag + hover
  // nearest-x tooltip. Mirrors LineRenderer's onMouseMove shape.
  const onMouseMove = (e: React.MouseEvent<SVGElement>) => {
    const pt = localPoint(e);
    if (!pt) return;
    if (brushStart !== null && (e.buttons & 1)) {
      const x = pt.x - MARGIN.left;
      setBrushEnd(Math.max(0, Math.min(innerWidth, x)));
    }
    const localX = pt.x - MARGIN.left;
    if (localX < 0 || localX > innerWidth) {
      hideTooltip();
      return;
    }
    let nearest: SeriesPoint | null = null;
    let minDx = Infinity;
    for (const s of series) {
      for (const p of s.points) {
        const px = xPx(p.x);
        const dx = Math.abs(px - localX);
        if (dx < minDx) {
          minDx = dx;
          nearest = p;
        }
      }
    }
    if (!nearest) return;
    const xRaw = nearest.x;
    const rows = series
      .map((s) => {
        const found = s.points.find((p) => xPx(p.x) === xPx(xRaw));
        if (!found) return null;
        return { key: s.key, color: s.color, value: found.y };
      })
      .filter((r): r is { key: string; color: string; value: number } => !!r);
    showTooltip({
      tooltipLeft: pt.x,
      tooltipTop: pt.y,
      tooltipData: { xRaw, rows },
    });
  };

  const onBrushUp = () => {
    if (brushStart === null || brushEnd === null) return;
    const lo = Math.min(brushStart, brushEnd);
    const hi = Math.max(brushStart, brushEnd);
    // Click-vs-drag threshold from the WI4 foundation. Sub-threshold
    // drags are treated as a click — reset state and let the existing
    // svg onClick handler fire (cross-filter / drill-through). The
    // browser fires `click` after a same-position mouseUp, so this
    // branch yields control cleanly.
    if (!isBrushDrag(brushStart, brushEnd, BRUSH_MIN_PX)) {
      brushExplainRef.current = false;
      setBrushStart(null);
      setBrushEnd(null);
      return;
    }
    // Alt-drag → dispatch explain-this-slice. Plain drag → no-op
    // (Area has no brush-to-zoom). Gated on dashboardTile because
    // outside a dashboard there's no panel receiver.
    if (brushExplainRef.current && dashboardTile) {
      let region = null;
      if (isTemporal) {
        const dom = (xScale as ReturnType<typeof scaleTime<number>>).domain();
        const domMin = (dom[0] as Date).getTime();
        const domMax = (dom[1] as Date).getTime();
        const startMs = domMin + (lo / innerWidth) * (domMax - domMin);
        const endMs = domMin + (hi / innerWidth) * (domMax - domMin);
        region = makeTemporalRegion(startMs, endMs);
      } else {
        const xs = Array.from(
          new Set(data.map((r) => asString(xCh.accessor(r)))),
        );
        const i0 = Math.max(0, Math.floor((lo / innerWidth) * xs.length));
        const i1 = Math.min(
          xs.length,
          Math.ceil((hi / innerWidth) * xs.length),
        );
        region = makeCategoricalRegion(xs.slice(i0, i1));
      }
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

  const xTickFormat = useMemo(
    () => makeAxisTickFormatter(xCh.field),
    [xCh.field],
  );

  const xTickValues = useMemo<Array<Date | string>>(() => {
    if (isTemporal) {
      const candidates = (xScale as ReturnType<typeof scaleTime>).ticks(
        MAX_X_AXIS_LABELS,
      );
      return pickEvenlySpacedTicks(candidates, MAX_X_AXIS_LABELS);
    }
    const domain = (xScale as ReturnType<typeof scalePoint<string>>).domain();
    return pickEvenlySpacedTicks(domain, MAX_X_AXIS_LABELS);
  }, [xScale, isTemporal]);
  const yTickFormat = useMemo(
    () => makeAxisTickFormatter(yCh.field),
    [yCh.field],
  );

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Area chart";

  const legendItems: ChartLegendItem[] = useMemo(
    () => series.map((s) => ({ key: s.key, color: s.color })),
    [series],
  );
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
      width={width}
      height={Math.max(0, height - (showLegend ? 28 : 0))}
      role="img"
      aria-label={accessibleLabel}
      // Wave WI4-wiring-area · cursor reflects the active brush. During
      // a drag, show `ew-resize` (the same affordance LineRenderer uses
      // for its brush). Outside a drag, fall back to the WD2 pointer if
      // the area is mounted inside a dashboard tile, else default.
      style={
        brushStart !== null
          ? { cursor: "ew-resize" }
          : dashboardTile
            ? { cursor: "pointer" }
            : undefined
      }
      // Wave WI4-wiring-area · brush handlers gated on dashboardTile.
      // Outside a dashboard the brush has no receiver (no panel to
      // open), so attaching the handlers would just cause confusing
      // visual feedback. Inside a dashboard, mouseDown / move / up
      // power the alt-drag → explain-this-slice intent; the existing
      // onClick co-exists for cross-filter / drill-through clicks.
      onMouseDown={dashboardTile ? onBrushDown : undefined}
      onMouseMove={onMouseMove}
      onMouseUp={dashboardTile ? onBrushUp : undefined}
      onMouseLeave={() => {
        hideTooltip();
        if (brushStart !== null) {
          brushExplainRef.current = false;
          setBrushStart(null);
          setBrushEnd(null);
        }
      }}
      onClick={
        dashboardTile
          ? (e: React.MouseEvent<SVGElement>) => {
              // Source the click position in svg coords, subtract the
              // left margin so the position maps to the inner-plot
              // origin used by `xPx`. Reads from the PRE-stack series
              // (which holds the original per-series points) rather
              // than `stacked` because the stacked y values would
              // skew the nearest-x lookup in multi-series mode.
              const pt = localPoint(e);
              if (!pt) return;
              const clickX = pt.x - MARGIN.left;
              if (clickX < 0 || clickX > innerWidth) return;
              let nearest: SeriesPoint | null = null;
              let minDx = Infinity;
              for (const s of series) {
                for (const p of s.points) {
                  const px = xPx(p.x);
                  const dx = Math.abs(px - clickX);
                  if (dx < minDx) {
                    minDx = dx;
                    nearest = p;
                  }
                }
              }
              if (nearest) {
                // Wave WD3-wiring-rest-trend · cmd/ctrl-click routes
                // the nearest-x value to drill-through instead of
                // cross-filter. The lookup is identical — only the
                // dispatcher diverges.
                if (isModifierClick(e)) {
                  dispatchDrillThrough({
                    chartId: dashboardTile.tileId,
                    column: xCh.field,
                    value: nearest.x,
                    sourceTileId: dashboardTile.tileId,
                    filters: dashboardFilters,
                  });
                  return;
                }
                dispatchCrossFilter({
                  column: xCh.field,
                  value: toFilterValue(nearest.x),
                  sourceTileId: dashboardTile.tileId,
                });
              }
            }
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
        {/* Wave WI4-wiring-area · brush rectangle while dragging. Same
            styling as LineRenderer's overlay (primary tint at 0.1
            fill + 0.4 stroke + dashed 3 3) so the brush affordance
            reads consistently across the two trend renderers.
            pointerEvents="none" so the overlay never intercepts the
            mouseUp / click that would otherwise be captured by the
            svg's handlers. */}
        {brushStart !== null && brushEnd !== null && (
          <rect
            x={Math.min(brushStart, brushEnd)}
            y={0}
            width={Math.abs(brushEnd - brushStart)}
            height={innerHeight}
            fill="hsl(var(--primary))"
            fillOpacity={0.1}
            stroke="hsl(var(--primary))"
            strokeOpacity={0.4}
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        )}
        {/* Wave WHov-area-crosshair · vertical cross-hair at the
            snapped nearest-x during hover. Mirrors the LineRenderer
            WHov-line-crosshair pattern: one vertical line at the
            x-pixel of tooltipData.xRaw (the SNAPPED bucket, NOT the
            raw cursor x). Gated on brushStart === null so an active
            brush rectangle isn't crossed by a stray indicator line.
            pointerEvents="none" so the line can't capture mouse
            events meant for the hover/brush surface. Placed under
            the data areas so the filled shapes render OVER the
            indicator — standard layering for this pattern. */}
        {tooltipOpen && tooltipData && brushStart === null && (() => {
          const cx = xPx(tooltipData.xRaw);
          if (!Number.isFinite(cx)) return null;
          return (
            <line
              x1={cx}
              x2={cx}
              y1={0}
              y2={innerHeight}
              stroke="hsl(var(--muted-foreground))"
              strokeOpacity={0.45}
              strokeDasharray="3 3"
              strokeWidth={1}
              pointerEvents="none"
            />
          );
        })()}
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
        {/* Render in reverse so earliest series ends up on top of stack. */}
        {[...stacked].reverse().map((s) => {
          const op = seriesOpacity(s.key, legend.state);
          if (op === 0) return null;
          // WD2-dim-trend · series-level dim factor against colorCh
          // filter membership. Applied to BOTH the AreaClosed fill
          // and the bordering LinePath stroke so a dimmed series is
          // visually coherent (an area dim without the line dim would
          // produce a stark border around faded fills).
          const isDashboardDimmed =
            dashboardDimActive &&
            !isCrossFilterActive(
              dashboardFilters!,
              colorCh!.field,
              s.rawColor,
            );
          const dimMul = isDashboardDimmed ? 0.4 : 1;
          return (
            <Group key={`a-${s.key}`}>
              <AreaClosed
                data={s.points}
                x={(p) => xPx(p.x)}
                y={(p) => yScale(p.y) ?? 0}
                yScale={yScale}
                fill={s.color}
                fillOpacity={0.55 * op * dimMul}
                curve={curveMonotoneX}
              />
              <LinePath
                data={s.points}
                x={(p) => xPx(p.x)}
                y={(p) => yScale(p.y) ?? 0}
                stroke={s.color}
                strokeWidth={1.5}
                strokeOpacity={op * dimMul}
                curve={curveMonotoneX}
                fill="none"
              />
            </Group>
          );
        })}
        {/* Wave W-GMK8 · inline data labels at each pre-stack point.
            Greedy bbox collision thins dense labels. */}
        {(() => {
          const cfg = (spec.config ?? {}) as { dataLabels?: boolean };
          if (cfg.dataLabels === false) return null;
          const candidates: Array<{
            cx: number;
            cy: number;
            text: string;
            priority: number;
          }> = [];
          for (const s of series) {
            const op = seriesOpacity(s.key, legend.state);
            if (op === 0) continue;
            for (const p of s.points) {
              const px = xPx(p.x);
              const py = yScale(p.y);
              if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
              candidates.push({
                cx: px,
                cy: py,
                text: formatChartValue(p.y, yCh.field),
                priority: Math.abs((p.y as number) ?? 0),
              });
            }
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
              y={p.cy - 6}
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
          tickFormat={(v: unknown) => xTickFormat(v)}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 11,
            fontFamily: "var(--font-sans)",
            textAnchor: "middle",
          })}
          tickValues={xTickValues}
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
              isTemporal
                ? formatChartValue(tooltipData.xRaw, xCh.field, {
                    format: "date",
                  })
                : asString(tooltipData.xRaw)
            }
            rows={tooltipData.rows.map((r) => ({
              color: r.color,
              label: r.key,
              value: formatChartValue(r.value, yCh.field),
            }))}
          />
        </TooltipWithBounds>
      )}
    </div>
  );
}
