import {
  AreaChart as AreaIcon,
  BarChart3 as BarIcon,
  CalendarDays as CalendarIcon,
  CandlestickChart as CandlestickIcon,
  CircleDot as PointIcon,
  Donut as ArcIcon,
  Gauge as GaugeIcon,
  Layers3 as TreemapIcon,
  LineChart as LineIcon,
  Map as ChoroplethIcon,
  Network as SankeyIcon,
  PieChart as SunburstIcon,
  Radar as RadarIcon,
  Spline as RegressionIcon,
  Square as RectIcon,
  TrendingDown as FunnelIcon,
  Waves as WaterfallIcon,
  type LucideIcon,
} from "lucide-react";
import type { ChartEncoding, ChartV2Mark } from "@/shared/schema";

export type MarkGroup =
  | "Compare"
  | "Trend"
  | "Distribution"
  | "Composition"
  | "Hierarchy"
  | "Flow"
  | "KPI"
  | "Geo"
  | "Special";

export interface MarkMeta {
  mark: ChartV2Mark;
  label: string;
  icon: LucideIcon;
  group: MarkGroup;
  requires: (enc: ChartEncoding) => string | null;
}

export const MARKS: MarkMeta[] = [
  {
    mark: "bar",
    label: "Bar",
    icon: BarIcon,
    group: "Compare",
    requires: (e) =>
      e.x && e.y ? null : "Bar needs an x and a quantitative y encoding.",
  },
  {
    mark: "line",
    label: "Line",
    icon: LineIcon,
    group: "Trend",
    requires: (e) =>
      e.x && e.y ? null : "Line needs an x and a quantitative y encoding.",
  },
  {
    mark: "area",
    label: "Area",
    icon: AreaIcon,
    group: "Trend",
    requires: (e) =>
      e.x && e.y ? null : "Area needs an x and a quantitative y encoding.",
  },
  {
    mark: "point",
    label: "Scatter",
    icon: PointIcon,
    group: "Distribution",
    requires: (e) =>
      e.x?.type === "q" && e.y?.type === "q"
        ? null
        : "Scatter needs two quantitative encodings.",
  },
  {
    mark: "bubble",
    label: "Bubble",
    icon: PointIcon,
    group: "Distribution",
    requires: (e) =>
      e.x?.type === "q" && e.y?.type === "q" && e.size
        ? null
        : "Bubble needs quantitative x, y, and a size encoding.",
  },
  {
    mark: "regression",
    label: "Trend line",
    icon: RegressionIcon,
    group: "Trend",
    requires: (e) =>
      e.x?.type === "q" && e.y?.type === "q"
        ? null
        : "Trend line needs two quantitative encodings.",
  },
  {
    mark: "box",
    label: "Boxplot",
    icon: BarIcon,
    group: "Distribution",
    requires: (e) =>
      e.y?.type === "q" ? null : "Boxplot needs a quantitative y encoding.",
  },
  {
    mark: "arc",
    label: "Pie / donut",
    icon: ArcIcon,
    group: "Composition",
    requires: (e) =>
      (e.x || e.color) && e.y?.type === "q"
        ? null
        : "Pie needs a category (x or color) and a quantitative value.",
  },
  {
    mark: "rect",
    label: "Heatmap",
    icon: RectIcon,
    group: "Composition",
    requires: (e) =>
      e.x && e.y && e.color
        ? null
        : "Heatmap needs x (row), y (column), and a color (value) encoding.",
  },
  {
    mark: "combo",
    label: "Combo (bar+line)",
    icon: BarIcon,
    group: "Compare",
    requires: (e) =>
      e.x && e.y && e.y2
        ? null
        : "Combo needs x, y, and a second y2 encoding.",
  },
  {
    mark: "waterfall",
    label: "Waterfall",
    icon: WaterfallIcon,
    group: "Compare",
    requires: (e) =>
      e.x && e.y?.type === "q"
        ? null
        : "Waterfall needs an x and a quantitative y.",
  },
  {
    mark: "funnel",
    label: "Funnel",
    icon: FunnelIcon,
    group: "Composition",
    requires: (e) =>
      e.x && e.y?.type === "q"
        ? null
        : "Funnel needs a stage (x) and a quantitative y.",
  },
  {
    mark: "radar",
    label: "Radar",
    icon: RadarIcon,
    group: "Compare",
    requires: (e) =>
      e.x && e.y?.type === "q"
        ? null
        : "Radar needs categorical x and quantitative y.",
  },
  {
    mark: "treemap",
    label: "Treemap",
    icon: TreemapIcon,
    group: "Hierarchy",
    requires: (e) =>
      e.x && e.y?.type === "q"
        ? null
        : "Treemap needs a category (x) and a quantitative size (y).",
  },
  {
    mark: "sunburst",
    label: "Sunburst",
    icon: SunburstIcon,
    group: "Hierarchy",
    requires: (e) =>
      e.x && e.y?.type === "q"
        ? null
        : "Sunburst needs a category (x) and a quantitative size (y).",
  },
  {
    mark: "sankey",
    label: "Sankey",
    icon: SankeyIcon,
    group: "Flow",
    requires: (e) =>
      e.x && e.y && e.size
        ? null
        : "Sankey needs source (x), target (y), and a flow size encoding.",
  },
  {
    mark: "parallel",
    label: "Parallel coords",
    icon: SankeyIcon,
    group: "Distribution",
    requires: (e) =>
      e.x ? null : "Parallel coordinates need at least one encoding.",
  },
  {
    mark: "calendar",
    label: "Calendar heatmap",
    icon: CalendarIcon,
    group: "Trend",
    requires: (e) =>
      e.x?.type === "t" && e.color?.type === "q"
        ? null
        : "Calendar heatmap needs temporal x and a quantitative color value.",
  },
  {
    mark: "candlestick",
    label: "Candlestick",
    icon: CandlestickIcon,
    group: "Trend",
    requires: (e) =>
      e.x?.type === "t" && e.y?.type === "q" && e.y2?.type === "q"
        ? null
        : "Candlestick needs temporal x and quantitative y / y2.",
  },
  {
    mark: "choropleth",
    label: "Geographic",
    icon: ChoroplethIcon,
    group: "Geo",
    requires: (e) =>
      e.x && e.color?.type === "q"
        ? null
        : "Geographic needs a region (x) and a quantitative color.",
  },
  {
    mark: "gauge",
    label: "Gauge",
    icon: GaugeIcon,
    group: "KPI",
    requires: (e) =>
      e.y?.type === "q" ? null : "Gauge needs a quantitative y.",
  },
  {
    mark: "kpi",
    label: "KPI tile",
    icon: GaugeIcon,
    group: "KPI",
    requires: (e) =>
      e.y?.type === "q" ? null : "KPI needs a quantitative y.",
  },
];

export const GROUP_ORDER: MarkGroup[] = [
  "Compare",
  "Trend",
  "Distribution",
  "Composition",
  "Hierarchy",
  "Flow",
  "Geo",
  "KPI",
  "Special",
];

export function groupedMarks(): { group: MarkGroup; items: MarkMeta[] }[] {
  const m = new Map<MarkGroup, MarkMeta[]>();
  for (const meta of MARKS) {
    const arr = m.get(meta.group) ?? [];
    arr.push(meta);
    m.set(meta.group, arr);
  }
  return GROUP_ORDER.filter((g) => m.has(g)).map((g) => ({
    group: g,
    items: m.get(g)!,
  }));
}
