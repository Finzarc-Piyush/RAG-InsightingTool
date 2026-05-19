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
import { useDashboardTileContext } from "@/pages/Dashboard/lib/dashboardTileContext";
import {
  dispatchCrossFilter,
  isCrossFilterActive,
  toFilterValue,
} from "@/pages/Dashboard/lib/crossFilter";
import {
  dispatchDrillThrough,
  isModifierClick,
} from "@/pages/Dashboard/lib/drillThrough";

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

  // WD2-wiring-rest-rect · dashboard-tile cross-filter dispatch. A
  // heatmap cell sits at the intersection of TWO categorical dims;
  // clicking a cell dispatches TWO events in sequence — one for the
  // row dim, one for the column dim. `applyCrossFilter` is pure and
  // event-driven, so back-to-back dispatches each toggle their own
  // column independently. The user sees a row+col filter applied;
  // clicking the same cell again toggles both back off.
  const dashboardTile = useDashboardTileContext();
  // WD2-dim-rect · heatmap cells dim if EITHER the row dimension OR the
  // col dimension has an active categorical cross-filter that doesn't
  // include this cell's row / col. Symmetric with the WD2-wiring-rest-rect
  // two-dim DISPATCH (which fires both dims on click); the dim contract
  // is OR-of-row-OR-col so a cell stays full opacity only when both
  // dims pass (no active row filter excludes it AND no active col
  // filter excludes it). Two independent dashboardDimActive flags so
  // a row-only filter dims only by row, a col-only filter dims only
  // by col, and a row+col filter intersects (full dim if either fails).
  const dashboardFilters = dashboardTile?.filters;
  const rowFilterSel = dashboardFilters?.[rowCh.field];
  const colFilterSel = dashboardFilters?.[colCh.field];
  const dashboardRowDimActive =
    !!rowFilterSel &&
    rowFilterSel.type === "categorical" &&
    rowFilterSel.values.length > 0;
  const dashboardColDimActive =
    !!colFilterSel &&
    colFilterSel.type === "categorical" &&
    colFilterSel.values.length > 0;

  // Build the row / col domains AND a parallel raw-value map so the
  // cross-filter dispatch carries type-original values (Dates, numerics,
  // booleans, etc.) instead of stringified ones — mirrors BarRenderer's
  // outerRaw and the WD2-wiring-rest-cat pattern.
  const { rows, rowRawByKey, cols, colRawByKey } = useMemo(() => {
    const rs: string[] = [];
    const cs: string[] = [];
    const rRaw = new Map<string, unknown>();
    const cRaw = new Map<string, unknown>();
    for (const r of data) {
      const rowRaw = rowCh.accessor(r);
      const colRaw = colCh.accessor(r);
      const rk = asString(rowRaw);
      const ck = asString(colRaw);
      if (!rRaw.has(rk)) {
        rRaw.set(rk, rowRaw);
        rs.push(rk);
      }
      if (!cRaw.has(ck)) {
        cRaw.set(ck, colRaw);
        cs.push(ck);
      }
    }
    return { rows: rs, rowRawByKey: rRaw, cols: cs, colRawByKey: cRaw };
  }, [data, rowCh, colCh]);
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
            // WD2-dim-rect · OR-of-row-OR-col: cell is dimmed if either
            // dimension's active filter excludes its raw value.
            const isRowDimmed =
              dashboardRowDimActive &&
              !isCrossFilterActive(
                dashboardFilters!,
                rowCh.field,
                rowRawByKey.get(row),
              );
            const isColDimmed =
              dashboardColDimActive &&
              !isCrossFilterActive(
                dashboardFilters!,
                colCh.field,
                colRawByKey.get(col),
              );
            const isDashboardDimmed = isRowDimmed || isColDimmed;
            return (
              <rect
                key={`${row}-${col}`}
                x={x}
                y={y}
                width={cellWidth}
                height={cellHeight}
                fill={fill}
                fillOpacity={isDashboardDimmed ? 0.4 : 1}
                stroke="hsl(var(--background))"
                strokeWidth={0.5}
                rx={1}
                style={dashboardTile ? { cursor: "pointer" } : undefined}
                onClick={
                  dashboardTile
                    ? (event: React.MouseEvent<SVGRectElement>) => {
                        // WD3-wiring-rest-rect · cmd / ctrl-click fires
                        // ONE drill-through event carrying BOTH dims
                        // (the row × col intersection). The foundation
                        // gained an `extraPins` field for this case:
                        // primary pin = row dim; extraPins[0] = col
                        // dim. Server endpoint applies primary + all
                        // extras as WHERE clauses BEFORE returning
                        // rows (AND-intersection). The `return;` is
                        // single-intent-load-bearing — without it a
                        // cmd-click would fire BOTH drill AND the two
                        // cross-filter dispatches below. Raw values
                        // (not toFilterValue-coerced) — server-side
                        // canonicaliser picks Date / number /
                        // categorical comparison per inferred column
                        // type.
                        if (isModifierClick(event)) {
                          dispatchDrillThrough({
                            chartId: dashboardTile.tileId,
                            column: rowCh.field,
                            value: rowRawByKey.get(row),
                            extraPins: [
                              {
                                column: colCh.field,
                                value: colRawByKey.get(col),
                              },
                            ],
                            sourceTileId: dashboardTile.tileId,
                            filters: dashboardFilters,
                          });
                          return;
                        }
                        // Two-dim dispatch: row + col, in row-first order.
                        // Each event is independently toggled by
                        // `applyCrossFilter`, so a re-click on the same
                        // cell removes both filters.
                        dispatchCrossFilter({
                          column: rowCh.field,
                          value: toFilterValue(rowRawByKey.get(row)),
                          sourceTileId: dashboardTile.tileId,
                        });
                        dispatchCrossFilter({
                          column: colCh.field,
                          value: toFilterValue(colRawByKey.get(col)),
                          sourceTileId: dashboardTile.tileId,
                        });
                      }
                    : undefined
                }
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
