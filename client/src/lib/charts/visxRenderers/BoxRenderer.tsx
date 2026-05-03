/**
 * Visx renderer for the `box` mark — boxplot for grouped distributions.
 *
 * Encoding:
 *   x → categorical group (one box per category)
 *   y → quantitative measure
 *
 * Computes IQR statistics in-renderer via dataEngine.aggregate.
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  numericExtent,
  paddedDomain,
  resolveBarEncoding,
  type Row,
} from "@/lib/charts/encodingResolver";
import { aggregate, groupBy } from "@/lib/charts/dataEngine";
import { qualitativeColor } from "@/lib/charts/palette";
import { makeAxisTickFormatter } from "@/lib/charts/format";

export interface BoxRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 36, left: 56 };

interface BoxStats {
  category: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

export function BoxRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: BoxRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const enc = useMemo(() => resolveBarEncoding(spec), [spec]);

  const stats: BoxStats[] = useMemo(() => {
    const groups = groupBy(data, [enc.x.field]);
    return Array.from(groups.entries()).map(([cat, rows]) => {
      const values = rows.map((r) => asNumber(enc.y.accessor(r)));
      return {
        category: cat || asString(rows[0]?.[enc.x.field] ?? ""),
        min: aggregate(values, "min"),
        q1: aggregate(values, "p25"),
        median: aggregate(values, "median"),
        q3: aggregate(values, "p75"),
        max: aggregate(values, "max"),
      };
    });
  }, [data, enc]);

  const xValues = useMemo(() => stats.map((s) => s.category), [stats]);

  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: xValues,
        range: [0, innerWidth],
        padding: 0.4,
      }),
    [xValues, innerWidth],
  );

  const yScale = useMemo(() => {
    const flat: number[] = stats.flatMap((s) => [s.min, s.q1, s.median, s.q3, s.max]);
    const ext = numericExtent(
      flat.map((v) => ({ v })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    return scaleLinear<number>({
      domain: paddedDomain(ext, 0.05),
      range: [innerHeight, 0],
      nice: true,
    });
  }, [stats, innerHeight]);

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
    "Boxplot";

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
        {stats.map((s, i) => {
          const x = xScale(s.category);
          if (x === undefined) return null;
          const w = xScale.bandwidth();
          const cx = x + w / 2;
          const yMin = yScale(s.min);
          const yQ1 = yScale(s.q1);
          const yMed = yScale(s.median);
          const yQ3 = yScale(s.q3);
          const yMax = yScale(s.max);
          const boxTop = Math.min(yQ1, yQ3);
          const boxH = Math.max(1, Math.abs(yQ1 - yQ3));
          const fill = qualitativeColor(i);
          return (
            <g key={`box-${i}-${s.category}`}>
              {/* Whiskers */}
              <line x1={cx} x2={cx} y1={yMin} y2={yMax} stroke={fill} strokeOpacity={0.7} />
              <line x1={cx - w / 4} x2={cx + w / 4} y1={yMin} y2={yMin} stroke={fill} strokeOpacity={0.7} />
              <line x1={cx - w / 4} x2={cx + w / 4} y1={yMax} y2={yMax} stroke={fill} strokeOpacity={0.7} />
              {/* Box */}
              <rect
                x={x}
                y={boxTop}
                width={w}
                height={boxH}
                fill={fill}
                fillOpacity={0.4}
                stroke={fill}
                strokeOpacity={0.85}
                rx={2}
              />
              {/* Median */}
              <line x1={x} x2={x + w} y1={yMed} y2={yMed} stroke={fill} strokeWidth={2} />
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
