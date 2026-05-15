import {
  Activity,
  AreaChart as AreaChartIcon,
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  ScatterChart,
  Table as TableIcon,
} from "lucide-react";
import type { ChartSpec, DashboardSheet } from "@/shared/schema";

/**
 * Wave DR10 · per-card thumbnail strip on the dashboard list.
 *
 * Each card surfaces up to four chart-type icons + truncated titles,
 * giving the user at-a-glance recognition of what's inside without
 * paying the cost of mounting `ChartShim`/`ChartRenderer` on the list
 * (which would lazy-load the chart vendor bundle for every card).
 *
 * The strip is purely decorative — the existing "View Dashboard"
 * button is still the click target for opening.
 */

type ChartType = ChartSpec["type"];

const ICONS: Record<ChartType, typeof BarChart3> = {
  bar: BarChart3,
  line: LineChartIcon,
  area: AreaChartIcon,
  pie: PieChartIcon,
  scatter: ScatterChart,
  heatmap: Activity,
};

interface ThumbnailItem {
  kind: "chart" | "table" | "pivot";
  type?: ChartType;
  title: string;
}

function collectThumbnails(sheets: DashboardSheet[] | undefined): ThumbnailItem[] {
  if (!sheets || sheets.length === 0) return [];
  const items: ThumbnailItem[] = [];
  for (const sheet of sheets) {
    for (const chart of sheet.charts ?? []) {
      items.push({ kind: "chart", type: chart.type, title: chart.title });
    }
    for (const t of sheet.tables ?? []) {
      items.push({ kind: "table", title: t.caption });
    }
    for (const p of sheet.pivots ?? []) {
      items.push({ kind: "pivot", title: p.title ?? "Pivot" });
    }
  }
  return items;
}

interface DashboardCardThumbnailsProps {
  sheets?: DashboardSheet[];
  /** Maximum tiles surfaced; remainder is summarized as "+N more". */
  max?: number;
}

export function DashboardCardThumbnails({
  sheets,
  max = 4,
}: DashboardCardThumbnailsProps) {
  const all = collectThumbnails(sheets);
  if (all.length === 0) return null;
  const head = all.slice(0, max);
  const remaining = all.length - head.length;
  return (
    <div
      className="flex flex-wrap gap-1.5"
      role="list"
      aria-label={`Contains ${all.length} tiles`}
    >
      {head.map((item, idx) => {
        const Icon =
          item.kind === "chart" && item.type
            ? ICONS[item.type]
            : item.kind === "table"
              ? TableIcon
              : BarChart3;
        return (
          <div
            key={idx}
            role="listitem"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground max-w-[180px]"
            title={item.title}
          >
            <Icon className="h-3 w-3 text-primary flex-shrink-0" aria-hidden="true" />
            <span className="truncate">{item.title || `${item.kind} ${idx + 1}`}</span>
          </div>
        );
      })}
      {remaining > 0 ? (
        <div className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
          +{remaining} more
        </div>
      ) : null}
    </div>
  );
}
