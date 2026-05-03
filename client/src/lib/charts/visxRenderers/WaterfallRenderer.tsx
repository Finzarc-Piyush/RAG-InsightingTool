/**
 * Visx renderer for the `waterfall` mark — variance bridge.
 *
 * Each row's `y` value is treated as a DELTA. Bars float between the
 * running cumulative total before and after that delta. Optional
 * "total" rows (marked via a `total` field === true on the row, or
 * the first/last row by convention) render as full-height bars from
 * zero in a neutral color.
 *
 * Color: positive deltas in chart-6 (green-ish), negatives in
 * chart-7 (red-ish), totals in chart-12 (neutral).
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import { Bar } from "@visx/shape";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  paddedDomain,
  resolveBarEncoding,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import {
  formatChartValue,
  makeAxisTickFormatter,
} from "@/lib/charts/format";

export interface WaterfallRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 20, right: 16, bottom: 36, left: 56 };

interface WaterfallBar {
  category: string;
  start: number;
  end: number;
  delta: number;
  isTotal: boolean;
}

export function WaterfallRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: WaterfallRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const enc = useMemo(() => resolveBarEncoding(spec), [spec]);

  const bars: WaterfallBar[] = useMemo(() => {
    let running = 0;
    return data.map((r) => {
      const cat = asString(enc.x.accessor(r));
      const delta = asNumber(enc.y.accessor(r));
      const isTotal = r["total"] === true || r["isTotal"] === true;
      if (isTotal) {
        running = delta;
        return { category: cat, start: 0, end: delta, delta, isTotal: true };
      }
      const start = running;
      running += delta;
      return { category: cat, start, end: running, delta, isTotal: false };
    });
  }, [data, enc]);

  const xValues = useMemo(() => bars.map((b) => b.category), [bars]);

  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: xValues,
        range: [0, innerWidth],
        padding: 0.2,
      }),
    [xValues, innerWidth],
  );

  const yScale = useMemo(() => {
    let min = 0;
    let max = 0;
    for (const b of bars) {
      if (b.start < min) min = b.start;
      if (b.end < min) min = b.end;
      if (b.start > max) max = b.start;
      if (b.end > max) max = b.end;
    }
    return scaleLinear<number>({
      domain: paddedDomain([min, max], 0.1),
      range: [innerHeight, 0],
      nice: true,
    });
  }, [bars, innerHeight]);

  const xTickFormat = useMemo(
    () => makeAxisTickFormatter(enc.x.field),
    [enc.x.field],
  );
  const yTickFormat = useMemo(
    () => makeAxisTickFormatter(enc.y.field),
    [enc.y.field],
  );

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Waterfall chart";

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
        {bars.map((b, i) => {
          const x = xScale(b.category);
          if (x === undefined) return null;
          const y0 = yScale(b.end);
          const y1 = yScale(b.start);
          const top = Math.min(y0, y1);
          const h = Math.max(1, Math.abs(y1 - y0));
          const fill = b.isTotal
            ? qualitativeColor(11)
            : b.delta >= 0
              ? qualitativeColor(5)
              : qualitativeColor(6);
          return (
            <g key={`wf-${i}-${b.category}`}>
              <Bar
                x={x}
                y={top}
                width={xScale.bandwidth()}
                height={h}
                fill={fill}
                fillOpacity={0.85}
                rx={2}
              />
              {/* Delta label above the bar */}
              <text
                x={x + xScale.bandwidth() / 2}
                y={top - 4}
                fontSize={10}
                fontFamily="var(--font-sans)"
                fill="hsl(var(--foreground))"
                textAnchor="middle"
              >
                {b.delta >= 0 ? "+" : ""}
                {formatChartValue(b.delta, enc.y.field)}
              </text>
              {/* Connector line to next bar */}
              {i < bars.length - 1 && (
                <line
                  x1={x + xScale.bandwidth()}
                  x2={(xScale(bars[i + 1]!.category) ?? 0)}
                  y1={yScale(b.end)}
                  y2={yScale(b.end)}
                  stroke="hsl(var(--border))"
                  strokeOpacity={0.6}
                  strokeDasharray="2 2"
                />
              )}
            </g>
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
  );
}
