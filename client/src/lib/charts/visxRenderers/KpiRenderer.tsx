/**
 * KPI tile — big number + optional inline sparkline. Not a chart in
 * the traditional sense; a compact tile component for dashboards.
 *
 * Encoding:
 *   y → quantitative magnitude (averaged for a single-value tile)
 *   x → optional temporal/ordinal axis for the inline sparkline
 *   color → optional categorical sub-grouping (collapses to first group's mean)
 */

import { useMemo } from "react";
import { LinePath } from "@visx/shape";
import { scaleLinear, scalePoint } from "@visx/scale";
import { curveMonotoneX } from "@visx/curve";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  numericExtent,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import { formatChartValue } from "@/lib/charts/format";

export interface KpiRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

export function KpiRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: KpiRendererProps) {
  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  if (!yCh) {
    throw new Error("kpi tile requires a quantitative y encoding");
  }

  const summary = useMemo(() => {
    let total = 0;
    let n = 0;
    let last: number | null = null;
    let prev: number | null = null;
    for (const r of data) {
      const v = asNumber(yCh.accessor(r));
      if (Number.isFinite(v)) {
        total += v;
        n += 1;
        prev = last;
        last = v;
      }
    }
    const value = n > 0 ? (last ?? total / n) : 0;
    const delta =
      last !== null && prev !== null && prev !== 0
        ? ((last - prev) / Math.abs(prev)) * 100
        : null;
    return { value, delta, n };
  }, [data, yCh]);

  // Sparkline data when x axis present
  const spark = useMemo(() => {
    if (!xCh) return null;
    return data.map((r) => ({
      x: asString(xCh.accessor(r)),
      y: asNumber(yCh.accessor(r)),
    }));
  }, [data, xCh, yCh]);

  const sparkH = Math.max(20, Math.floor(height * 0.35));
  const sparkW = Math.max(40, Math.floor(width * 0.6));

  const xScale = useMemo(() => {
    if (!spark) return null;
    return scalePoint<string>({
      domain: spark.map((p) => p.x),
      range: [0, sparkW],
      padding: 0.5,
    });
  }, [spark, sparkW]);
  const yScale = useMemo(() => {
    if (!spark) return null;
    const ext = numericExtent(
      spark.map((p) => ({ v: p.y })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    return scaleLinear<number>({
      domain: ext,
      range: [sparkH - 2, 2],
    });
  }, [spark, sparkH]);

  const accessibleLabel =
    ariaLabel ?? spec.config?.title?.text ?? `${yCh.field} KPI`;
  const subtitle = spec.config?.title?.text;

  return (
    <div
      role="img"
      aria-label={accessibleLabel}
      style={{ width, height }}
      className="flex flex-col justify-center gap-1.5 rounded-lg border border-border/60 bg-card px-4 py-3 text-foreground"
    >
      {subtitle && (
        <div className="text-xs font-medium text-muted-foreground">{subtitle}</div>
      )}
      <div className="flex items-baseline gap-2">
        <div className="text-3xl font-semibold tabular-nums tracking-tight">
          {formatChartValue(summary.value, yCh.field, {
            precision: summary.value >= 1000 ? 1 : 2,
          })}
        </div>
        {summary.delta !== null && (
          <div
            className={
              "text-xs font-medium " +
              (summary.delta >= 0
                ? "text-[hsl(var(--chart-6))]"
                : "text-[hsl(var(--chart-7))]")
            }
          >
            {summary.delta >= 0 ? "▲" : "▼"} {Math.abs(summary.delta).toFixed(1)}%
          </div>
        )}
      </div>
      {spark && xScale && yScale && (
        <svg width={sparkW} height={sparkH} aria-hidden>
          <LinePath
            data={spark}
            x={(p) => xScale(p.x) ?? 0}
            y={(p) => yScale(p.y) ?? 0}
            stroke={qualitativeColor(0)}
            strokeWidth={1.5}
            curve={curveMonotoneX}
            fill="none"
          />
        </svg>
      )}
    </div>
  );
}
