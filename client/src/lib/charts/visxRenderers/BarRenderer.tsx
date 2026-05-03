/**
 * Visx renderer for the `bar` mark — best-in-class. Supports:
 *
 *   • Orientation: vertical (column chart) / horizontal / auto-decide
 *     based on X cardinality + label length.
 *   • barLayout modes:
 *       - grouped (default)         side-by-side sub-bars per category
 *       - stacked                   cumulative y per category
 *       - normalized                stacked, each x sums to 100%
 *       - grouped-stacked           outer color groups, each grouped
 *                                   bar stacked by `encoding.detail`
 *                                   (Tableau-style two-level encoding)
 *       - diverging                 splits color values into two halves
 *                                   that stack in opposite directions
 *                                   (population-pyramid / variance)
 *   • encoding.pattern              independent categorical → SVG fill
 *                                   pattern, lets you encode TWO
 *                                   categorical dimensions on one bar
 *   • encoding.detail               additional grouping w/o a color
 *                                   change (used by grouped-stacked)
 *   • encoding.y2 / y2Series        secondary-axis line overlay
 *                                   (combo chart on top of bars)
 *   • Cross-filter on click         when inside a <ChartGrid>
 *   • Reference lines, hover dim, multi-series legend, smart tick
 *     formatting, fade-in, theme-aware color palette.
 *
 * Theme tokens via CSS variables — light/dark/contrast switch without
 * remount.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Group } from "@visx/group";
import { Bar, LinePath } from "@visx/shape";
import { scaleBand, scaleLinear } from "@visx/scale";
import { AxisBottom, AxisLeft, AxisRight, AxisTop } from "@visx/axis";
import { GridRows, GridColumns } from "@visx/grid";
import { curveMonotoneX } from "@visx/curve";
import {
  useTooltip,
  TooltipWithBounds,
  defaultStyles as visxTooltipStyles,
} from "@visx/tooltip";
import { localPoint } from "@visx/event";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  distinctOrdered,
  numericExtent,
  paddedDomain,
  resolveBarEncoding,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import { qualitativeColor } from "@/lib/charts/palette";
import {
  formatChartValue,
  makeAxisTickFormatter,
} from "@/lib/charts/format";
import {
  MAX_X_AXIS_LABELS,
  pickEvenlySpacedTicks,
} from "@/lib/charts/xAxisLabelCap";
import { resolveReferenceLines } from "@/lib/charts/layers";
import {
  ChartLegend,
  useChartLegendState,
  seriesOpacity,
  type ChartLegendItem,
} from "@/components/charts/ChartLegend";
import { useChartGrid } from "@/components/charts/ChartGrid";
import {
  PATTERN_NAMES,
  patternFromIndex,
  resolvePatternFill,
  type PatternDef,
} from "@/lib/charts/patterns";

export interface BarRendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

const MARGIN_V = { top: 16, right: 56, bottom: 36, left: 56 };
const MARGIN_H = { top: 16, right: 56, bottom: 36, left: 120 };

type Orientation = "vertical" | "horizontal";
type Layout =
  | "grouped"
  | "stacked"
  | "normalized"
  | "grouped-stacked"
  | "diverging";

interface BarCell {
  /** Outer category (X axis when vertical / Y axis when horizontal). */
  outerKey: string;
  /**
   * Raw, type-preserved outer-axis value (not stringified). Used for
   * cross-filter — the ChartGrid's predicate compares `r[field] === v`
   * with strict equality, so numbers must stay numbers. (Audit fix.)
   */
  outerRaw: unknown;
  /** Series key (color encoding). */
  colorKey: string;
  /** Inner detail key (used by grouped-stacked). */
  detailKey: string;
  /** Pattern category — independent of color. */
  patternKey: string;
  /** Net y value (signed). */
  value: number;
  /** Lower bound of the bar in value-space (for stacks). */
  base: number;
  /** Upper bound. base + value (or - value for diverging negatives). */
  top: number;
}

