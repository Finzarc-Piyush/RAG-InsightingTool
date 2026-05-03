/**
 * Visx renderer for the `line` mark. Supports:
 *   - Single-series (no color encoding) — one line in chart-1.
 *   - Multi-series via `encoding.color` — N lines cycling chart-1..12.
 *   - Temporal X (`type: 't'`) renders via scaleTime; nominal/ordinal
 *     fall back to scalePoint.
 *   - Hover tooltip with all-series snapshot at the hovered X.
 *
 * Dual-axis Y2 is wired via encoding.y2 (separate scale; same X).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Group } from "@visx/group";
import { LinePath } from "@visx/shape";
import { scaleLinear, scalePoint, scaleTime } from "@visx/scale";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
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
import {
  formatChartValue,
  makeAxisTickFormatter,
} from "@/lib/charts/format";
import {
  MAX_X_AXIS_LABELS,
  pickEvenlySpacedTicks,
} from "@/lib/charts/xAxisLabelCap";
import {
  detectOutliers,
  fitLinearTrend,
  forecastSeries,
  pickAnnotations,
  pickComparisonLayer,
  pickForecastLayer,
  pickOutliersLayer,
  pickTrendLayer,
  priorPeriodSeries,
  resolveReferenceLines,
} from "@/lib/charts/layers";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import {
  ChartLegend,
  useChartLegendState,
  seriesOpacity,
  type ChartLegendItem,
} from "@/components/charts/ChartLegend";

export interface LineRendererProps {
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
  raw: Row;
}
interface Series {
  key: string;
  color: string;
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

export function LineRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: LineRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  const colorCh = resolveChannel(spec.encoding.color);
  const y2Ch = resolveChannel(spec.encoding.y2);
  // Multi-secondary series. When non-empty, takes precedence over the
  // single y2 channel — each entry gets its own dashed line on the
  // right axis with a color from chart-N+i.
  const y2ChannelsList = useMemo(() => {
    const arr = (spec.encoding.y2Series ?? [])
      .map((c) => resolveChannel(c))
      .filter((c): c is NonNullable<ReturnType<typeof resolveChannel>> => !!c);
    if (arr.length > 0) return arr;
    return y2Ch ? [y2Ch] : [];
  }, [spec.encoding.y2Series, y2Ch]);

  if (!xCh || !yCh) {
    throw new Error("line mark requires x and y encodings");
  }

  const isTemporal = xCh.type === "t";
  const yIsRight = y2ChannelsList.length > 0;

  // WC6.1 brush-to-zoom state (declared up-front so memos that derive scales
  // can read zoomRange).
  const [brushStart, setBrushStart] = useState<number | null>(null);
  const [brushEnd, setBrushEnd] = useState<number | null>(null);
  const [zoomRange, setZoomRange] = useState<[number, number] | null>(null);

  // Fix-5 · reset brush state when the underlying data changes (encoding
  // shelf change, cross-filter applied, etc.). Stale zoom on stale data
  // would otherwise mislead the user.
  useEffect(() => {
    setZoomRange(null);
    setBrushStart(null);
    setBrushEnd(null);
  }, [data]);

  // Build series
  const series: Series[] = useMemo(() => {
    if (!colorCh) {
      return [
        {
          key: yCh.field,
          color: qualitativeColor(0),
          points: data.map((r) => ({
            x: xCh.accessor(r),
            y: asNumber(yCh.accessor(r)),
            raw: r,
          })),
        },
      ];
    }
    const groups = new Map<string, SeriesPoint[]>();
    for (const r of data) {
      const k = asString(colorCh.accessor(r));
      const arr = groups.get(k) ?? [];
      arr.push({
        x: xCh.accessor(r),
        y: asNumber(yCh.accessor(r)),
        raw: r,
      });
      groups.set(k, arr);
    }
    let i = 0;
    return Array.from(groups.entries()).map(([key, points]) => ({
      key,
      color: qualitativeColor(i++),
      points,
    }));
  }, [data, xCh, yCh, colorCh]);

  // Build per-channel secondary-axis series. Color cycles starting
  // after the primary-axis colors so the legend remains distinct.
  const y2SeriesList: Series[] = useMemo(() => {
    return y2ChannelsList.map((ch, i) => ({
      key: ch.field,
      color: qualitativeColor(series.length + i),
      points: data.map((r) => ({
        x: xCh.accessor(r),
        y: asNumber(ch.accessor(r)),
        raw: r,
      })),
    }));
  }, [data, xCh, y2ChannelsList, series.length]);
  // Backwards-compat alias: the rest of the function still uses y2Series
  // in places that referenced "the secondary"; we keep it as the FIRST
  // entry of the list (or null if none).
  const y2Series: Series | null = y2SeriesList[0] ?? null;

  // Scales
  const xScale = useMemo(() => {
    if (isTemporal) {
      const times = data
        .map((r) => asTime(xCh.accessor(r)))
        .filter((t) => Number.isFinite(t));
      const min = times.length ? Math.min(...times) : 0;
      const max = times.length ? Math.max(...times) : 1;
      const domainMin = zoomRange ? new Date(zoomRange[0]) : new Date(min);
      const domainMax = zoomRange ? new Date(zoomRange[1]) : new Date(max);
      return scaleTime({
        domain: [domainMin, domainMax],
        range: [0, innerWidth],
      });
    }
    const xs = Array.from(new Set(data.map((r) => asString(xCh.accessor(r)))));
    // For non-temporal axes, zoom by index slice when zoomRange present.
    const visible =
      zoomRange && xs.length > 0
        ? xs.slice(
            Math.max(0, Math.floor(zoomRange[0])),
            Math.min(xs.length, Math.ceil(zoomRange[1]) + 1),
          )
        : xs;
    return scalePoint<string>({
      domain: visible,
      range: [0, innerWidth],
      padding: 0.5,
    });
  }, [isTemporal, data, xCh, innerWidth, zoomRange]);

  // Cap x-axis labels at MAX_X_AXIS_LABELS in any view (default + zoomed).
  // For temporal scales, ask D3 for nice ticks then thin to the cap.
  // For categorical scales, thin the visible domain directly.
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

  const yScale = useMemo(() => {
    const flat: number[] = [];
    for (const s of series) for (const p of s.points) flat.push(p.y);
    const ext = numericExtent(
      flat.map((v) => ({ v })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    const padded = paddedDomain(ext, 0.1);
    return scaleLinear<number>({
      domain: padded,
      range: [innerHeight, 0],
      nice: true,
    });
  }, [series, innerHeight]);

  const y2Scale = useMemo(() => {
    if (y2SeriesList.length === 0) return null;
    // Shared scale across ALL secondary-axis series so they render on
    // a single right-axis with comparable magnitudes.
    const flat: number[] = [];
    for (const s of y2SeriesList) for (const p of s.points) flat.push(p.y);
    const ext = numericExtent(
      flat.map((v) => ({ v })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    const padded = paddedDomain(ext, 0.1);
    return scaleLinear<number>({
      domain: padded,
      range: [innerHeight, 0],
      nice: true,
    });
  }, [y2SeriesList, innerHeight]);

  // Pixel x accessor
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

  // Tooltip
  const containerRef = useRef<SVGSVGElement | null>(null);
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

  // Fix-5 · plain drag (no Shift requirement) for discoverability.
  // The 6-px minimum-distance check in onBrushUp prevents accidental
  // zooms on a click-and-release.
  const onBrushDown = (e: React.MouseEvent<SVGElement>) => {
    const pt = localPoint(e);
    if (!pt) return;
    const x = pt.x - MARGIN.left;
    if (x < 0 || x > innerWidth) return;
    setBrushStart(x);
    setBrushEnd(x);
  };

  const onBrushUp = () => {
    if (brushStart === null || brushEnd === null) return;
    const lo = Math.min(brushStart, brushEnd);
    const hi = Math.max(brushStart, brushEnd);
    if (Math.abs(hi - lo) < 6) {
      // Tiny drag — treat as click; don't zoom.
      setBrushStart(null);
      setBrushEnd(null);
      return;
    }
    if (isTemporal) {
      const dom = (xScale as ReturnType<typeof scaleTime<number>>).domain();
      const domMin = (dom[0] as Date).getTime();
      const domMax = (dom[1] as Date).getTime();
      const dx = (hi - lo) / innerWidth;
      const newMin = domMin + (lo / innerWidth) * (domMax - domMin);
      const newMax = newMin + dx * (domMax - domMin);
      setZoomRange([newMin, newMax]);
    } else {
      const xs = Array.from(new Set(data.map((r) => asString(xCh.accessor(r)))));
      const i0 = Math.max(0, Math.floor((lo / innerWidth) * xs.length));
      const i1 = Math.min(xs.length, Math.ceil((hi / innerWidth) * xs.length));
      setZoomRange([i0, i1]);
    }
    setBrushStart(null);
    setBrushEnd(null);
  };

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
    // Find nearest x-bucket across series
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
    // Add every secondary-axis series at the same x.
    for (const s of y2SeriesList) {
      const found = s.points.find((p) => xPx(p.x) === xPx(xRaw));
      if (found) {
        rows.push({ key: s.key, color: s.color, value: found.y });
      }
    }
    showTooltip({
      tooltipLeft: pt.x,
      tooltipTop: pt.y,
      tooltipData: { xRaw, rows },
    });
  };

  const xTickFormat = useMemo(
    () => makeAxisTickFormatter(xCh.field),
    [xCh.field],
  );
  const yTickFormat = useMemo(
    () => makeAxisTickFormatter(yCh.field),
    [yCh.field],
  );
  const y2TickFormat = useMemo(
    () => (y2Ch ? makeAxisTickFormatter(y2Ch.field) : null),
    [y2Ch],
  );

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Line chart";

  // Legend items: primary series + every secondary-axis series.
  const legendItems: ChartLegendItem[] = useMemo(() => {
    const out: ChartLegendItem[] = series.map((s) => ({
      key: s.key,
      color: s.color,
    }));
    for (const s of y2SeriesList) {
      out.push({
        key: s.key,
        color: s.color,
        label: `${s.key} (right axis)`,
      });
    }
    return out;
  }, [series, y2SeriesList]);
  const legend = useChartLegendState(legendItems);
  const showLegend = legendItems.length > 1;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <div className="relative flex flex-col" style={{ width, height }}>
      {(showLegend || zoomRange) && (
        <div className="mb-1 flex items-center gap-2 px-1">
          {showLegend && (
            <ChartLegend
              items={legendItems}
              state={legend.state}
              onHover={legend.onHover}
              onClick={legend.onClick}
              onShowAll={legend.onShowAll}
              className="flex-1"
            />
          )}
          {zoomRange && (
            <button
              type="button"
              onClick={() => setZoomRange(null)}
              className="ml-auto rounded border border-border/80 bg-card px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/40"
              aria-label="Reset zoom"
            >
              Reset zoom
            </button>
          )}
        </div>
      )}
      <svg
        ref={containerRef}
        width={width}
        height={Math.max(0, height - (showLegend ? 28 : 0))}
        role="img"
        aria-label={accessibleLabel}
        onMouseDown={onBrushDown}
        onMouseUp={onBrushUp}
        onMouseMove={onMouseMove}
        onMouseLeave={() => {
          hideTooltip();
          if (brushStart !== null) {
            setBrushStart(null);
            setBrushEnd(null);
          }
        }}
        style={{ cursor: brushStart !== null ? "ew-resize" : "default" }}
      >
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            stroke="hsl(var(--border))"
            strokeOpacity={0.25}
            strokeDasharray="2,2"
            numTicks={4}
          />
          {/* Brush rectangle while dragging */}
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
          {/* WC5.6 — comparison overlay (prior-period faded line) */}
          {(() => {
            const cmp = pickComparisonLayer(spec.layers);
            if (!cmp) return null;
            return series.map((s) => {
              const op = seriesOpacity(s.key, legend.state);
              if (op === 0) return null;
              const shifted = priorPeriodSeries(s.points);
              const live = shifted.filter((p): p is SeriesPoint => p !== null);
              if (live.length < 2) return null;
              return (
                <LinePath
                  key={`cmp-${s.key}`}
                  data={live}
                  x={(p) => xPx(p.x)}
                  y={(p) => yScale(p.y) ?? 0}
                  stroke={s.color}
                  strokeWidth={1.5}
                  strokeOpacity={0.32 * op}
                  strokeDasharray="3 3"
                  curve={curveMonotoneX}
                  fill="none"
                />
              );
            });
          })()}
          {series.map((s) => {
            const op = seriesOpacity(s.key, legend.state);
            if (op === 0) return null;
            return (
              <LinePath
                key={`s-${s.key}`}
                data={s.points}
                x={(p) => xPx(p.x)}
                y={(p) => yScale(p.y) ?? 0}
                stroke={s.color}
                strokeWidth={2}
                strokeOpacity={op}
                curve={curveMonotoneX}
                fill="none"
              />
            );
          })}
          {/* WC5.1 — reference lines (mean / median / target / custom) */}
          {(() => {
            const refs = resolveReferenceLines(
              spec.layers,
              data,
              yCh.field,
              undefined,
            );
            return refs.map((r, i) => {
              if (r.on !== "y") return null;
              const yPos = yScale(r.value);
              if (!Number.isFinite(yPos)) return null;
              return (
                <g key={`ref-${i}-${r.value}`}>
                  <line
                    x1={0}
                    x2={innerWidth}
                    y1={yPos}
                    y2={yPos}
                    stroke={r.style?.stroke ?? "hsl(var(--chart-12))"}
                    strokeWidth={r.style?.strokeWidth ?? 1.25}
                    strokeDasharray={r.style?.strokeDasharray ?? "4 4"}
                    opacity={0.85}
                  />
                  {r.label && (
                    <text
                      x={innerWidth - 4}
                      y={yPos - 4}
                      fontSize={10}
                      fontFamily="var(--font-sans)"
                      fill="hsl(var(--muted-foreground))"
                      textAnchor="end"
                    >
                      {r.label} · {formatChartValue(r.value, yCh.field)}
                    </text>
                  )}
                </g>
              );
            });
          })()}
          {/* WC5.2 — trend line (linear least-squares) */}
          {(() => {
            const trendLayer = pickTrendLayer(spec.layers);
            if (!trendLayer || trendLayer.method !== "linear") return null;
            // Indices stand in for x-axis position when x is non-numeric;
            // fit y vs sequential index for a meaningful slope.
            const ys = data.map((r) => asNumber(yCh.accessor(r)));
            const xs = ys.map((_, i) => i);
            const fit = fitLinearTrend(xs, ys);
            if (!fit) return null;
            const x0 = xs[0] ?? 0;
            const x1 = xs[xs.length - 1] ?? 0;
            const px0 = isTemporal
              ? xPx(asTime(xCh.accessor(data[0]!)))
              : xPx(xCh.accessor(data[0]!));
            const px1 = isTemporal
              ? xPx(asTime(xCh.accessor(data[data.length - 1]!)))
              : xPx(xCh.accessor(data[data.length - 1]!));
            const py0 = yScale(fit.m * x0 + fit.b);
            const py1 = yScale(fit.m * x1 + fit.b);
            return (
              <g>
                <line
                  x1={px0}
                  x2={px1}
                  y1={py0}
                  y2={py1}
                  stroke="hsl(var(--chart-2))"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                  opacity={0.75}
                />
                <text
                  x={px1}
                  y={py1 - 6}
                  fontSize={10}
                  fontFamily="var(--font-sans)"
                  fill="hsl(var(--muted-foreground))"
                  textAnchor="end"
                >
                  trend · R²={fit.r2.toFixed(2)}
                </text>
              </g>
            );
          })()}
          {/* WC5.3 — forecast band (linear projection + CI envelope) */}
          {(() => {
            const fl = pickForecastLayer(spec.layers);
            if (!fl) return null;
            const ys = data.map((r) => asNumber(yCh.accessor(r)));
            const fc = forecastSeries(ys, fl);
            if (fc.length === 0) return null;
            // Project forward in pixel space along the X axis. We extrapolate
            // px-position by extending the visible X range proportionally.
            const lastIdx = data.length - 1;
            const lastPx = isTemporal
              ? xPx(asTime(xCh.accessor(data[lastIdx]!)))
              : xPx(xCh.accessor(data[lastIdx]!));
            // Stride = average distance between successive x points.
            const firstPx = isTemporal
              ? xPx(asTime(xCh.accessor(data[0]!)))
              : xPx(xCh.accessor(data[0]!));
            const stride = data.length > 1 ? (lastPx - firstPx) / lastIdx : 0;
            const segments: Array<{
              x: number;
              y: number;
              yLow: number;
              yHigh: number;
            }> = fc.map((p) => ({
              x: lastPx + stride * p.i,
              y: yScale(p.y) ?? 0,
              yLow: yScale(p.yLow) ?? 0,
              yHigh: yScale(p.yHigh) ?? 0,
            }));
            // Build CI band path: go forward along yHigh, then back along yLow.
            const upper = segments
              .map((s, i) => `${i === 0 ? "M" : "L"} ${s.x},${s.yHigh}`)
              .join(" ");
            const lower = [...segments]
              .reverse()
              .map((s) => `L ${s.x},${s.yLow}`)
              .join(" ");
            const bandPath = `${upper} ${lower} Z`;
            return (
              <g>
                <path
                  d={bandPath}
                  fill="hsl(var(--chart-2))"
                  fillOpacity={0.12}
                />
                <path
                  d={segments
                    .map(
                      (s, i) => `${i === 0 ? "M" : "L"} ${s.x},${s.y}`,
                    )
                    .join(" ")}
                  stroke="hsl(var(--chart-2))"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  fill="none"
                  opacity={0.85}
                />
              </g>
            );
          })()}
          {/* WC5.5 — outlier callouts (auto >threshold σ) */}
          {(() => {
            const ol = pickOutliersLayer(spec.layers);
            if (!ol) return null;
            const ys = data.map((r) => asNumber(yCh.accessor(r)));
            const outs = detectOutliers(ys, ol.threshold);
            return outs.map((o) => {
              const r = data[o.index];
              if (!r) return null;
              const px = isTemporal
                ? xPx(asTime(xCh.accessor(r)))
                : xPx(xCh.accessor(r));
              const py = yScale(o.value) ?? 0;
              if (ol.style === "callout") {
                return (
                  <g key={`outlier-${o.index}`}>
                    <circle
                      cx={px}
                      cy={py}
                      r={5}
                      fill="hsl(var(--chart-7))"
                      fillOpacity={0.85}
                      stroke="hsl(var(--background))"
                      strokeWidth={1.5}
                    />
                    <text
                      x={px + 8}
                      y={py - 6}
                      fontSize={10}
                      fontFamily="var(--font-sans)"
                      fill="hsl(var(--foreground))"
                    >
                      {formatChartValue(o.value, yCh.field)} ({o.zscore.toFixed(1)}σ)
                    </text>
                  </g>
                );
              }
              return (
                <circle
                  key={`outlier-${o.index}`}
                  cx={px}
                  cy={py}
                  r={5}
                  fill="hsl(var(--chart-7))"
                  fillOpacity={0.4}
                  stroke="hsl(var(--chart-7))"
                  strokeWidth={1.5}
                />
              );
            });
          })()}
          {/* WC5.4 — annotations (text + optional arrow at x[, y]) */}
          {pickAnnotations(spec.layers).map((a, i) => {
            const px = isTemporal
              ? xPx(asTime(a.x))
              : xPx(a.x);
            const py = a.y !== undefined ? yScale(asNumber(a.y)) ?? 0 : 16;
            return (
              <g key={`annot-${i}`}>
                {a.arrow && (
                  <line
                    x1={px}
                    x2={px}
                    y1={Math.max(8, py - 18)}
                    y2={py - 4}
                    stroke="hsl(var(--foreground))"
                    strokeOpacity={0.6}
                    strokeWidth={1}
                  />
                )}
                <text
                  x={px}
                  y={Math.max(12, py - 22)}
                  fontSize={10}
                  fontFamily="var(--font-sans)"
                  fill="hsl(var(--foreground))"
                  textAnchor="middle"
                  fontWeight={500}
                >
                  {a.text}
                </text>
              </g>
            );
          })}
          {y2Scale &&
            y2SeriesList.map((s, si) => {
              const op = seriesOpacity(s.key, legend.state);
              if (op === 0) return null;
              // Per-series dash pattern cycles through 4 distinct
              // styles so multiple secondary series stay readable
              // even without a legend (additional dimension).
              const dashes = ["4 2", "6 3", "2 3", "8 2 2 2"][
                si % 4
              ] as string;
              return (
                <LinePath
                  key={`y2-${si}`}
                  data={s.points}
                  x={(p) => xPx(p.x)}
                  y={(p) => y2Scale(p.y) ?? 0}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeOpacity={op}
                  strokeDasharray={dashes}
                  curve={curveMonotoneX}
                  fill="none"
                />
              );
            })}
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
            numTicks={4}
          />
          {y2Series && y2Scale && y2TickFormat && (
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
              numTicks={4}
            />
          )}
        </Group>
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          // visx default styles add a white background; null them so our
          // semantic-token ChartTooltip card renders cleanly.
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
            rows={tooltipData.rows.map((r) => {
              // Audit fix: pick the formatter field by looking up r.key
              // against the FULL secondary list, not just the first y2.
              // Otherwise multi-y2 series 2..N would format with the
              // primary y field's currency / percent inference.
              const secondaryMatch = y2SeriesList.find(
                (s) => s.key === r.key,
              );
              const formatField = secondaryMatch
                ? secondaryMatch.key
                : yCh.field;
              return {
                color: r.color,
                label: r.key,
                value: formatChartValue(r.value, formatField),
              };
            })}
          />
        </TooltipWithBounds>
      )}
    </div>
  );
}
