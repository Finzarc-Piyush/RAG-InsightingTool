/**
 * Visx renderer for the `point` mark (scatter / bubble).
 *
 *   - Both x and y are quantitative.
 *   - Optional `color` encoding → distinct categorical groups.
 *   - Optional `size` encoding → marker radius (bubble chart).
 *   - Hover tooltip with [x, y, color, size] context.
 */

import { useMemo, useRef } from "react";
import { Group } from "@visx/group";
import { Circle } from "@visx/shape";
import { scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
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
import { glyphPath, shapeFromIndex } from "@/lib/charts/glyphs";
import {
  formatChartValue,
  makeAxisTickFormatter,
} from "@/lib/charts/format";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import {
  ChartLegend,
  useChartLegendState,
  seriesOpacity,
  type ChartLegendItem,
} from "@/components/charts/ChartLegend";

export interface PointRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 36, left: 48 };
const DEFAULT_RADIUS = 4;
const SIZE_RANGE: [number, number] = [3, 22];

export function PointRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: PointRendererProps) {
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const xCh = resolveChannel(spec.encoding.x);
  const yCh = resolveChannel(spec.encoding.y);
  const colorCh = resolveChannel(spec.encoding.color);
  const sizeCh = resolveChannel(spec.encoding.size);
  const shapeCh = resolveChannel(spec.encoding.shape);

  if (!xCh || !yCh) {
    throw new Error("point mark requires x and y encodings");
  }

  // Color category map
  const colorIndex = useMemo(() => {
    if (!colorCh) return null;
    const seen = new Map<string, number>();
    let i = 0;
    for (const r of data) {
      const k = asString(colorCh.accessor(r));
      if (!seen.has(k)) seen.set(k, i++);
    }
    return seen;
  }, [colorCh, data]);

  // Shape category map (independent of color so users can encode 2 dims)
  const shapeIndex = useMemo(() => {
    if (!shapeCh) return null;
    const seen = new Map<string, number>();
    let i = 0;
    for (const r of data) {
      const k = asString(shapeCh.accessor(r));
      if (!seen.has(k)) seen.set(k, i++);
    }
    return seen;
  }, [shapeCh, data]);

  // Size scale
  const sizeScale = useMemo(() => {
    if (!sizeCh) return null;
    const ext = numericExtent(data, (r) => asNumber(sizeCh.accessor(r)));
    return scaleLinear<number>({ domain: ext, range: SIZE_RANGE });
  }, [sizeCh, data]);

  const xScale = useMemo(() => {
    const ext = numericExtent(data, (r) => asNumber(xCh.accessor(r)));
    const padded = paddedDomain(ext, 0.05);
    return scaleLinear<number>({
      domain: padded,
      range: [0, innerWidth],
      nice: true,
    });
  }, [data, xCh, innerWidth]);

  const yScale = useMemo(() => {
    const ext = numericExtent(data, (r) => asNumber(yCh.accessor(r)));
    const padded = paddedDomain(ext, 0.05);
    return scaleLinear<number>({
      domain: padded,
      range: [innerHeight, 0],
      nice: true,
    });
  }, [data, yCh, innerHeight]);

  const points = useMemo(() => {
    return data
      .map((r, i) => {
        const x = asNumber(xCh.accessor(r));
        const y = asNumber(yCh.accessor(r));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const sizeVal = sizeCh ? asNumber(sizeCh.accessor(r)) : Number.NaN;
        const radius = sizeScale && Number.isFinite(sizeVal)
          ? sizeScale(sizeVal)
          : DEFAULT_RADIUS;
        const colorKey = colorCh ? asString(colorCh.accessor(r)) : "";
        const colorIdx = colorIndex ? colorIndex.get(colorKey) ?? 0 : 0;
        const shapeKey = shapeCh ? asString(shapeCh.accessor(r)) : "";
        const shapeIdx = shapeIndex ? shapeIndex.get(shapeKey) ?? 0 : 0;
        return {
          i,
          x,
          y,
          radius,
          color: qualitativeColor(colorIdx),
          colorKey,
          shapeKey,
          shapeIdx,
          sizeVal,
          raw: r,
        };
      })
      .filter(<T,>(v: T | null): v is T => v !== null);
  }, [data, xCh, yCh, sizeCh, sizeScale, colorCh, colorIndex]);

  const containerRef = useRef<SVGSVGElement | null>(null);
  const {
    tooltipOpen,
    tooltipLeft,
    tooltipTop,
    tooltipData,
    showTooltip,
    hideTooltip,
  } = useTooltip<{ point: (typeof points)[number] }>();

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
    "Scatter chart";

  // Build legend items from the color category index when color encoding is set.
  const legendItems: ChartLegendItem[] = useMemo(() => {
    if (!colorIndex) return [];
    return Array.from(colorIndex.entries()).map(([key, idx]) => ({
      key,
      color: qualitativeColor(idx),
    }));
  }, [colorIndex]);
  const legend = useChartLegendState(legendItems);
  const showLegend = legendItems.length > 1;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <div className="relative flex flex-col" style={{ width, height }}>
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
        ref={containerRef}
        width={width}
        height={Math.max(0, height - (showLegend ? 28 : 0))}
        role="img"
        aria-label={accessibleLabel}
        onMouseLeave={hideTooltip}
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
          {points.map((p) => {
            const op = legendItems.length > 0
              ? seriesOpacity(p.colorKey, legend.state)
              : 1;
            if (op === 0) return null;
            const cx = xScale(p.x) ?? 0;
            const cy = yScale(p.y) ?? 0;
            const onPointMove = (e: React.MouseEvent<SVGElement>) => {
              const local = localPoint(e);
              showTooltip({
                tooltipLeft: local?.x ?? 0,
                tooltipTop: local?.y ?? 0,
                tooltipData: { point: p },
              });
            };
            // Use a glyph path when shape encoding is set; circle otherwise.
            if (shapeCh) {
              const shape = shapeFromIndex(p.shapeIdx);
              return (
                <path
                  key={`pt-${p.i}`}
                  d={glyphPath(shape, p.radius)}
                  transform={`translate(${cx},${cy})`}
                  fill={p.color}
                  fillOpacity={0.7 * op}
                  stroke={p.color}
                  strokeOpacity={op}
                  strokeWidth={1}
                  onMouseMove={onPointMove}
                  onMouseLeave={hideTooltip}
                />
              );
            }
            return (
              <Circle
                key={`pt-${p.i}`}
                cx={cx}
                cy={cy}
                r={p.radius}
                fill={p.color}
                fillOpacity={0.7 * op}
                stroke={p.color}
                strokeOpacity={op}
                strokeWidth={1}
                onMouseMove={onPointMove}
                onMouseLeave={hideTooltip}
              />
            );
          })}
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
      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          style={{ ...visxTooltipStyles, background: "transparent", padding: 0 }}
        >
          <ChartTooltip
            title={
              tooltipData.point.colorKey || `(${tooltipData.point.x}, ${tooltipData.point.y})`
            }
            rows={[
              {
                color: tooltipData.point.color,
                label: xCh.field,
                value: formatChartValue(tooltipData.point.x, xCh.field),
              },
              {
                color: tooltipData.point.color,
                label: yCh.field,
                value: formatChartValue(tooltipData.point.y, yCh.field),
              },
              ...(sizeCh
                ? [
                    {
                      color: tooltipData.point.color,
                      label: sizeCh.field,
                      value: formatChartValue(
                        tooltipData.point.sizeVal,
                        sizeCh.field,
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </TooltipWithBounds>
      )}
    </div>
  );
}
