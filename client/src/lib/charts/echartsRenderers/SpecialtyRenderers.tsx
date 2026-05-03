/**
 * Lazy-loaded ECharts specialty renderers (one component per mark).
 *
 * Each takes a v2 spec + data and produces an ECharts options object
 * via the shared <EChartsBase>. They're co-located here because each
 * is small (~50 LOC of option-building) and they all share the same
 * import path.
 *
 * Marks: sunburst, sankey, parallel, calendar, candlestick, choropleth, gauge.
 *
 * Note: `choropleth` is a stub until a geo registration step is wired
 * up (ECharts needs `echarts.registerMap('world', geoJson)` to render
 * a proper map). Until then, it falls back to an info card.
 */

import { useMemo } from "react";
import type { ChartSpecV2 } from "@/shared/schema";
import {
  asNumber,
  asString,
  resolveChannel,
  type Row,
} from "@/lib/charts/encodingResolver";
import {
  EChartsBase,
  type ChartTheme,
  type EChartsType,
} from "./EChartsBase";
import {
  MAX_X_AXIS_LABELS,
  echartsLabelInterval,
} from "@/lib/charts/xAxisLabelCap";

interface RendererProps {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
}

// ────────────────────────────────────────────────────────────────────────
// shared helpers
// ────────────────────────────────────────────────────────────────────────

function commonText(theme: ChartTheme) {
  return {
    fontFamily: "var(--font-sans)",
    color: theme.foreground,
  };
}

function commonTooltip(theme: ChartTheme) {
  return {
    backgroundColor: theme.background,
    borderColor: theme.border,
    borderWidth: 1,
    textStyle: { color: theme.foreground, fontFamily: "var(--font-sans)" },
    extraCssText: "border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.08);",
  };
}

// ────────────────────────────────────────────────────────────────────────
// Sunburst
// ────────────────────────────────────────────────────────────────────────

interface SunburstNode {
  name: string;
  value?: number;
  children?: SunburstNode[];
}

