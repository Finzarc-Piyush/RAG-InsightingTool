import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Edit2, History, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { CitationHoverCard } from "@/components/CitationHoverCard";
import { cn } from "@/lib/utils";
import type { ActiveChartFilters } from "@/lib/chartFilters";
import { pickFooterText } from "../lib/insightFooterState";
import type { InsightRegenEntry } from "../lib/insightRegenCache";
import type { InsightHistoryEntry } from "../lib/insightHistory";
import type { TileRecommendation } from "../lib/tileRecommendations";

/**
 * Wave DR18B · collapsible keyInsight footer for chart tiles.
 *
 * Pre-DR18B the footer (DR3) was always-on with a fixed
 * `max-h-[200px]` scroll container. Users couldn't focus on the chart
 * alone, and the footer didn't read as an interactive container.
 *
 * DR18B adds a chevron toggle. Default = open. Collapsed state
 * persists per-tile in `sessionStorage` keyed by
 * `${dashboardId}:${tileId}:insight-open`. The footer continues to
 * sit *inside* the same `<Card>` as the chart — it's just gained a
 * click target.
 */

const STORAGE_PREFIX = "dashboard-tile-insight-open:";

/**
 * Render an ISO timestamp as a short relative label ("12s ago",
 * "4 min ago", "2 h ago"). Pure; ms-precision input expected.
 * Returns the raw input verbatim when it doesn't parse.
 */
