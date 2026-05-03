/**
 * MarkPicker — chart-type selector with smart constraints. WC2.4.
 *
 * Lists every v2 mark with an icon and short label. Each entry is
 * disabled (with a tooltip explanation) when the current encoding
 * doesn't satisfy the mark's minimum requirements. So a user with a
 * categorical X and a quantitative Y sees `bar` / `line` / `area` /
 * `arc` / `treemap` enabled and `scatter (point)` / `regression`
 * disabled with "needs 2 quantitative encodings".
 *
 * Visual: dropdown styled with Radix Select to match the rest of the
 * app's UI primitives.
 */

import {
  AreaChart as AreaIcon,
  BarChart3 as BarIcon,
  CalendarDays as CalendarIcon,
  CandlestickChart as CandlestickIcon,
  ChevronDown,
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
import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChartEncoding, ChartV2Mark } from "@/shared/schema";

interface MarkMeta {
  mark: ChartV2Mark;
  label: string;
  icon: LucideIcon;
  /** Group label in the dropdown. */
  group: "Compare" | "Trend" | "Distribution" | "Composition" | "Hierarchy" | "Flow" | "KPI" | "Geo" | "Special";
  /** Minimum encoding contract; mark is disabled when not met. */
  requires: (enc: ChartEncoding) => string | null; // returns null if satisfied, else explanation
}

const MARKS: MarkMeta[] = [
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

const GROUP_ORDER: MarkMeta["group"][] = [
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

export interface MarkPickerProps {
  /** Current selected mark. */
  value: ChartV2Mark;
  /** Current encoding (used to compute disabled state). */
  encoding: ChartEncoding;
  onChange: (mark: ChartV2Mark) => void;
  className?: string;
  /** Compact trigger for dense pivot panels. */
  compact?: boolean;
}

export function MarkPicker({
  value,
  encoding,
  onChange,
  className,
  compact = false,
}: MarkPickerProps) {
  const grouped = useMemo(() => {
    const m = new Map<MarkMeta["group"], MarkMeta[]>();
    for (const meta of MARKS) {
      const arr = m.get(meta.group) ?? [];
      arr.push(meta);
      m.set(meta.group, arr);
    }
    return GROUP_ORDER.filter((g) => m.has(g)).map((g) => ({
      group: g,
      items: m.get(g)!,
    }));
  }, []);

  const current = MARKS.find((m) => m.mark === value);
  const CurrentIcon = current?.icon ?? BarIcon;

  return (
    <Select value={value} onValueChange={(v) => onChange(v as ChartV2Mark)}>
      <SelectTrigger
        className={
          (compact ? "h-7 px-2 text-xs " : "h-9 px-3 text-sm ") +
          "inline-flex items-center gap-2 rounded-md border-border/80 bg-card text-foreground hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-primary/40 " +
          (className ?? "")
        }
        aria-label="Chart type"
      >
        <CurrentIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <SelectValue placeholder="Pick a chart type" />
        <ChevronDown className="ml-auto h-3.5 w-3.5 opacity-60" />
      </SelectTrigger>
      <SelectContent className="max-h-[420px]">
        {grouped.map((g) => (
          <div key={g.group}>
            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {g.group}
            </div>
            {g.items.map((it) => {
              const reason = it.requires(encoding);
              const disabled = reason !== null;
              const Icon = it.icon;
              return (
                <SelectItem
                  key={it.mark}
                  value={it.mark}
                  disabled={disabled}
                  title={reason ?? undefined}
                  className="data-[disabled]:opacity-50"
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5" />
                    <span>{it.label}</span>
                  </span>
                </SelectItem>
              );
            })}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}
