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

import { useMemo } from "react";
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
import {
  MAX_X_AXIS_LABELS,
  pickEvenlySpacedTicks,
} from "@/lib/charts/xAxisLabelCap";

export interface ComboRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 56, bottom: 36, left: 56 };

export function ComboRenderer({
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

  const xValues = useMemo(
    () => distinctOrdered(data, xCh.accessor),
    [data, xCh],
  );
  const xCategoryTicks = useMemo(
    () => pickEvenlySpacedTicks(xValues, MAX_X_AXIS_LABELS),
    [xValues],
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
        {/* Bars */}
        {data.map((row, i) => {
          const xRaw = asString(xCh.accessor(row));
          const yRaw = asNumber(yCh.accessor(row));
          const x = xScale(xRaw);
          if (x === undefined || !Number.isFinite(yRaw)) return null;
          const yPos = yScale(yRaw);
          const barHeight = innerHeight - yPos;
          if (barHeight <= 0) return null;
          return (
            <Bar
              key={`bar-${i}-${xRaw}`}
              x={x}
              y={yPos}
              width={xScale.bandwidth()}
              height={barHeight}
              fill={qualitativeColor(0)}
              fillOpacity={0.85}
              rx={2}
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
          numTicks={4}
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
          numTicks={4}
        />
      </Group>
    </svg>
  );
}
