/**
 * Visx renderer for the `radar` mark — multi-attribute polar comparison.
 *
 * Encoding:
 *   x     → categorical axis labels (the spokes)
 *   y     → quantitative magnitude per spoke
 *   color → optional categorical (one polygon per series)
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import { Line, LineRadial } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { formatChartValue } from "@/lib/charts/format";

export interface RadarRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

interface SeriesPoint {
  axis: string;
  value: number;
}

export function RadarRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RadarRendererProps) {
  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  const colorCh = resolveChannel(spec.encoding.color);
  if (!xCh || !yCh) {
    throw new Error("radar mark requires x and y encodings");
  }

  // Spokes — distinct x values across all rows.
  const axes = useMemo(
    () => Array.from(new Set(data.map((r) => asString(xCh.accessor(r))))),
    [data, xCh],
  );

  // Series — group by color (or single series).
  const series = useMemo<{ key: string; color: string; points: SeriesPoint[] }[]>(() => {
    const groups = new Map<string, SeriesPoint[]>();
    for (const r of data) {
      const k = colorCh ? asString(colorCh.accessor(r)) : yCh.field;
      const arr = groups.get(k) ?? [];
      arr.push({
        axis: asString(xCh.accessor(r)),
        value: asNumber(yCh.accessor(r)),
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

  const maxValue = useMemo(() => {
    let m = 0;
    for (const s of series) for (const p of s.points) if (p.value > m) m = p.value;
    return m || 1;
  }, [series]);

  const radius = Math.min(width, height) / 2 - 36;
  const cx = width / 2;
  const cy = height / 2;
  const angleStep = (Math.PI * 2) / Math.max(1, axes.length);

  const rScale = scaleLinear<number>({
    domain: [0, maxValue],
    range: [0, radius],
  });

  if (radius <= 0 || axes.length === 0) return null;

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Radar chart";

  const ringSteps = 4;
  const ringValues = Array.from(
    { length: ringSteps },
    (_, i) => ((i + 1) / ringSteps) * maxValue,
  );

  return (
    <svg width={width} height={height} role="img" aria-label={accessibleLabel}>
      <Group left={cx} top={cy}>
        {/* Concentric rings */}
        {ringValues.map((rv, i) => (
          <circle
            key={`ring-${i}`}
            cx={0}
            cy={0}
            r={rScale(rv)}
            fill="none"
            stroke="hsl(var(--border))"
            strokeOpacity={0.25}
            strokeDasharray="2,2"
          />
        ))}
        {/* Spoke lines + axis labels */}
        {axes.map((axis, i) => {
          const angle = i * angleStep - Math.PI / 2;
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          return (
            <g key={`spoke-${axis}`}>
              <Line
                from={{ x: 0, y: 0 }}
                to={{ x, y }}
                stroke="hsl(var(--border))"
                strokeOpacity={0.4}
              />
              <text
                x={Math.cos(angle) * (radius + 14)}
                y={Math.sin(angle) * (radius + 14) + 4}
                fontSize={10}
                fontFamily="var(--font-sans)"
                fill="hsl(var(--muted-foreground))"
                textAnchor="middle"
              >
                {axis}
              </text>
            </g>
          );
        })}
        {/* Series polygons */}
        {series.map((s) => {
          const orderedPoints = axes.map((axis) => {
            const found = s.points.find((p) => p.axis === axis);
            return { axis, value: found?.value ?? 0 };
          });
          return (
            <LineRadial<SeriesPoint>
              key={`s-${s.key}`}
              data={orderedPoints}
              angle={(_, i) => i * angleStep}
              radius={(p) => rScale(Number.isFinite(p.value) ? p.value : 0)}
              stroke={s.color}
              strokeWidth={2}
              fill={s.color}
              fillOpacity={0.18}
              curve={undefined}
            />
          );
        })}
        {/* Outer ring label (max) */}
        <text
          x={0}
          y={-radius - 4}
          fontSize={9}
          fontFamily="var(--font-sans)"
          fill="hsl(var(--muted-foreground))"
          textAnchor="middle"
        >
          {formatChartValue(maxValue, yCh.field)}
        </text>
      </Group>
    </svg>
  );
}
