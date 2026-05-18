import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Edit2, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { cn } from "@/lib/utils";
import type { InsightRegenEntry } from "../lib/insightRegenCache";

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
}

export function TileInsightFooter({
  insight,
  dashboardId,
  tileId,
  canEdit,
  isEditing,
  onEdit,
  regen,
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
           */}
          <MarkdownRenderer content={regen?.entry?.text || insight} />
          {regen?.entry?.regeneratedAt ? (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Updated {formatRelativeShort(regen.entry.regeneratedAt)}
              {regen.entry.confidenceTier
                ? ` · ${regen.entry.confidenceTier} confidence`
                : ""}
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
                {regen.loading ? "Re-explaining…" : "Re-explain this view"}
              </Button>
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
