/**
 * Wave WI4-panel · ExplainSlicePanel — the receiving end of the WI4
 * explain-this-slice event family.
 *
 * Sits below DashboardView via the Radix `Sheet` primitive (right-
 * side slide-in). When `event != null`, the panel is open and shows
 * a summary of the (chart, column, region) pin plus the active-filter
 * snapshot captured at brush-up time. The regenerated insight prose
 * will be fetched by the follow-on WI4-wire wave via `useInsightRegen`
 * against rows narrowed by `applyChartFilters → filterRowsByBrushRegion`;
 * until that lands, the body renders a placeholder pinning the
 * pipeline shape.
 *
 * Pure render component. Owns no state — the parent (DashboardView)
 * holds the event in state via the `EXPLAIN_SLICE_EVENT` listener,
 * passes it down, and closes the panel by clearing the event back
 * to `null`. Mirrors the WD3 `DrillThroughSheet` shape so the three
 * click-intent receivers stay structurally parallel:
 *
 *   - WD2 → no panel (cross-filter applies in-place to dashboard state)
 *   - WD3 → DrillThroughSheet (right slide-in with row table)
 *   - WI4 → ExplainSlicePanel  (right slide-in with regenerated insight)
 */

import { useEffect, useMemo } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CitationHoverCard } from "@/components/CitationHoverCard";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { applyChartFilters, type ActiveChartFilters } from "@/lib/chartFilters";
import type { ChartSpec } from "@/shared/schema";
import {
  useInsightRegen,
  type InsightChartSpecLite,
  type InsightRegenRow,
} from "../hooks/useInsightRegen";
import type { InsightRegenCache } from "../lib/insightRegenCache";
import {
  filterRowsByBrushRegion,
  type BrushRegion,
  type ExplainSliceEvent,
} from "../lib/explainSlice";

interface ExplainSlicePanelProps {
  /**
   * The captured explain-slice event, or `null` when the panel is
   * closed. The parent flips this to `null` to close (via
   * `onOpenChange(false)`).
   */
  event: ExplainSliceEvent | null;
  /**
   * Radix-style open-change handler. Called with `false` when the
   * user clicks the overlay, the close button, or presses Escape.
   * Parent should clear `event` to `null` so a re-open with the same
   * payload re-fires the slide-in animation.
   */
  onOpenChange: (open: boolean) => void;
  /**
   * Wave WI4-wire · the chart spec of the brushed tile (resolved by
   * the parent via `event.chartId` → `activeSheet.charts[idx]`).
   * When `null`, the panel falls back to the WI4-panel placeholder
   * — either no event is active or the parent couldn't resolve the
   * tile.
   */
  chart?: ChartSpec | null;
  /**
   * Wave WI4-wire · the shared regen LRU+TTL cache lifted at
   * `DashboardView` mount. Threaded in so cached entries survive
   * panel open/close cycles within the same dashboard session.
   * Optional — when omitted the underlying hook falls back to a
   * per-mount cache (lost on close).
   */
  insightRegenCache?: InsightRegenCache;
}

/**
 * Format the active-filter snapshot for the panel body. Each filter
 * type (categorical / date / numeric) renders one human-readable
 * line. Local copy (rather than a shared util) because the WD3
 * sheet and the WI4 panel may diverge on filter display in future
 * waves (e.g. clickable filter chips on WI4-panel to refine the
 * slice further).
 */
function summariseFilters(filters: ActiveChartFilters | undefined): string[] {
  if (!filters) return [];
  const lines: string[] = [];
  for (const column of Object.keys(filters).sort()) {
    const sel = filters[column];
    if (!sel) continue;
    if (sel.type === "categorical") {
      lines.push(`${column} ∈ {${sel.values.join(", ")}}`);
    } else if (sel.type === "date") {
      lines.push(`${column} between ${sel.start} and ${sel.end}`);
    } else if (sel.type === "numeric") {
      lines.push(`${column} in [${sel.min}, ${sel.max}]`);
    }
  }
  return lines;
}

/**
 * Format a BrushRegion for the "Pinned slice" section. The four
 * region kinds get four different display shapes:
 *   - `numeric` → `[start, end]`
 *   - `temporal` → `<startISO> → <endISO>` (full ISO strings; the
 *     user can drill into the slice and see what window they're in,
 *     and the canonical form is more debuggable than a localised
 *     date)
 *   - `categorical` → comma-joined values, capped at 10 with a
 *     "… +N more" suffix so a 50-category brush doesn't blow the
 *     panel layout
 *   - `box2d` (Wave WI4-foundation-box2d) → `[xMin, xMax] × yColumn
 *     [yMin, yMax]` — Cartesian-product notation surfaces both axes
 *     symmetrically; the y-column name sits between the two ranges
 *     so the reader can see WHAT the y-bounds apply to without
 *     leaving the panel
 */