export function SunburstRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RendererProps) {
  const labelCh = resolveChannel(spec.encoding.x);
  const valueCh = resolveChannel(spec.encoding.y);
  const groupCh = resolveChannel(spec.encoding.color);
  if (!labelCh || !valueCh) {
    throw new Error("sunburst mark requires x (label) and y (value) encodings");
  }

  const tree = useMemo<SunburstNode[]>(() => {
    if (!groupCh) {
      const totals = new Map<string, number>();
      for (const r of data) {
        const k = asString(labelCh.accessor(r));
        const v = asNumber(valueCh.accessor(r));
        if (Number.isFinite(v) && v > 0) {
          totals.set(k, (totals.get(k) ?? 0) + v);
        }
      }
      return Array.from(totals.entries()).map(([name, value]) => ({
        name,
        value,
      }));
    }
    const groups = new Map<string, Map<string, number>>();
    for (const r of data) {
      const g = asString(groupCh.accessor(r));
      const k = asString(labelCh.accessor(r));
      const v = asNumber(valueCh.accessor(r));
      if (!Number.isFinite(v) || v <= 0) continue;
      const inner = groups.get(g) ?? new Map<string, number>();
      inner.set(k, (inner.get(k) ?? 0) + v);
      groups.set(g, inner);
    }
    return Array.from(groups.entries()).map(([gName, inner]) => ({
      name: gName,
      children: Array.from(inner.entries()).map(([name, value]) => ({
        name,
        value,
      })),
    }));
  }, [data, labelCh, valueCh, groupCh]);

  const optionsKey = useMemo(
    () => JSON.stringify({ tree, w: width, h: height }),
    [tree, width, height],
  );

  return (
    <EChartsBase
      width={width}
      height={height}
      ariaLabel={ariaLabel ?? spec.config?.title?.text ?? "Sunburst"}
      optionsKey={optionsKey}
      buildOptions={(_e: EChartsType, theme: ChartTheme) => ({
        backgroundColor: "transparent",
        textStyle: commonText(theme),
        tooltip: commonTooltip(theme),
        legend: { show: false },
        series: [
          {
            type: "sunburst",
            data: tree,
            radius: [16, "92%"],
            sort: "desc",
            label: { fontFamily: "var(--font-sans)", fontSize: 11 },
            itemStyle: {
              borderColor: theme.background,
              borderWidth: 1,
            },
            color: theme.qualitative.filter(Boolean),
          },
        ],
      })}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sankey (flow)
// ────────────────────────────────────────────────────────────────────────

export function SankeyRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RendererProps) {
  // x = source, y = target, size = flow value.
  const sourceCh = resolveChannel(spec.encoding.x);
  const targetCh = resolveChannel(spec.encoding.y);
  const valueCh = resolveChannel(spec.encoding.size);
  if (!sourceCh || !targetCh || !valueCh) {
    throw new Error(
      "sankey mark requires source (x), target (y), and a size encoding",
    );
  }

  const { nodes, links } = useMemo(() => {
    const nodeNames = new Set<string>();
    const linkMap = new Map<string, number>();
    for (const r of data) {
      const s = asString(sourceCh.accessor(r));
      const t = asString(targetCh.accessor(r));
      const v = asNumber(valueCh.accessor(r));
      if (!Number.isFinite(v) || v <= 0 || s === t) continue;
      nodeNames.add(s);
      nodeNames.add(t);
      const k = `${s}->${t}`;
      linkMap.set(k, (linkMap.get(k) ?? 0) + v);
    }
    return {
      nodes: Array.from(nodeNames).map((name) => ({ name })),
      links: Array.from(linkMap.entries()).map(([k, value]) => {
        const [source, target] = k.split("->");
        return { source: source!, target: target!, value };
      }),
    };
  }, [data, sourceCh, targetCh, valueCh]);

  const optionsKey = useMemo(
    () => JSON.stringify({ nodes, links, w: width, h: height }),
    [nodes, links, width, height],
  );

  return (
    <EChartsBase
      width={width}
      height={height}
      ariaLabel={ariaLabel ?? spec.config?.title?.text ?? "Sankey"}
      optionsKey={optionsKey}
      buildOptions={(_e: EChartsType, theme: ChartTheme) => ({
        backgroundColor: "transparent",
        textStyle: commonText(theme),
        tooltip: { ...commonTooltip(theme), trigger: "item" },
        legend: { show: false },
        series: [
          {
            type: "sankey",
            data: nodes,
            links,
            emphasis: { focus: "adjacency" },
            lineStyle: { color: "gradient", curveness: 0.5 },
            label: {
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: theme.foreground,
            },
            color: theme.qualitative.filter(Boolean),
          },
        ],
      })}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// Parallel coordinates
// ────────────────────────────────────────────────────────────────────────

export function ParallelRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RendererProps) {
  // Use tooltip channel as the dimension list when provided; otherwise
  // collect every quantitative encoding's field.
  const dimensions = useMemo<string[]>(() => {
    const tipFields = (spec.encoding.tooltip ?? [])
      .map((t) => t.field)
      .filter(Boolean);
    if (tipFields.length >= 2) return tipFields;
    const candidates: (string | undefined)[] = [
      spec.encoding.x?.field,
      spec.encoding.y?.field,
      spec.encoding.size?.field,
      spec.encoding.color?.field,
      spec.encoding.detail?.field,
    ];
    return candidates.filter((f): f is string => !!f);
  }, [spec.encoding]);

  const optionsKey = useMemo(
    () => JSON.stringify({ dimensions, n: data.length, w: width, h: height }),
    [dimensions, data.length, width, height],
  );

  return (
    <EChartsBase
      width={width}
      height={height}
      ariaLabel={ariaLabel ?? spec.config?.title?.text ?? "Parallel coordinates"}
      optionsKey={optionsKey}
      buildOptions={(_e: EChartsType, theme: ChartTheme) => ({
        backgroundColor: "transparent",
        textStyle: commonText(theme),
        tooltip: commonTooltip(theme),
        legend: { show: false },
        parallelAxis: dimensions.map((dim, i) => ({
          dim: i,
          name: dim,
          nameTextStyle: { color: theme.mutedForeground, fontSize: 10 },
          axisLine: { lineStyle: { color: theme.border } },
          axisLabel: { color: theme.mutedForeground, fontSize: 10 },
          splitNumber: Math.max(2, MAX_X_AXIS_LABELS - 1),
        })),
        series: [
          {
            type: "parallel",
            lineStyle: { color: theme.qualitative[0] ?? "#000", opacity: 0.4, width: 1 },
            data: data.map((r) => dimensions.map((d) => asNumber(r[d]))),
          },
        ],
      })}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// Calendar heatmap
// ────────────────────────────────────────────────────────────────────────

export function CalendarRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RendererProps) {
  const dateCh = resolveChannel(spec.encoding.x);
  const valueCh = resolveChannel(spec.encoding.color);
  if (!dateCh || !valueCh) {
    throw new Error(
      "calendar mark requires a temporal x and a quantitative color encoding",
    );
  }

  const series = useMemo(() => {
    return data
      .map((r) => {
        const d = new Date(asString(dateCh.accessor(r)));
        if (Number.isNaN(d.getTime())) return null;
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return [`${yyyy}-${mm}-${dd}`, asNumber(valueCh.accessor(r))];
      })
      .filter((p): p is [string, number] => !!p);
  }, [data, dateCh, valueCh]);

  const range = useMemo(() => {
    if (series.length === 0) return [new Date().getFullYear()];
    const ys = series.map(([s]) => Number(s.slice(0, 4)));
    return [Math.min(...ys), Math.max(...ys)];
  }, [series]);

  const optionsKey = useMemo(
    () => JSON.stringify({ series, range, w: width, h: height }),
    [series, range, width, height],
  );

  return (
    <EChartsBase
      width={width}
      height={height}
      ariaLabel={ariaLabel ?? spec.config?.title?.text ?? "Calendar heatmap"}
      optionsKey={optionsKey}
      buildOptions={(_e: EChartsType, theme: ChartTheme) => ({
        backgroundColor: "transparent",
        textStyle: commonText(theme),
        tooltip: { ...commonTooltip(theme), formatter: (info: { value: [string, number] }) => `${info.value[0]} · ${info.value[1]}` },
        visualMap: {
          show: false,
          min: Math.min(...series.map(([, v]) => v), 0),
          max: Math.max(...series.map(([, v]) => v), 1),
          inRange: { color: theme.sequential.filter(Boolean) },
        },
        calendar: {
          range: range[0] === range[1] ? range[0] : range,
          itemStyle: {
            borderColor: theme.background,
            borderWidth: 1,
            color: theme.background,
          },
          dayLabel: { color: theme.mutedForeground, fontSize: 10 },
          monthLabel: { color: theme.mutedForeground, fontSize: 10 },
          yearLabel: { color: theme.foreground, fontSize: 12 },
          splitLine: { lineStyle: { color: theme.border } },
        },
        series: [
          {
            type: "heatmap",
            coordinateSystem: "calendar",
            data: series,
          },
        ],
      })}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// Candlestick (OHLC)
// ────────────────────────────────────────────────────────────────────────

export function CandlestickRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RendererProps) {
  const xCh = resolveChannel(spec.encoding.x);
  const openCh = resolveChannel(spec.encoding.y); // open
  const closeCh = resolveChannel(spec.encoding.y2); // close
  // For OHLC we read low/high from row fields named explicitly; fall back to
  // shape: [open, close, low, high] using min/max if not provided.
  if (!xCh || !openCh || !closeCh) {
    throw new Error(
      "candlestick mark requires temporal x, y (open), and y2 (close) encodings",
    );
  }

  const series = useMemo(() => {
    return data.map((r) => {
      const o = asNumber(openCh.accessor(r));
      const c = asNumber(closeCh.accessor(r));
      const low = Number.isFinite(asNumber(r.low)) ? asNumber(r.low) : Math.min(o, c);
      const high = Number.isFinite(asNumber(r.high)) ? asNumber(r.high) : Math.max(o, c);
      return [o, c, low, high];
    });
  }, [data, openCh, closeCh]);
  const xs = useMemo(
    () => data.map((r) => asString(xCh.accessor(r))),
    [data, xCh],
  );

  const optionsKey = useMemo(
    () => JSON.stringify({ xs, series, w: width, h: height }),
    [xs, series, width, height],
  );

  return (
    <EChartsBase
      width={width}
      height={height}
      ariaLabel={ariaLabel ?? spec.config?.title?.text ?? "Candlestick"}
      optionsKey={optionsKey}
      buildOptions={(_e: EChartsType, theme: ChartTheme) => ({
        backgroundColor: "transparent",
        textStyle: commonText(theme),
        tooltip: { ...commonTooltip(theme), trigger: "axis" },
        xAxis: {
          type: "category",
          data: xs,
          axisLine: { lineStyle: { color: theme.border } },
          axisLabel: {
            color: theme.mutedForeground,
            fontSize: 10,
            interval: echartsLabelInterval(xs.length),
          },
        },
        yAxis: {
          type: "value",
          axisLine: { lineStyle: { color: theme.border } },
          axisLabel: { color: theme.mutedForeground, fontSize: 10 },
          splitLine: { lineStyle: { color: theme.border, opacity: 0.3 } },
        },
        series: [
          {
            type: "candlestick",
            data: series,
            itemStyle: {
              color: theme.qualitative[5] ?? "green",
              color0: theme.qualitative[6] ?? "red",
              borderColor: theme.qualitative[5],
              borderColor0: theme.qualitative[6],
            },
          },
        ],
      })}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// Choropleth (geographic) — stub when no map registered.
// ────────────────────────────────────────────────────────────────────────

export function ChoroplethRenderer({
  spec,
  width,
  height,
}: RendererProps) {
  return (
    <div
      role="img"
      aria-label="Choropleth map (geographic data registration pending)"
      style={{ width, height }}
      className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/80 bg-muted/15 p-6 text-center text-xs text-muted-foreground"
    >
      <div className="text-sm font-medium text-foreground/70">
        Geographic map
      </div>
      <div className="max-w-[280px]">
        Choropleth requires a registered map (admin boundaries GeoJSON).
        Wire <code className="font-mono">echarts.registerMap()</code> in a
        future wave; the encoding contract is x={spec.encoding.x?.field ??
          "(region)"}, color={spec.encoding.color?.field ?? "(metric)"}.
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Gauge (radial speedometer)
// ────────────────────────────────────────────────────────────────────────

export function GaugeRenderer({
  spec,
  data,
  width,
  height,
  ariaLabel,
}: RendererProps) {
  const valueCh = resolveChannel(spec.encoding.y);
  if (!valueCh) {
    throw new Error("gauge mark requires a quantitative y encoding");
  }
  const value = useMemo(() => {
    if (data.length === 0) return 0;
    // Single-value KPI: average of all rows for simplicity.
    let sum = 0;
    let n = 0;
    for (const r of data) {
      const v = asNumber(valueCh.accessor(r));
      if (Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    return n > 0 ? sum / n : 0;
  }, [data, valueCh]);

  const optionsKey = useMemo(
    () => JSON.stringify({ value, w: width, h: height }),
    [value, width, height],
  );

  return (
    <EChartsBase
      width={width}
      height={height}
      ariaLabel={ariaLabel ?? spec.config?.title?.text ?? "Gauge"}
      optionsKey={optionsKey}
      buildOptions={(_e: EChartsType, theme: ChartTheme) => ({
        backgroundColor: "transparent",
        textStyle: commonText(theme),
        series: [
          {
            type: "gauge",
            startAngle: 200,
            endAngle: -20,
            min: 0,
            max: 100,
            progress: { show: true, width: 12 },
            axisLine: {
              lineStyle: {
                width: 12,
                color: [[1, theme.border]],
              },
            },
            axisTick: { show: false },
            splitLine: { length: 8, lineStyle: { color: theme.border } },
            axisLabel: { distance: 22, color: theme.mutedForeground, fontSize: 9 },
            pointer: { width: 4, length: "60%" },
            anchor: { show: true, size: 8, itemStyle: { color: theme.qualitative[0] ?? "#000" } },
            title: { show: false },
            detail: {
              valueAnimation: true,
              fontSize: 18,
              fontFamily: "var(--font-sans)",
              color: theme.foreground,
              offsetCenter: [0, "60%"],
              formatter: "{value}",
            },
            data: [{ value: Math.round(value), name: valueCh.field }],
            itemStyle: { color: theme.qualitative[0] ?? "#000" },
          },
        ],
      })}
    />
  );
}
