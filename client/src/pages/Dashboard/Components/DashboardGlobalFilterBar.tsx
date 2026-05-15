import { Filter, X as XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ActiveChartFilters } from "@/lib/chartFilters";

/**
 * Wave DR4 · global dashboard filter bar.
 *
 * Renders one chip per active condition in `global`. Each chip carries a
 * dismiss button (clears that column from `global`); a "Clear all" link
 * appears when ≥ 2 conditions are set. Below the chips, a small hint
 * line shows how many tiles each condition actually applies to — the
 * peer review's "applies to N of M tiles" requirement.
 *
 * The bar renders nothing when `global` is empty, so it costs zero pixels
 * for dashboards without a captured filter and without user-added
 * filters. Adding filters from the bar is a follow-up wave; the
 * existing per-tile filter UI inside `ChartRenderer` still works and
 * lands in `perTile` overrides through DashboardView.
 */

interface DashboardGlobalFilterBarProps {
  global: ActiveChartFilters;
  /** column → number of chart tiles whose data carries that column */
  appliesToCountByColumn: Record<string, number>;
  totalChartTiles: number;
  onChange: (next: ActiveChartFilters) => void;
}

function chipLabelForSelection(
  column: string,
  sel: NonNullable<ActiveChartFilters[string]>,
): string {
  if (sel.type === "categorical") {
    if (!sel.values || sel.values.length === 0) return column;
    if (sel.values.length === 1) return `${column} = ${sel.values[0]}`;
    if (sel.values.length <= 3) return `${column} ∈ {${sel.values.join(", ")}}`;
    return `${column} ∈ ${sel.values.length} values`;
  }
  if (sel.type === "numeric") {
    const lo = sel.min !== undefined ? `${sel.min}` : "";
    const hi = sel.max !== undefined ? `${sel.max}` : "";
    if (lo && hi) return `${column} ∈ [${lo}, ${hi}]`;
    if (lo) return `${column} ≥ ${lo}`;
    if (hi) return `${column} ≤ ${hi}`;
    return column;
  }
  // date
  if (sel.start && sel.end) return `${column}: ${sel.start} → ${sel.end}`;
  if (sel.start) return `${column} ≥ ${sel.start}`;
  if (sel.end) return `${column} ≤ ${sel.end}`;
  return column;
}

export function DashboardGlobalFilterBar({
  global,
  appliesToCountByColumn,
  totalChartTiles,
  onChange,
}: DashboardGlobalFilterBarProps) {
  const entries = Object.entries(global).filter(
    (e): e is [string, NonNullable<ActiveChartFilters[string]>] => !!e[1],
  );
  if (entries.length === 0) return null;

  const handleRemove = (column: string) => {
    const next: ActiveChartFilters = { ...global };
    delete next[column];
    onChange(next);
  };

  const handleClearAll = () => {
    onChange({});
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2"
        data-testid="dashboard-global-filter-bar"
        role="region"
        aria-label="Dashboard filters"
      >
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Filter className="h-3.5 w-3.5 text-primary" />
          Filters
        </span>
        {entries.map(([column, sel]) => {
          const applies = appliesToCountByColumn[column] ?? 0;
          const inapplicable = applies < totalChartTiles;
          return (
            <Tooltip key={column}>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs"
                >
                  <span className="text-foreground">
                    {chipLabelForSelection(column, sel)}
                  </span>
                  {totalChartTiles > 0 ? (
                    <span
                      className={
                        inapplicable
                          ? "text-muted-foreground"
                          : "text-muted-foreground"
                      }
                    >
                      · {applies}/{totalChartTiles}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleRemove(column)}
                    className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`Remove ${column} filter`}
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[280px]">
                {totalChartTiles === 0 ? (
                  <span>No chart tiles to filter.</span>
                ) : inapplicable ? (
                  <span>
                    Applies to {applies} of {totalChartTiles} chart
                    {totalChartTiles === 1 ? "" : "s"}. Tiles whose data
                    doesn't carry this column show a "doesn't apply" note.
                  </span>
                ) : (
                  <span>
                    Applies to all {totalChartTiles} chart
                    {totalChartTiles === 1 ? "" : "s"}.
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {entries.length >= 2 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearAll}
            className="ml-auto h-7 px-2 text-xs"
          >
            Clear all
          </Button>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