function pickOrientation(
  configured: "vertical" | "horizontal" | "auto" | undefined,
  xValues: string[],
): Orientation {
  if (configured === "vertical") return "vertical";
  if (configured === "horizontal") return "horizontal";
  // 'auto' (default): horizontal when many categories or any long label.
  const longest = xValues.reduce((m, v) => (v.length > m ? v.length : m), 0);
  if (xValues.length > 12 || longest > 14) return "horizontal";
  return "vertical";
}

export function BarRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: BarRendererProps) {
  const enc = useMemo(() => resolveBarEncoding(spec), [spec]);
  const colorCh = useMemo(
    () => resolveChannel(spec.encoding.color),
    [spec.encoding.color],
  );
  const detailCh = useMemo(
    () => resolveChannel(spec.encoding.detail),
    [spec.encoding.detail],
  );
  const patternCh = useMemo(
    () => resolveChannel(spec.encoding.pattern),
    [spec.encoding.pattern],
  );
  const y2Ch = useMemo(
    () => resolveChannel(spec.encoding.y2),
    [spec.encoding.y2],
  );
  const y2Series = useMemo(
    () =>
      (spec.encoding.y2Series ?? [])
        .map((c) => resolveChannel(c))
        .filter((c): c is NonNullable<ReturnType<typeof resolveChannel>> => !!c),
    [spec.encoding.y2Series],
  );
  const allY2 = y2Series.length > 0 ? y2Series : y2Ch ? [y2Ch] : [];

  // Audit fix: if user supplies BOTH `detail` encoding AND a non-stacking
  // layout, auto-promote to `grouped-stacked` so the detail dimension has
  // somewhere to render. Otherwise the detail values silently overlap.
  const declaredLayout = (spec.config?.barLayout ?? "grouped") as Layout;
  const layout: Layout =
    declaredLayout === "grouped" && detailCh ? "grouped-stacked" : declaredLayout;
  const xValues = useMemo(
    () => distinctOrdered(data, enc.x.accessor),
    [data, enc.x],
  );
  const xCategoryTicks = useMemo(
    () => pickEvenlySpacedTicks(xValues, MAX_X_AXIS_LABELS),
    [xValues],
  );
  const orientation = pickOrientation(spec.config?.barOrientation, xValues);
  const MARGIN = orientation === "vertical" ? MARGIN_V : MARGIN_H;
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const grid = useChartGrid();
  const showLabels = !!spec.config?.barLabels;

  // ───────── series construction ─────────
  // Series indexed by (color × detail). Detail collapses to a single
  // "default" key when no detail encoding is set.
  const colorKeys = useMemo<string[]>(() => {
    if (!colorCh) return [enc.y.field];
    return Array.from(new Set(data.map((r) => asString(colorCh.accessor(r)))));
  }, [colorCh, data, enc.y.field]);
  const detailKeys = useMemo<string[]>(() => {
    if (!detailCh) return [""];
    return Array.from(new Set(data.map((r) => asString(detailCh.accessor(r)))));
  }, [detailCh, data]);
  const patternKeys = useMemo<string[]>(() => {
    if (!patternCh) return [""];
    return Array.from(
      new Set(data.map((r) => asString(patternCh.accessor(r)))),
    );
  }, [patternCh, data]);

  // For diverging, partition color keys into "left" and "right" halves.
  const divergingPartition = useMemo(() => {
    if (layout !== "diverging" || colorKeys.length < 2) return null;
    const half = Math.ceil(colorKeys.length / 2);
    return {
      right: new Set(colorKeys.slice(0, half)),
      left: new Set(colorKeys.slice(half)),
    };
  }, [layout, colorKeys]);

  // Compute cells with stack accumulators.
  const cells: BarCell[] = useMemo(() => {
    // Audit fix: pre-aggregate input rows so duplicate
    // (outer, color, detail) entries collapse to a single value
    // instead of stacking on top of each other within the same slice.
    // Tableau / Vega-Lite both pre-aggregate by default; we follow.
    interface AggKey {
      outerKey: string;
      outerRaw: unknown;
      colorKey: string;
      detailKey: string;
      patternKey: string;
    }
    const aggKey = (k: AggKey) =>
      `${k.outerKey}${k.colorKey}${k.detailKey}`;
    const aggregated = new Map<
      string,
      AggKey & { value: number }
    >();
    for (const r of data) {
      const outerRaw = enc.x.accessor(r);
      const outerKey = asString(outerRaw);
      const colorKey = colorCh ? asString(colorCh.accessor(r)) : enc.y.field;
      const detailKey = detailCh ? asString(detailCh.accessor(r)) : "";
      const patternKey = patternCh ? asString(patternCh.accessor(r)) : "";
      const v = asNumber(enc.y.accessor(r));
      if (!Number.isFinite(v)) continue;
      const k = { outerKey, outerRaw, colorKey, detailKey, patternKey };
      const id = aggKey(k);
      const prev = aggregated.get(id);
      if (prev) {
        prev.value += v;
      } else {
        aggregated.set(id, { ...k, value: v });
      }
    }

    const out: BarCell[] = [];
    // Stacking accumulator key depends on layout:
    //   grouped:           per (outer, color, detail) — independent bars
    //   stacked:           per outer — color values stack
    //   normalized:        per outer — color values stack, then renormalize
    //   grouped-stacked:   per (outer, color) — detail values stack
    //   diverging:         per (outer, sign) — color values stack within sign
    const stackAcc = new Map<string, number>();

    const applyDiverging = (colorKey: string, value: number): number => {
      if (!divergingPartition) return value;
      if (divergingPartition.left.has(colorKey)) return -Math.abs(value);
      if (divergingPartition.right.has(colorKey)) return Math.abs(value);
      return value;
    };

    for (const a of aggregated.values()) {
      const value =
        layout === "diverging" ? applyDiverging(a.colorKey, a.value) : a.value;
      let stackKey: string;
      switch (layout) {
        case "grouped":
          stackKey = `${a.outerKey}${a.colorKey}${a.detailKey}`;
          break;
        case "stacked":
        case "normalized":
          stackKey = a.outerKey;
          break;
        case "grouped-stacked":
          stackKey = `${a.outerKey}${a.colorKey}`;
          break;
        case "diverging": {
          const side = value >= 0 ? "+" : "-";
          stackKey = `${a.outerKey}${side}`;
          break;
        }
      }
      const base = stackAcc.get(stackKey) ?? 0;
      const top = base + value;
      stackAcc.set(stackKey, top);
      out.push({
        outerKey: a.outerKey,
        outerRaw: a.outerRaw,
        colorKey: a.colorKey,
        detailKey: a.detailKey,
        patternKey: a.patternKey,
        value,
        base,
        top,
      });
    }

    if (layout === "normalized") {
      // Re-normalize each outer's totals to 1.
      const totals = new Map<string, number>();
      for (const c of out) {
        totals.set(
          c.outerKey,
          Math.max(totals.get(c.outerKey) ?? 0, Math.abs(c.top)),
        );
      }
      return out.map((c) => {
        const t = totals.get(c.outerKey) ?? 1;
        if (t === 0) return c;
        return { ...c, base: c.base / t, top: c.top / t, value: c.value / t };
      });
    }
    return out;
  }, [data, enc, colorCh, detailCh, patternCh, layout, divergingPartition]);

  // ───────── scales ─────────
  // Band scale on the categorical (outer) axis.
  const outerScaleRange =
    orientation === "vertical" ? [0, innerWidth] : [0, innerHeight];
  const outerScale = useMemo(
    () =>
      scaleBand<string>({
        domain: xValues,
        range: outerScaleRange as [number, number],
        padding: 0.18,
      }),
    [xValues, orientation, innerWidth, innerHeight],
  );
  // Inner band scale (within each outer) for grouped / grouped-stacked.
  const innerScale = useMemo(() => {
    if (layout === "stacked" || layout === "normalized" || layout === "diverging") {
      return null;
    }
    if (colorKeys.length <= 1) return null;
    return scaleBand<string>({
      domain: colorKeys,
      range: [0, outerScale.bandwidth()],
      padding: 0.08,
    });
  }, [layout, colorKeys, outerScale]);

  // Linear (value) scale.
  const valueExtent = useMemo<[number, number]>(() => {
    if (layout === "normalized") return [0, 1];
    let min = 0;
    let max = 0;
    for (const c of cells) {
      if (c.top < min) min = c.top;
      if (c.top > max) max = c.top;
      if (c.base < min) min = c.base;
      if (c.base > max) max = c.base;
    }
    if (layout === "diverging") {
      const m = Math.max(Math.abs(min), Math.abs(max));
      return [-m, m];
    }
    return [Math.min(0, min), Math.max(0, max)];
  }, [cells, layout]);

  const valuePadded = useMemo(
    () => paddedDomain(valueExtent, layout === "diverging" ? 0.05 : 0.03),
    [valueExtent, layout],
  );

  const valueScale = useMemo(() => {
    const range =
      orientation === "vertical"
        ? ([innerHeight, 0] as [number, number])
        : ([0, innerWidth] as [number, number]);
    return scaleLinear<number>({
      domain: valuePadded,
      range,
      nice: layout !== "normalized",
    });
  }, [valuePadded, orientation, innerHeight, innerWidth, layout]);

  // y2 / y2Series shared scale (single linear over all secondary series).
  const y2Scale = useMemo(() => {
    if (allY2.length === 0) return null;
    const allValues = data.flatMap((r) =>
      allY2.map((ch) => asNumber(ch.accessor(r))),
    );
    const ext = numericExtent(
      allValues.map((v) => ({ v })) as Row[],
      (r) => asNumber((r as { v: unknown }).v),
    );
    const padded = paddedDomain(ext, 0.1);
    // Match the primary value scale's direction: vertical → high-up
    // (range starts at innerHeight, ends at 0); horizontal → high-right
    // (range starts at 0, ends at innerWidth). Otherwise the y2 line
    // would draw mirrored against the bars.
    const range =
      orientation === "vertical"
        ? ([innerHeight, 0] as [number, number])
        : ([0, innerWidth] as [number, number]);
    return scaleLinear<number>({ domain: padded, range, nice: true });
  }, [allY2, data, orientation, innerHeight, innerWidth]);

  // ───────── pattern <defs> registration ─────────
  // Build pattern fill resolution for each (color, pattern) combo so
  // every cell resolves to a stable url(#id) without re-defining.
  const defsPrefix = useRef(
    `b${Math.random().toString(36).slice(2, 8)}`,
  ).current;
  const { fillFor, patternDefs } = useMemo(() => {
    const defs = new Map<string, PatternDef>();
    const cache = new Map<string, string>();
    function resolve(colorIdx: number, patternIdx: number): string {
      const cacheKey = `${colorIdx}-${patternIdx}`;
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      const color = qualitativeColor(colorIdx);
      const patternName = patternCh
        ? patternFromIndex(patternIdx)
        : "solid";
      const r = resolvePatternFill(defsPrefix, patternName, color);
      if (r.def) defs.set(r.def.id, r.def);
      cache.set(cacheKey, r.fill);
      return r.fill;
    }
    return {
      fillFor: resolve,
      patternDefs: defs,
    };
  }, [patternCh, defsPrefix]);

  // ───────── legend ─────────
  const legendItems: ChartLegendItem[] = useMemo(() => {
    if (colorKeys.length <= 1 && allY2.length === 0) return [];
    const items: ChartLegendItem[] = colorKeys.map((k, i) => ({
      key: k,
      color: qualitativeColor(i),
    }));
    allY2.forEach((ch, i) => {
      items.push({
        key: ch.field,
        color: qualitativeColor(colorKeys.length + i + 1),
        label: `${ch.field} (right axis)`,
      });
    });
    return items;
  }, [colorKeys, allY2]);
  const legend = useChartLegendState(legendItems);
  const showLegend = legendItems.length > 1;

  // ───────── tick formatters ─────────
  const outerTickFormat = useMemo(
    () => makeAxisTickFormatter(enc.x.field),
    [enc.x.field],
  );
  const valueTickFormat = useMemo(
    () =>
      layout === "normalized"
        ? (v: unknown) => `${(Number(v) * 100).toFixed(0)}%`
        : layout === "diverging"
          ? (v: unknown) => formatChartValue(Math.abs(Number(v)), enc.y.field)
          : makeAxisTickFormatter(enc.y.field),
    [enc.y.field, layout],
  );
  const y2TickFormat = useMemo(
    () => (allY2[0] ? makeAxisTickFormatter(allY2[0].field) : null),
    [allY2],
  );

  // ───────── render helpers (orientation-aware) ─────────
  function placeBar(
    bandPos: number,
    bandWidth: number,
    valStart: number,
    valEnd: number,
  ) {
    if (orientation === "horizontal") {
      return {
        x: Math.min(valStart, valEnd),
        y: bandPos,
        w: Math.abs(valEnd - valStart),
        h: bandWidth,
      };
    }
    return {
      x: bandPos,
      y: Math.min(valStart, valEnd),
      w: bandWidth,
      h: Math.abs(valEnd - valStart),
    };
  }

  // ───────── tooltip ─────────
  const {
    tooltipOpen,
    tooltipLeft,
    tooltipTop,
    tooltipData,
    showTooltip,
    hideTooltip,
  } = useTooltip<{ cell: BarCell }>();

  // ───────── ARIA ─────────
  const accessibleLabel =
    ariaLabel ??
    spec.config?.accessibility?.ariaLabel ??
    spec.config?.title?.text ??
    `Bar chart (${orientation}${layout !== "grouped" ? `, ${layout}` : ""})`;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  // Reference lines (Fix-2 + WC5.1).
  const refLines = resolveReferenceLines(spec.layers, data, enc.y.field);

  // ───────── render ─────────
  // Pattern legend swatches — visible when the pattern encoding is
  // active, regardless of color (audit fix: users couldn't decode
  // the second categorical dimension without it).
  const showPatternLegend = !!patternCh && patternKeys.length > 1;

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
      {showPatternLegend && (
        <div
          role="group"
          aria-label={`Pattern legend for ${patternCh!.field}`}
          className="mb-1 flex flex-wrap items-center gap-2 px-1 text-[10px] text-muted-foreground"
        >
          <span className="font-medium uppercase tracking-wider opacity-80">
            {patternCh!.field}:
          </span>
          {patternKeys.map((pk, i) => {
            const r = resolvePatternFill(
              `legend-${defsPrefix}`,
              patternFromIndex(i),
              "hsl(var(--foreground))",
            );
            return (
              <span key={pk} className="inline-flex items-center gap-1">
                <svg
                  width={14}
                  height={10}
                  aria-hidden
                  className="overflow-visible"
                >
                  {r.def && (
                    <defs>
                      <pattern
                        id={r.def.id}
                        patternUnits="userSpaceOnUse"
                        width={r.def.size}
                        height={r.def.size}
                        dangerouslySetInnerHTML={{ __html: r.def.body }}
                      />
                    </defs>
                  )}
                  <rect
                    width={14}
                    height={10}
                    fill={r.fill}
                    stroke="hsl(var(--border))"
                    strokeWidth={0.5}
                    rx={1}
                  />
                </svg>
                <span>{pk || "(blank)"}</span>
              </span>
            );
          })}
        </div>
      )}
      <svg
        width={width}
        height={Math.max(0, height - (showLegend ? 28 : 0))}
        role="img"
        aria-label={accessibleLabel}
        onMouseLeave={hideTooltip}
      >
        {/* Pattern <defs> for the pattern encoding. */}
        {patternDefs.size > 0 && (
          <defs>
            {Array.from(patternDefs.values()).map((d) => (
              <pattern
                key={d.id}
                id={d.id}
                patternUnits="userSpaceOnUse"
                width={d.size}
                height={d.size}
                dangerouslySetInnerHTML={{ __html: d.body }}
              />
            ))}
          </defs>
        )}
        <Group left={MARGIN.left} top={MARGIN.top}>
          {/* Gridlines on the value axis. */}
          {orientation === "vertical" ? (
            <GridRows
              scale={valueScale}
              width={innerWidth}
              stroke="hsl(var(--border))"
              strokeOpacity={0.25}
              strokeDasharray="2,2"
              numTicks={5}
            />
          ) : (
            <GridColumns
              scale={valueScale}
              height={innerHeight}
              stroke="hsl(var(--border))"
              strokeOpacity={0.25}
              strokeDasharray="2,2"
              numTicks={5}
            />
          )}
          {/* Zero-line emphasis. */}
          {valueScale.domain()[0]! <= 0 &&
            valueScale.domain()[1]! >= 0 &&
            (orientation === "vertical" ? (
              <line
                x1={0}
                x2={innerWidth}
                y1={valueScale(0)}
                y2={valueScale(0)}
                stroke="hsl(var(--border))"
                strokeOpacity={0.7}
              />
            ) : (
              <line
                x1={valueScale(0)}
                x2={valueScale(0)}
                y1={0}
                y2={innerHeight}
                stroke="hsl(var(--border))"
                strokeOpacity={0.7}
              />
            ))}
          {/* Bars. */}
          {cells.map((c, i) => {
            const colorIdx = Math.max(0, colorKeys.indexOf(c.colorKey));
            const patternIdx = Math.max(
              0,
              patternCh ? patternKeys.indexOf(c.patternKey) : 0,
            );
            const op = seriesOpacity(c.colorKey, legend.state);
            if (op === 0) return null;

            const outerPos = outerScale(c.outerKey);
            if (outerPos === undefined) return null;

            // Inner offset for grouped / grouped-stacked.
            const innerOffset =
              innerScale && (layout === "grouped" || layout === "grouped-stacked")
                ? innerScale(c.colorKey) ?? 0
                : 0;
            const bandPos = outerPos + innerOffset;
            const bandWidth =
              innerScale && (layout === "grouped" || layout === "grouped-stacked")
                ? innerScale.bandwidth()
                : outerScale.bandwidth();

            const valStart = valueScale(c.base);
            const valEnd = valueScale(c.top);
            const { x, y, w, h } = placeBar(bandPos, bandWidth, valStart, valEnd);
            if (w <= 0 || h <= 0) return null;

            const fill = fillFor(colorIdx, patternIdx);
            // Audit fix: compare against the RAW outer value (not the
            // stringified outerKey) so cross-filter works for numeric /
            // boolean / Date x-fields where strict equality on stringified
            // values would always fail.
            const isFiltered =
              grid.inGrid &&
              grid.filter?.field === enc.x.field &&
              grid.filter?.value === c.outerRaw;
            const interactive = grid.inGrid;

            return (
              <Bar
                key={`bar-${i}`}
                x={x}
                y={y}
                width={w}
                height={h}
                fill={fill}
                fillOpacity={
                  0.92 *
                  op *
                  (isFiltered
                    ? 1
                    : grid.inGrid && grid.filter
                      ? 0.4
                      : 1)
                }
                stroke={isFiltered ? "hsl(var(--foreground))" : undefined}
                strokeWidth={isFiltered ? 1.5 : 0}
                rx={2}
                style={interactive ? { cursor: "pointer" } : undefined}
                onMouseMove={(e: React.MouseEvent<SVGElement>) => {
                  const local = localPoint(e);
                  showTooltip({
                    tooltipLeft: local?.x ?? 0,
                    tooltipTop: local?.y ?? 0,
                    tooltipData: { cell: c },
                  });
                }}
                onClick={
                  interactive
                    ? () =>
                        grid.toggleFilter({
                          field: enc.x.field,
                          value: c.outerRaw,
                        })
                    : undefined
                }
              >
                {Math.abs(c.value) > 0 && (
                  <title>
                    {c.outerKey} · {c.colorKey} ·{" "}
                    {formatChartValue(c.value, enc.y.field)}
                  </title>
                )}
              </Bar>
            );
          })}
          {/* Optional in-bar value labels. */}
          {showLabels &&
            cells.map((c, i) => {
              const outerPos = outerScale(c.outerKey);
              if (outerPos === undefined) return null;
              const innerOffset =
                innerScale &&
                (layout === "grouped" || layout === "grouped-stacked")
                  ? innerScale(c.colorKey) ?? 0
                  : 0;
              const bandPos = outerPos + innerOffset;
              const bandWidth =
                innerScale &&
                (layout === "grouped" || layout === "grouped-stacked")
                  ? innerScale.bandwidth()
                  : outerScale.bandwidth();
              const valStart = valueScale(c.base);
              const valEnd = valueScale(c.top);
              const { x, y, w, h } = placeBar(bandPos, bandWidth, valStart, valEnd);
              const labelText = formatChartValue(
                Math.abs(c.value),
                enc.y.field,
              );
              if (orientation === "vertical") {
                if (h < 12) return null;
                return (
                  <text
                    key={`lbl-${i}`}
                    x={x + w / 2}
                    y={y + 12}
                    fontSize={10}
                    fontFamily="var(--font-sans)"
                    fill="hsl(var(--foreground))"
                    textAnchor="middle"
                    pointerEvents="none"
                  >
                    {labelText}
                  </text>
                );
              }
              if (w < 28) return null;
              return (
                <text
                  key={`lbl-${i}`}
                  x={x + w - 4}
                  y={y + h / 2 + 3}
                  fontSize={10}
                  fontFamily="var(--font-sans)"
                  fill="hsl(var(--foreground))"
                  textAnchor="end"
                  pointerEvents="none"
                >
                  {labelText}
                </text>
              );
            })}
          {/* Reference lines. */}
          {refLines.map((r, i) => {
            const v = valueScale(r.value);
            if (!Number.isFinite(v)) return null;
            return (
              <g key={`ref-${i}`}>
                {orientation === "vertical" ? (
                  <line
                    x1={0}
                    x2={innerWidth}
                    y1={v}
                    y2={v}
                    stroke={r.style?.stroke ?? "hsl(var(--chart-12))"}
                    strokeWidth={r.style?.strokeWidth ?? 1.25}
                    strokeDasharray={r.style?.strokeDasharray ?? "4 4"}
                    opacity={0.85}
                  />
                ) : (
                  <line
                    x1={v}
                    x2={v}
                    y1={0}
                    y2={innerHeight}
                    stroke={r.style?.stroke ?? "hsl(var(--chart-12))"}
                    strokeWidth={r.style?.strokeWidth ?? 1.25}
                    strokeDasharray={r.style?.strokeDasharray ?? "4 4"}
                    opacity={0.85}
                  />
                )}
                {r.label && (
                  <text
                    x={orientation === "vertical" ? innerWidth - 4 : v + 4}
                    y={orientation === "vertical" ? v - 4 : 12}
                    fontSize={10}
                    fontFamily="var(--font-sans)"
                    fill="hsl(var(--muted-foreground))"
                    textAnchor={orientation === "vertical" ? "end" : "start"}
                  >
                    {r.label} · {formatChartValue(r.value, enc.y.field)}
                  </text>
                )}
              </g>
            );
          })}
          {/* y2 / y2Series line overlays (combo). */}
          {y2Scale &&
            allY2.map((ch, si) => {
              const op = seriesOpacity(ch.field, legend.state);
              if (op === 0) return null;
              const dashes = ["4 0", "5 3", "2 3", "6 2 2 2"][
                si % 4
              ] as string;
              const color = qualitativeColor(colorKeys.length + si + 1);
              const points = data.map((r) => ({
                outerKey: asString(enc.x.accessor(r)),
                v: asNumber(ch.accessor(r)),
              }));
              const xy = (p: (typeof points)[number]) => {
                const op2 = outerScale(p.outerKey);
                if (op2 === undefined) return { x: 0, y: 0 };
                const cx = op2 + outerScale.bandwidth() / 2;
                const cv = y2Scale(p.v) ?? 0;
                return orientation === "vertical"
                  ? { x: cx, y: cv }
                  : { x: cv, y: cx };
              };
              return (
                <LinePath
                  key={`y2-${si}`}
                  data={points}
                  x={(p) => xy(p).x}
                  y={(p) => xy(p).y}
                  stroke={color}
                  strokeWidth={2}
                  strokeOpacity={op}
                  strokeDasharray={dashes}
                  curve={curveMonotoneX}
                  fill="none"
                />
              );
            })}
          {/* Axes. */}
          {orientation === "vertical" ? (
            <>
              <AxisBottom
                top={innerHeight}
                scale={outerScale}
                stroke="hsl(var(--border))"
                tickStroke="hsl(var(--border))"
                tickFormat={(v) => outerTickFormat(v)}
                tickLabelProps={() => ({
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 11,
                  fontFamily: "var(--font-sans)",
                  textAnchor: "middle",
                })}
                tickValues={xCategoryTicks}
              />
              <AxisLeft
                scale={valueScale}
                stroke="hsl(var(--border))"
                tickStroke="hsl(var(--border))"
                tickFormat={(v) => valueTickFormat(v as number)}
                tickLabelProps={() => ({
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 11,
                  fontFamily: "var(--font-sans)",
                  textAnchor: "end",
                  dx: -4,
                  dy: 3,
                })}
                numTicks={5}
              />
              {y2Scale && y2TickFormat && (
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
              )}
            </>
          ) : (
            <>
              <AxisLeft
                scale={outerScale}
                stroke="hsl(var(--border))"
                tickStroke="hsl(var(--border))"
                tickFormat={(v) => outerTickFormat(v)}
                tickLabelProps={() => ({
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 11,
                  fontFamily: "var(--font-sans)",
                  textAnchor: "end",
                  dx: -4,
                  dy: 3,
                })}
                tickValues={xCategoryTicks}
              />
              <AxisBottom
                top={innerHeight}
                scale={valueScale}
                stroke="hsl(var(--border))"
                tickStroke="hsl(var(--border))"
                tickFormat={(v) => valueTickFormat(v as number)}
                tickLabelProps={() => ({
                  fill: "hsl(var(--muted-foreground))",
                  fontSize: 11,
                  fontFamily: "var(--font-sans)",
                  textAnchor: "middle",
                })}
                numTicks={5}
              />
              {y2Scale && y2TickFormat && (
                <AxisTop
                  scale={y2Scale}
                  stroke="hsl(var(--border))"
                  tickStroke="hsl(var(--border))"
                  tickFormat={(v) => y2TickFormat(v as number)}
                  tickLabelProps={() => ({
                    fill: "hsl(var(--muted-foreground))",
                    fontSize: 11,
                    fontFamily: "var(--font-sans)",
                    textAnchor: "middle",
                    dy: -2,
                  })}
                  numTicks={4}
                />
              )}
            </>
          )}
        </Group>
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          style={{ ...visxTooltipStyles, background: "transparent", padding: 0 }}
        >
          <ChartTooltip
            title={tooltipData.cell.outerKey}
            subtitle={
              colorCh && tooltipData.cell.colorKey !== enc.y.field
                ? `${colorCh.field}: ${tooltipData.cell.colorKey}`
                : undefined
            }
            rows={[
              {
                color: qualitativeColor(
                  Math.max(0, colorKeys.indexOf(tooltipData.cell.colorKey)),
                ),
                label: enc.y.field,
                value: formatChartValue(
                  tooltipData.cell.value,
                  enc.y.field,
                ),
                emphasized: true,
              },
              ...(detailCh && tooltipData.cell.detailKey
                ? [
                    {
                      label: detailCh.field,
                      value: tooltipData.cell.detailKey,
                    },
                  ]
                : []),
              ...(patternCh && tooltipData.cell.patternKey
                ? [
                    {
                      label: patternCh.field,
                      value: tooltipData.cell.patternKey,
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
