/**
 * Visx renderer for the `arc` mark (pie / donut).
 *
 * Reads the categorical field from `encoding.x` (or `encoding.color`)
 * and the numeric magnitude from `encoding.y`. Supports donut mode
 * via `config.theme` extensions in future waves; for now renders a
 * standard pie with an inner radius slot reserved.
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import { Pie } from "@visx/shape";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { formatChartValue } from "@/lib/charts/format";

export interface ArcRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
  /** When set, renders a donut with this fraction of outer radius hollowed. */
  innerRadiusFraction?: number;
}

interface Slice {
  key: string;
  value: number;
  color: string;
}

export function ArcRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
  innerRadiusFraction = 0.5,
}: ArcRendererProps) {
  // Category from x or color; magnitude from y.
  const labelCh =
    resolveChannel(spec.encoding.x) ?? resolveChannel(spec.encoding.color);
  const valueCh = resolveChannel(spec.encoding.y);

  if (!labelCh || !valueCh) {
    throw new Error("arc mark requires a category (x or color) and value (y) encoding");
  }

  const slices: Slice[] = useMemo(() => {
    // Aggregate by label in case data isn't pre-aggregated.
    const totals = new Map<string, number>();
    for (const r of data) {
      const k = asString(labelCh.accessor(r));
      const v = asNumber(valueCh.accessor(r));
      if (!Number.isFinite(v)) continue;
      totals.set(k, (totals.get(k) ?? 0) + v);
    }
    let i = 0;
    return Array.from(totals.entries())
      .filter(([, v]) => v > 0)
      .map(([key, value]) => ({
        key,
        value,
        color: qualitativeColor(i++),
      }));
  }, [data, labelCh, valueCh]);

  const total = useMemo(
    () => slices.reduce((s, x) => s + x.value, 0) || 1,
    [slices],
  );

  const radius = Math.min(width, height) / 2 - 8;
  const inner = Math.max(0, radius * innerRadiusFraction);

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Pie chart";

  if (radius <= 0) return null;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={accessibleLabel}
    >
      <Group top={height / 2} left={width / 2}>
        <Pie
          data={slices}
          pieValue={(s) => s.value}
          outerRadius={radius}
          innerRadius={inner}
          padAngle={0.005}
          cornerRadius={2}
        >
          {(pie) =>
            pie.arcs.map((arc) => {
              const path = pie.path(arc) ?? "";
              const [cx, cy] = pie.path.centroid(arc);
              const pct = (arc.data.value / total) * 100;
              const showLabel = pct >= 5;
              return (
                <g key={`arc-${arc.data.key}`}>
                  <path d={path} fill={arc.data.color} />
                  {showLabel && (
                    <text
                      x={cx}
                      y={cy}
                      dy=".33em"
                      fontSize={11}
                      fontFamily="var(--font-sans)"
                      fill="hsl(var(--background))"
                      textAnchor="middle"
                      pointerEvents="none"
                    >
                      {formatChartValue(pct / 100, undefined, {
                        format: "percent",
                        precision: 0,
                      })}
                    </text>
                  )}
                </g>
              );
            })
          }
        </Pie>
      </Group>
    </svg>
  );
}