const MAX_CATEGORY_PREVIEW = 10;
function formatRegion(region: BrushRegion): string {
  if (region.kind === "numeric") {
    return `[${region.start}, ${region.end}]`;
  }
  if (region.kind === "temporal") {
    return `${new Date(region.startMs).toISOString()} → ${new Date(region.endMs).toISOString()}`;
  }
  if (region.kind === "categorical") {
    const values = region.values;
    if (values.length <= MAX_CATEGORY_PREVIEW) {
      return values.join(", ");
    }
    const preview = values.slice(0, MAX_CATEGORY_PREVIEW).join(", ");
    const more = values.length - MAX_CATEGORY_PREVIEW;
    return `${preview}, … +${more} more`;
  }
  // box2d — Wave WI4-foundation-box2d
  return `[${region.xMin}, ${region.xMax}] × ${region.yColumn} [${region.yMin}, ${region.yMax}]`;
}

/** Stable fallback identifier so `useInsightRegen` can be called
 * unconditionally (React rules of hooks). When no event is active
 * the hook spins up against this idle slot and never fires
 * `regenerate`, so the cache slot stays empty.
 */
const IDLE_TILE_ID = "__wi4_idle__";

export function ExplainSlicePanel({
  event,
  onOpenChange,
  chart,
  insightRegenCache,
}: ExplainSlicePanelProps) {
  const open = event !== null;
  const filterLines = summariseFilters(event?.filters);

  // Wave WI4-wire · derive the lite spec from the resolved chart.
  // Field-for-field subset of ChartSpec (same mapping as the WI2-
  // wire-bind specLite in ChartTileBody). `null` when no chart is
  // resolved — the regen effect short-circuits on null.
  const specLite: InsightChartSpecLite | null = useMemo(() => {
    if (!chart) return null;
    return {
      type: chart.type,
      title: chart.title,
      x: chart.x,
      y: chart.y,
      ...(chart.seriesColumn ? { seriesColumn: chart.seriesColumn } : {}),
      ...(chart.aggregate ? { aggregate: chart.aggregate } : {}),
    };
  }, [chart]);

  // Wave WI4-wire · compose the chart's backing rows through the
  // global filter context AND the brush region. The two filters are
  // predicate-AND commutative, so `applyChartFilters` first and
  // `filterRowsByBrushRegion` second produces the same set as the
  // reverse order; chosen order matches the WI2-wire-bind pipeline
  // for ChartTileBody so future readers see a consistent shape.
  const narrowedRows = useMemo<InsightRegenRow[]>(() => {
    if (!chart || !event) return [];
    const filteredByGlobal = applyChartFilters(
      (chart.data ?? []) as Array<Record<string, string | number | null>>,
      event.filters ?? {},
    );
    const filteredByBrush = filterRowsByBrushRegion(
      filteredByGlobal,
      event.column,
      event.region,
    );
    return filteredByBrush as InsightRegenRow[];
  }, [chart, event]);

  // Always call the hook (React rules of hooks). Use a stable idle
  // tileId when no event is active so the hook's cache key is
  // deterministic. Effect below short-circuits regenerate on null
  // event / chart.
  //
  // Wave WI4-cache-key · pass `event?.region` as the third cache-key
  // segment so two brushes on the same (chartId, filters) but
  // different sub-regions never share a cache slot. Without this the
  // hook would silently serve the first brush's prose for every
  // subsequent brush on the same tile.
  const regen = useInsightRegen({
    tileId: event?.chartId ?? IDLE_TILE_ID,
    filters: event?.filters ?? {},
    brushRegion: event?.region,
    cache: insightRegenCache,
  });

  // Fire regenerate when a fresh event arrives. The hook's internal
  // `seqRef` guards against stale resolves clobbering newer state if
  // the user brushes a second slice while the first is still
  // resolving. Effect deps include the resolved spec + rows so a
  // late-arriving chart prop also triggers a re-run.
  useEffect(() => {
    if (!event || !specLite) return;
    void regen.regenerate(specLite, narrowedRows);
    // The hook captures `regenerate` once via useRef internally, so
    // it's stable across renders within an instance. We intentionally
    // omit it from the deps to avoid a re-render loop; the
    // `event` / `specLite` / `narrowedRows` triplet drives every
    // legitimate re-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, specLite, narrowedRows]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {event ? `Explain ${event.column}` : "Explain …"}
          </SheetTitle>
          <SheetDescription>
            {event
              ? "Regenerated insight for the brushed sub-region of this chart."
              : "No active brush selection."}
          </SheetDescription>
        </SheetHeader>

        {event ? (
          <div className="mt-6 space-y-4 text-sm">
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pinned slice
              </h3>
              <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-muted-foreground">Chart</dt>
                <dd className="font-mono text-foreground">{event.chartId}</dd>
                <dt className="text-muted-foreground">Column</dt>
                <dd className="font-mono text-foreground">{event.column}</dd>
                <dt className="text-muted-foreground">Region</dt>
                <dd className="font-mono text-foreground">
                  <span className="mr-1 rounded bg-muted px-1 py-0.5 text-xs uppercase tracking-wide">
                    {event.region.kind}
                  </span>
                  {formatRegion(event.region)}
                </dd>
              </dl>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Filter context at brush time
              </h3>
              {filterLines.length > 0 ? (
                <ul className="mt-2 space-y-1 font-mono text-xs text-foreground">
                  {filterLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  No active filters — the regenerator sees the chart's
                  full backing rows, then narrows by the brushed
                  region only.
                </p>
              )}
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Regenerated insight
              </h3>
              {/*
                Wave WI4-wire · the regenerated insight prose. The
                narrowed rows (global filters → brush region) flow
                through `useInsightRegen` which POSTs to
                `/api/insight/regen` and caches by (tileId, filterHash).
                Render branches on the hook state: loading / error /
                entry.
              */}
              <div className="mt-2 text-xs">
                {!chart ? (
                  <p className="rounded border border-dashed border-border bg-muted/30 p-3 text-muted-foreground">
                    Could not resolve the chart for{" "}
                    <code className="font-mono">{event.chartId}</code>{" "}
                    — the brushed tile may have been removed.
                  </p>
                ) : regen.loading ? (
                  <p className="text-muted-foreground">
                    Regenerating insight for {narrowedRows.length} brushed
                    row{narrowedRows.length === 1 ? "" : "s"}…
                  </p>
                ) : regen.error ? (
                  <p role="alert" className="text-destructive">
                    Failed to regenerate: {regen.error}
                  </p>
                ) : regen.entry?.text ? (
                  <p className="whitespace-pre-wrap text-foreground">
                    {regen.entry.text}
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Waiting for the first regeneration…
                  </p>
                )}
              </div>
              {/*
                Wave WI4-citations · discoverable Sources row mirroring
                the WI3 footer pattern. Inline backtick-wrapped pack
                ids inside the regen prose already render as `[N]`
                superscript hover-cards via the MarkdownRenderer's
                WQ3 integration — that path is unchanged. This row
                surfaces the full `InsightRegenEntry.citations` array
                at a glance so the user can scan every cited pack
                without scrubbing the prose. Sits between the prose
                and the Re-explain button so all three regen
                affordances stack in source order: read → sources →
                refresh.
              */}
              {regen.entry?.citations && regen.entry.citations.length > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  <span>Sources:</span>
                  {regen.entry.citations.map((packId, i) => (
                    <CitationHoverCard key={packId} packId={packId} index={i + 1} />
                  ))}
                </div>
              ) : null}
              {/*
                Wave WI4-rexplain · explicit bypass-cache button so the
                user can force a fresh regeneration of the same slice
                (the panel auto-fires once per event, then serves from
                cache for re-opens of the identical region). Gated on
                `regen.entry?.text` so the button only appears once a
                regeneration has actually landed — mirrors the WI2
                footer's "✦ Re-explain this view" shape (Sparkles idle
                / Loader2 spin; disabled while loading; aria-label;
                stopPropagation so the sheet doesn't close).
              */}
              {regen.entry?.text && chart && specLite ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    aria-label="Re-explain this slice"
                    disabled={regen.loading}
                    onClick={(e) => {
                      e.stopPropagation();
                      void regen.regenerate(specLite, narrowedRows, {
                        bypassCache: true,
                      });
                    }}
                  >
                    {regen.loading ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <Sparkles className="mr-1 h-3 w-3" aria-hidden="true" />
                    )}
                    {regen.loading ? "Re-explaining…" : "Re-explain this slice"}
                  </Button>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