function formatRelativeShort(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaMs = Date.now() - t;
  if (deltaMs < 0) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/**
 * Wave WI6 · short label for a filter combo recorded in the history
 * dropdown. Branches:
 *   - empty filter map → "Baseline" (the no-filter slot)
 *   - exactly one categorical filter → "<column>: <value(s)>" truncated
 *     to 30 chars so the menu doesn't blow up on a 10-value categorical
 *   - exactly one numeric / date filter → "<column>: <range>" abbreviated
 *   - 2+ filters → "<N> filters" (the user can identify the combo by
 *     timestamp + the prose itself once selected)
 */
function formatHistoryLabel(filters: ActiveChartFilters): string {
  const entries = Object.entries(filters).filter(([, s]) => s !== undefined);
  if (entries.length === 0) return "Baseline";
  if (entries.length === 1) {
    const [column, sel] = entries[0];
    if (!sel) return "Baseline";
    let value: string;
    if (sel.type === "categorical") {
      value = sel.values.join(", ");
    } else if (sel.type === "date") {
      value = `${sel.start ?? "…"} → ${sel.end ?? "…"}`;
    } else {
      value = `${sel.min ?? "…"} – ${sel.max ?? "…"}`;
    }
    const raw = `${column}: ${value}`;
    return raw.length > 30 ? `${raw.slice(0, 29)}…` : raw;
  }
  return `${entries.length} filters`;
}

function readPersistedOpen(dashboardId: string, tileId: string): boolean {
  if (typeof sessionStorage === "undefined") return true;
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${dashboardId}:${tileId}`);
    if (raw === "0") return false;
    if (raw === "1") return true;
    return true;
  } catch {
    return true;
  }
}

function writePersistedOpen(
  dashboardId: string,
  tileId: string,
  open: boolean,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      `${STORAGE_PREFIX}${dashboardId}:${tileId}`,
      open ? "1" : "0",
    );
  } catch {
    // Quota / private mode — ignore.
  }
}

/**
 * Wave WI2-wire · optional regen surface. When provided, the footer
 * renders a "✦ Re-explain this view" button under the static insight
 * text. The regenerated entry takes precedence over the static prose
 * once it lands. The originating call shape (cache + server merge)
 * lives in `useInsightRegen`; this component just renders the result.
 */
export interface TileInsightFooterRegenProps {
  /** Latest cached / fetched regen entry; `undefined` until first regenerate(). */
  entry: InsightRegenEntry | undefined;
  /** True while a regen network call is in-flight. */
  loading: boolean;
  /** Error from the last regen attempt, or null. */
  error: string | null;
  /** Trigger a regen. Caller wires this to a no-arg fn (binds spec / data / context). */
  onRegenerate: () => void;
}

interface TileInsightFooterProps {
  insight: string;
  /**
   * Wave Z3 · when true AND there's no insight/regen text yet, the body shows
   * a muted "no insight yet" line + the regen button relabelled "Generate
   * insight". Lets the footer always render (so the collapsible chrome is
   * present) while the server's async insight patch is still in flight.
   */
  emptyState?: boolean;
  dashboardId: string;
  tileId: string;
  /** Whether the user holds permission to edit. */
  canEdit: boolean;
  /** Whether the dashboard is currently in edit mode (DR1). */
  isEditing: boolean;
  /** Callback for the inline edit button. */
  onEdit?: () => void;
  /** WI2-wire · optional regen surface. When omitted, no button renders. */
  regen?: TileInsightFooterRegenProps;
  /**
   * WI5 · optional per-tile "Try this" recommendation chips. When the
   * array is empty / omitted, no row renders. Each chip's onClick fires
   * `onRecommendationClick(rec)` so the parent (ChartTileBody) can route
   * each kind to the right state mutation (apply filter / clear filters).
   */
  recommendations?: TileRecommendation[];
  onRecommendationClick?: (rec: TileRecommendation) => void;
  /**
   * Wave WI6 · optional per-tile insight history list (newest first).
   * When non-empty AND `onHistorySelect` is provided, a "Recent insights"
   * dropdown renders in the action row. Clicking an entry calls
   * `onHistorySelect(entry)` so the parent (ChartTileBody) can restore
   * the recorded filter combo via the dashboard's `onFiltersChange`.
   */
  history?: InsightHistoryEntry[];
  onHistorySelect?: (entry: InsightHistoryEntry) => void;
}

export function TileInsightFooter({
  insight,
  emptyState = false,
  dashboardId,
  tileId,
  canEdit,
  isEditing,
  onEdit,
  regen,
  recommendations,
  onRecommendationClick,
  history,
  onHistorySelect,
}: TileInsightFooterProps) {
  const [open, setOpen] = useState<boolean>(() =>
    readPersistedOpen(dashboardId, tileId),
  );

  // Re-hydrate when the tile id changes (sheet swap / dashboard switch).
  useEffect(() => {
    setOpen(readPersistedOpen(dashboardId, tileId));
  }, [dashboardId, tileId]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      writePersistedOpen(dashboardId, tileId, next);
      return next;
    });
  }, [dashboardId, tileId]);

  return (
    <div
      className={cn(
        "relative flex-shrink-0 group/insight border-t border-border/40 bg-muted/30 -mx-4 -mb-4 mt-1",
        open ? "max-h-[260px] overflow-y-auto" : "",
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`tile-insight-body-${tileId}`}
        className="w-full flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary px-4 py-2 hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        <span aria-hidden="true">✦</span>
        <span className="text-foreground">Insight</span>
        {!open ? (
          <span className="ml-auto text-muted-foreground font-normal normal-case tracking-normal">
            Click to expand
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={`tile-insight-body-${tileId}`}
          className="px-4 pb-3 -mt-1 text-sm leading-relaxed text-foreground/90 pr-7"
        >
          {/*
           * WI2-wire · the regenerated entry takes precedence over the
           * static keyInsight once it lands. Until then the static
           * prose renders so the footer isn't empty during the first
           * regen attempt.
           *
           * Wave WI3 · inline backtick-wrapped pack ids inside the
           * regen text render as `[N]` superscript hover-cards via
           * `MarkdownRenderer`'s WQ3 integration — no extra wiring
           * needed here. The `Sources:` row below surfaces the
           * `InsightRegenEntry.citations` array as a discoverable list
           * for users who want to see every cited pack at a glance.
           */}
          {(() => {
            const footerText = pickFooterText(regen?.entry?.text, insight);
            if (footerText) return <MarkdownRenderer content={footerText} />;
            if (emptyState) {
              return (
                <p className="text-muted-foreground italic">
                  No insight yet — generate one below.
                </p>
              );
            }
            return null;
          })()}
          {regen?.entry?.regeneratedAt ? (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Updated {formatRelativeShort(regen.entry.regeneratedAt)}
              {regen.entry.confidenceTier
                ? ` · ${regen.entry.confidenceTier} confidence`
                : ""}
            </div>
          ) : null}
          {regen?.entry?.citations && regen.entry.citations.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span>Sources:</span>
              {regen.entry.citations.map((packId, i) => (
                <CitationHoverCard key={packId} packId={packId} index={i + 1} />
              ))}
            </div>
          ) : null}
          {/*
           * WI5 · per-tile "Try this" recommendation chips. Each chip
           * applies a single-click state mutation (categorical filter
           * pin / clear filters) via `onRecommendationClick`. Slotted
           * after the Sources row and before the action row so the
           * row order goes: prose → metadata → sources → try-this →
           * actions (Re-explain + Edit).
           */}
          {recommendations && recommendations.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span>Try this:</span>
              {recommendations.map((rec) => (
                <Button
                  key={rec.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  aria-label={rec.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRecommendationClick?.(rec);
                  }}
                >
                  {rec.label}
                </Button>
              ))}
            </div>
          ) : null}
          {regen ? (
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                aria-label="Re-explain this view"
                disabled={regen.loading}
                onClick={(e) => {
                  e.stopPropagation();
                  regen.onRegenerate();
                }}
              >
                {regen.loading ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="mr-1 h-3 w-3" aria-hidden="true" />
                )}
                {regen.loading
                  ? emptyState
                    ? "Generating…"
                    : "Re-explaining…"
                  : emptyState
                    ? "Generate insight"
                    : "Re-explain this view"}
              </Button>
              {/*
               * Wave WI6 · "Recent insights" dropdown. Surfaces the per-
               * tile MRU history slots (up to MAX_HISTORY_PER_TILE = 3).
               * Gated on history being a non-empty array AND a select
               * handler being wired — both conditions are satisfied
               * iff `ChartTileBody` has the `insightHistoryStore` prop
               * threaded from `DashboardView`. Clicking an item calls
               * `onHistorySelect(entry)`, which restores the recorded
               * filter combo via the dashboard's `onFiltersChange`.
               */}
              {history && history.length > 0 && onHistorySelect ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      aria-label="Recent insights"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <History className="mr-1 h-3 w-3" aria-hidden="true" />
                      Recent insights ({history.length})
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenuLabel className="text-[11px] text-muted-foreground font-normal">
                      Insights for:
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {history.map((entry) => (
                      <DropdownMenuItem
                        key={entry.filterHash}
                        onSelect={() => onHistorySelect(entry)}
                        className="text-[12px]"
                      >
                        <div className="flex flex-col">
                          <span>{formatHistoryLabel(entry.filters)}</span>
                          {entry.entry.regeneratedAt ? (
                            <span className="text-[10px] text-muted-foreground">
                              {formatRelativeShort(entry.entry.regeneratedAt)}
                            </span>
                          ) : null}
                        </div>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {regen.error ? (
                <span
                  role="alert"
                  className="text-[11px] text-destructive"
                >
                  {regen.error}
                </span>
              ) : null}
            </div>
          ) : null}
          {canEdit && onEdit ? (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "absolute right-1 top-1 h-6 w-6 transition-opacity",
                isEditing
                  ? "opacity-0 group-hover/insight:opacity-100"
                  : "opacity-0 pointer-events-none",
              )}
              aria-label="Edit insight"
              aria-hidden={!isEditing}
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              <Edit2 className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
