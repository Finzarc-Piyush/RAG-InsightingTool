/**
 * Visx renderer for the `regression` mark — scatter + best-fit line.
 *
 * Encoding:
 *   x → quantitative
 *   y → quantitative
 * Method (default 'linear') comes from spec.transform of type
 * 'regression'; for now we always linearly fit the points in-renderer.
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import { Circle, Line } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  numericExtent,
  paddedDomain,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { makeAxisTickFormatter } from "@/lib/charts/format";

export interface RegressionRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 36, left: 56 };

interface FitParams {
  m: number;
  b: number;
  r2: number;
}

function linearFit(
  pts: Array<{ x: number; y: number }>,
): FitParams | null {
  const finite = pts.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  if (finite.length < 2) return null;
  const n = finite.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  for (const { x, y } of finite) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const m = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - m * sumX) / n;
  const ssTot = sumYY - (sumY * sumY) / n;
  let ssRes = 0;
  for (const { x, y } of finite) {
    const yp = m * x + b;
    ssRes += (y - yp) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { m, b, r2 };
}

export function RegressionRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RegressionRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  if (!xCh || !yCh) {
    throw new Error("regression mark requires x and y encodings");
  }

  const points = useMemo(
    () =>
      data
        .map((r) => ({
          x: asNumber(xCh.accessor(r)),
          y: asNumber(yCh.accessor(r)),
        }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    [data, xCh, yCh],
  );

  const fit = useMemo(() => linearFit(points), [points]);

  const xScale = useMemo(() => {
    const ext = numericExtent(
      points.map((p) => ({ v: p.x })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    return scaleLinear<number>({
      domain: paddedDomain(ext, 0.05),
      range: [0, innerWidth],
      nice: true,
    });
  }, [points, innerWidth]);

  const yScale = useMemo(() => {
    const ext = numericExtent(
      points.map((p) => ({ v: p.y })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    return scaleLinear<number>({
      domain: paddedDomain(ext, 0.05),
      range: [innerHeight, 0],
      nice: true,
    });
  }, [points, innerHeight]);

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
    "Regression chart";

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const fitLineEndpoints = useMemo(() => {
    if (!fit) return null;
    const [xMin, xMax] = xScale.domain();
    const yA = fit.m * xMin + fit.b;
    const yB = fit.m * xMax + fit.b;
    return { xA: xMin, yA, xB: xMax, yB };
  }, [fit, xScale]);

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
        {points.map((p, i) => (
          <Circle
            key={`pt-${i}`}
            cx={xScale(p.x) ?? 0}
            cy={yScale(p.y) ?? 0}
            r={3.5}
            fill={qualitativeColor(0)}
            fillOpacity={0.55}
          />
        ))}
        {fitLineEndpoints && (
          <Line
            from={{
              x: xScale(fitLineEndpoints.xA) ?? 0,
              y: yScale(fitLineEndpoints.yA) ?? 0,
            }}
            to={{
              x: xScale(fitLineEndpoints.xB) ?? 0,
              y: yScale(fitLineEndpoints.yB) ?? 0,
            }}
            stroke={qualitativeColor(2)}
            strokeWidth={2}
          />
        )}
        {fit && (
          <text
            x={innerWidth - 8}
            y={14}
            fontSize={10}
            fontFamily="var(--font-sans)"
            fill="hsl(var(--muted-foreground))"
            textAnchor="end"
          >
            R² = {fit.r2.toFixed(3)}
          </text>
        )}
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
          numTicks={6}
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
