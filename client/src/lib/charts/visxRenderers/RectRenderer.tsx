/**
 * Visx renderer for the `rect` mark (heatmap).
 *
 * Encoding contract:
 *   - encoding.x  → row dimension (categorical / temporal label)
 *   - encoding.y  → column dimension (categorical label)
 *   - encoding.color → numeric magnitude (mapped via sequential palette)
 *
 * Cells fill the inner area in a uniform grid. Color uses
 * `sequentialColor(t)` from the palette module so light/dark modes
 * track the user's theme without remount.
 *
 * Replicates the v1 heatmap's "custom HSL gradient + min/max legend"
 * via the sequential palette + a small below-chart legend strip.
 */

import { useMemo } from "react";
import { Group } from "@visx/group";
import { scaleBand } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import {
  sequentialColor,
  sequentialPalette,
} from "@/lib/charts/palette";
import {
  formatChartValue,
  makeAxisTickFormatter,
} from "@/lib/charts/format";
import {
  MAX_X_AXIS_LABELS,
  pickEvenlySpacedTicks,
} from "@/lib/charts/xAxisLabelCap";

export interface RectRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 12, right: 16, bottom: 56, left: 80 };

export function RectRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RectRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const rowCh = resolveChannel(spec.encoding.x);
  const colCh = resolveChannel(spec.encoding.y);
  const valCh = resolveChannel(spec.encoding.color);

  if (!rowCh || !colCh || !valCh) {
    throw new Error("rect mark requires x (row), y (col) and color (value) encodings");
  }

  const rows = useMemo(
    () => Array.from(new Set(data.map((r) => asString(rowCh.accessor(r))))),
    [data, rowCh],
  );
  const cols = useMemo(
    () => Array.from(new Set(data.map((r) => asString(colCh.accessor(r))))),
    [data, colCh],
  );
  const colTicks = useMemo(
    () => pickEvenlySpacedTicks(cols, MAX_X_AXIS_LABELS),
    [cols],
  );

  const valueExtent = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const r of data) {
      const v = asNumber(valCh.accessor(r));
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1] as const;
    if (min === max) return [min, max + 1] as const;
    return [min, max] as const;
  }, [data, valCh]);

  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: cols,
        range: [0, innerWidth],
        padding: 0.04,
      }),
    [cols, innerWidth],
  );
  const yScale = useMemo(
    () =>
      scaleBand<string>({
        domain: rows,
        range: [0, innerHeight],
        padding: 0.04,
      }),
    [rows, innerHeight],
  );

  const cellByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data) {
      const k = `${asString(rowCh.accessor(r))}::${asString(colCh.accessor(r))}`;
      m.set(k, asNumber(valCh.accessor(r)));
    }
    return m;
  }, [data, rowCh, colCh, valCh]);

  const cellWidth = xScale.bandwidth();
  const cellHeight = yScale.bandwidth();

  const xTickFormat = useMemo(
    () => makeAxisTickFormatter(colCh.field),
    [colCh.field],
  );
  const yTickFormat = useMemo(
    () => makeAxisTickFormatter(rowCh.field),
    [rowCh.field],
  );

  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    "Heatmap";

  if (innerWidth <= 0 || innerHeight <= 0 || cellWidth <= 0 || cellHeight <= 0) {
    return null;
  }

  const palette = sequentialPalette(9);
  const [vMin, vMax] = valueExtent;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={accessibleLabel}
    >
      <Group left={MARGIN.left} top={MARGIN.top}>
        {rows.map((row) =>
          cols.map((col) => {
            const v = cellByKey.get(`${row}::${col}`);
            const t =
              v === undefined || !Number.isFinite(v)
                ? Number.NaN
                : (v - vMin) / (vMax - vMin || 1);
            const fill =
              v === undefined || !Number.isFinite(v)
                ? "hsl(var(--muted))"
                : sequentialColor(t);
            const x = xScale(col);
            const y = yScale(row);
            if (x === undefined || y === undefined) return null;
            return (
              <rect
                key={`${row}-${col}`}
                x={x}
                y={y}
                width={cellWidth}
                height={cellHeight}
                fill={fill}
                stroke="hsl(var(--background))"
                strokeWidth={0.5}
                rx={1}
              >
                <title>
                  {row} · {col}: {formatChartValue(v, valCh.field)}
                </title>
              </rect>
            );
          }),
        )}
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          stroke="hsl(var(--border))"
          tickStroke="hsl(var(--border))"
          tickFormat={(v: unknown) => xTickFormat(v)}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 10,
            fontFamily: "var(--font-sans)",
            textAnchor: "middle",
          })}
          tickValues={colTicks}
        />
        <AxisLeft
          scale={yScale}
          stroke="hsl(var(--border))"
          tickStroke="hsl(var(--border))"
          tickFormat={(v: unknown) => yTickFormat(v)}
          tickLabelProps={() => ({
            fill: "hsl(var(--muted-foreground))",
            fontSize: 10,
            fontFamily: "var(--font-sans)",
            textAnchor: "end",
            dx: -4,
            dy: 3,
          })}
          numTicks={Math.min(rows.length, 12)}
        />
      </Group>
      {/* Color legend strip below the chart. */}
      <Group left={MARGIN.left} top={height - MARGIN.bottom + 28}>
        {palette.map((c, i) => (
          <rect
            key={`legend-${i}`}
            x={(i / palette.length) * innerWidth}
            y={0}
            width={innerWidth / palette.length}
            height={8}
            fill={c}
          />
        ))}
        <text
          x={0}
          y={22}
          fontSize={10}
          fontFamily="var(--font-sans)"
          fill="hsl(var(--muted-foreground))"
        >
          {formatChartValue(vMin, valCh.field)}
        </text>
        <text
          x={innerWidth}
          y={22}
          fontSize={10}
          fontFamily="var(--font-sans)"
          fill="hsl(var(--muted-foreground))"
          textAnchor="end"
        >
          {formatChartValue(vMax, valCh.field)}
        </text>
      </Group>
    </svg>
  );
}
