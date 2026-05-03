/**
 * Visx renderer for the `area` mark. Reuses the LineRenderer pattern
 * but draws a closed area instead of a line. Multi-series areas stack
 * by default (matching v1 stacked-area behavior).
 *
 * Single-series: filled area beneath the line.
 * Multi-series:  stacked areas, each in chart-1..12.
 * Dual-axis y2 not supported on area (use line + area combo via combo mark).
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import { AreaClosed, LinePath } from "@visx/shape";
import { scaleLinear, scalePoint, scaleTime } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
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
import { makeAxisTickFormatter } from "@/lib/charts/format";
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
    const groups = new Map<string, SeriesPoint[]>();
    for (const r of data) {
      const k = asString(colorCh.accessor(r));
      const arr = groups.get(k) ?? [];
      arr.push({ x: xCh.accessor(r), y: asNumber(yCh.accessor(r)) });
      groups.set(k, arr);
    }
    let i = 0;
    return Array.from(groups.entries()).map(([key, points]) => ({
      key,
      color: qualitativeColor(i++),
      points,
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
    <div className="flex flex-col" style={{ width, height }}>
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
          return (
            <Group key={`a-${s.key}`}>
              <AreaClosed
                data={s.points}
                x={(p) => xPx(p.x)}
                y={(p) => yScale(p.y) ?? 0}
                yScale={yScale}
                fill={s.color}
                fillOpacity={0.55 * op}
                curve={curveMonotoneX}
              />
              <LinePath
                data={s.points}
                x={(p) => xPx(p.x)}
                y={(p) => yScale(p.y) ?? 0}
                stroke={s.color}
                strokeWidth={1.5}
                strokeOpacity={op}
                curve={curveMonotoneX}
                fill="none"
              />
            </Group>
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
      </Group>
    </svg>
    </div>
  );
}
