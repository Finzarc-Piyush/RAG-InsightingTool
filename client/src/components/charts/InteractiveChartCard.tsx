/**
 * InteractiveChartCard — small toolbar wrapper around <ChartShim> that gives
 * a chart consumer parity with the pivot preview's in-card controls:
 *   • mark switch (bar | line | area) — preserves x/y/series, strips bar-only fields
 *   • stacked/grouped toggle — only for bar charts with a series dimension
 *   • chart ↔ pivot view toggle — read-only pivot of chart.data, expand/collapse only
 *
 * Filter chips remain owned by the legacy <ChartRenderer> via its `enableFilters`
 * prop; this wrapper does not duplicate that UI.
 *
 * Mutations are local: changing the toolbar adjusts a state-owned copy of the
 * spec and re-renders. No server roundtrip. v2 specs pass through untouched —
 * the mark/layout dropdowns hide until v2 mutation helpers exist, but the
 * pivot-view toggle still works (chart.data is shape-compatible across v1/v2).
 */
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { BarChart3, Maximize2, Table2 } from "lucide-react";
import { isChartSpecV2, type ChartSpec, type ChartSpecV2 } from "@/shared/schema";
import { cn } from "@/lib/utils";
import { ChartShim } from "./ChartShim";

// Lazy so the recharts-heavy modal only loads when the user clicks Maximize —
// the same rich modal ChartRenderer opens on header-click; this just adds the
// discoverable icon-button trigger the dashboard tile already has (parity).
const ChartModal = lazy(() =>
  import("@/pages/Home/Components/ChartModal").then((m) => ({
    default: m.ChartModal,
  })),
);
import { ChartTilePivotView } from "./ChartTilePivotView";
import { chartSpecToPivotConfig } from "./chartSpecToPivotConfig";
import { ChartParityToolbar } from "./ChartParityToolbar";
import {
  coerceMarkType,
  isSwitchableMark,
  type SwitchableMark,
  type ChartSpecPatch,
} from "@/lib/charts/chartSpecMutations";
import { ChartSortControl } from "./ChartSortControl";
import { ChartLimitControl, type ChartLimit } from "./ChartLimitControl";
import {
  useChartSort,
  chartSupportsSort,
  type ChartSortSpec,
} from "@/lib/charts/useChartSort";

// Stable fallback so the useChartSort hook can be called unconditionally even
// when there is no v1 spec to sort (v2 marks). Module-level → stable identity.
const EMPTY_SORT_SPEC: ChartSpec = { type: "bar", title: "", x: "", y: "", data: [] };

/**
 * Structural identity for a chart spec — used to decide when to reset local
 * toolbar state. Chosen so that an upstream re-render handing back a new
 * object reference for an unchanged spec does NOT wipe the user's mark /
 * layout choice. Keys reflect every field the toolbar can mutate plus the
 * core encoding so a meaningfully different chart still triggers a reset.
 */
function chartIdentityKey(spec: ChartSpec | ChartSpecV2): string {
  if (isChartSpecV2(spec)) {
    const v2 = spec as ChartSpecV2;
    // v2 is opaque to the toolbar; key on the entire spec so any change resets.
    try {
      return `v2|${JSON.stringify(v2)}`;
    } catch {
      return "v2|unhashable";
    }
  }
  const v1 = spec as ChartSpec;
  // dataLen catches the partial→updated case where the agent emits a chart
  // with empty data first then fills it in; without this, the local copy
  // would never refresh because x/y/type haven't moved (Bug G).
  const dataLen = Array.isArray(v1.data) ? v1.data.length : 0;
  return [
    "v1",
    v1.type,
    v1.title,
    v1.x,
    v1.y,
    v1.z ?? "",
    v1.seriesColumn ?? "",
    (v1.seriesKeys ?? []).join(","),
    `dlen=${dataLen}`,
  ].join("|");
}

/**
 * Decide whether the chart→pivot toggle can be offered. The pivot pipeline
 * needs a v1 spec with x, y, and a non-empty data array. v2 specs are
 * opaque here, and during streaming a chart can be created before data
 * arrives — we hide the toggle until both conditions are met to avoid
 * flicker.
 */
function canShowPivotToggle(spec: ChartSpec | ChartSpecV2 | null): spec is ChartSpec {
  if (!spec) return false;
  if (isChartSpecV2(spec)) return false;
  if (chartSpecToPivotConfig(spec as ChartSpec) === null) return false;
  const data = (spec as ChartSpec).data;
  return Array.isArray(data) && data.length > 0;
}

export interface InteractiveChartCardProps {
  chart: ChartSpec | ChartSpecV2;
  keyInsightSessionId?: string | null;
  /** Hide individual toolbar items when callers already provide them externally. */
  controls?: {
    chartType?: boolean;
    barLayout?: boolean;
    pivotToggle?: boolean;
    /** W-GMK9 · "Show value labels" checkbox. Defaults visible. */
    dataLabels?: boolean;
    /** Wave S5 · "Sort by" dropdown. Defaults visible for bar/column charts. */
    sort?: boolean;
    /** W10 · explicit Maximize (fullscreen) button. Defaults visible. */
    expand?: boolean;
  };
  /** Caller-supplied legacy renderer; receives the locally-mutated spec. */
  renderLegacy: (spec: ChartSpec) => ReactNode;
  className?: string;
  /**
   * Wave S5 · invoked when the user changes the "Sort by" dropdown. The visual
   * re-order is already applied locally; the caller persists the choice (chat →
   * sessionsApi.updateMessageChartSort). Omitted = ephemeral (no persistence).
   */
  onSortPersist?: (sort: ChartSortSpec) => void;
  /**
   * W7 · invoked when the parity toolbar mutates the spec (mark switch /
   * stacked-grouped / show-labels) or the inline Top-N limit changes (W8). The
   * mutation is already applied to the local spec; the caller persists it (chat
   * → sessionsApi.updateMessageChartSpec). Omitted = ephemeral.
   */
  onSpecPersist?: (patch: ChartSpecPatch) => void;
}

export function InteractiveChartCard({
  chart,
  keyInsightSessionId,
  controls,
  renderLegacy,
  className,
  onSortPersist,
  onSpecPersist,
}: InteractiveChartCardProps) {
  const showChartType = controls?.chartType !== false;
  const showBarLayout = controls?.barLayout !== false;
  const showPivotToggle = controls?.pivotToggle !== false;
  const showDataLabelsToggle = controls?.dataLabels !== false;

  const [localV1, setLocalV1] = useState<ChartSpec | null>(() =>
    isChartSpecV2(chart) ? null : (chart as ChartSpec)
  );
  const [view, setView] = useState<"chart" | "pivot">("chart");
  const [isExpandOpen, setIsExpandOpen] = useState(false);
  // W8 · durable Top-N / Bottom-N selection — parity with the dashboard tile.
  // Seeded from the chart's persisted `limit`; persisted via onSpecPersist.
  const [limit, setLimit] = useState<ChartLimit>(
    isChartSpecV2(chart) ? null : (chart as ChartSpec).limit ?? null,
  );

  // Reset only when the chart's STRUCTURAL identity changes — not on every
  // parent re-render that hands back a new object reference for the same
  // spec. Otherwise toolbar state would be wiped on streaming-driven re-renders.
  const identity = useMemo(() => chartIdentityKey(chart), [chart]);
  useEffect(() => {
    if (isChartSpecV2(chart)) {
      setLocalV1(null);
      setLimit(null);
    } else {
      setLocalV1(chart as ChartSpec);
      setLimit((chart as ChartSpec).limit ?? null);
    }
    setView("chart");
    // chart intentionally excluded — `identity` is the structural-content key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const v2Spec = isChartSpecV2(chart) ? (chart as ChartSpecV2) : null;
  const activeSpec: ChartSpec | ChartSpecV2 = v2Spec ?? (localV1 as ChartSpec);

  // Wave B2 · the interactive "Sort by" control acts on the ACTIVE spec —
  // v1 (`localV1`) OR v2 (`v2Spec`). Pre-B2 it was gated on `!!localV1`, so the
  // v1→v2 convergence silently dropped sort from every chart that rendered as
  // v2. `chartSupportsSort` + `useChartSort` are now v2-aware (Wave B1).
  const sortableSpec = v2Spec ?? localV1;
  const showSortControl =
    !!sortableSpec &&
    controls?.sort !== false &&
    chartSupportsSort(sortableSpec);
  const sortAxisLabel = localV1
    ? localV1.xLabel || localV1.x
    : v2Spec?.encoding.x?.axis?.title || v2Spec?.encoding.x?.field || "";

  const canPivot = useMemo(() => {
    if (!showPivotToggle) return false;
    const spec = isChartSpecV2(chart) ? null : (chart as ChartSpec);
    if (!spec) return false;
    if (chartSpecToPivotConfig(spec) === null) return false;
    return Array.isArray(spec.data) && spec.data.length > 0;
  }, [chart, showPivotToggle]);
  const effectiveView: "chart" | "pivot" = canPivot ? view : "chart";

  // W10 · explicit Maximize button → the rich ChartModal (same modal
  // ChartRenderer opens on header-click; this adds the discoverable trigger the
  // dashboard tile has). v1 only — ChartModal renders a v1 ChartSpec; the v2
  // path keeps ChartRenderer's header-click (no regression).
  const showExpand = controls?.expand !== false && !!localV1;

  const toolbarVisible = useMemo(() => {
    if (canPivot) return true;
    // v2 (or v1) sortable bar → keep the toolbar so the sort control shows even
    // when no v1-only toolbar (mark / layout / labels) applies.
    if (showSortControl) return true;
    if (showExpand) return true;
    if (!localV1) return false;
    const hasMarkSwitch = showChartType && isSwitchableMark(localV1.type);
    // A bar is "stackable" if it has any series concept — explicit seriesKeys OR
    // an inferred series via seriesColumn. Without this, real grouped-bar charts
    // emitted with seriesColumn-only would hide the toggle (Bug E).
    const hasSeries =
      !!localV1.seriesColumn || (localV1.seriesKeys?.length ?? 0) > 1;
    const hasLayoutSwitch = showBarLayout && localV1.type === "bar" && hasSeries;
    const hasDataLabelsSwitch =
      showDataLabelsToggle &&
      ["bar", "line", "area", "scatter", "point"].includes(localV1.type);
    return hasMarkSwitch || hasLayoutSwitch || hasDataLabelsSwitch || showSortControl;
  }, [
    canPivot,
    localV1,
    showSortControl,
    showExpand,
    showChartType,
    showBarLayout,
    showDataLabelsToggle,
  ]);

  const handleMarkChange = (next: SwitchableMark) => {
    setLocalV1((prev) => (prev ? coerceMarkType(prev, next) : prev));
    // W7 · persist so the choice survives a reload (server normalises the
    // bar-only strip identically to coerceMarkType).
    onSpecPersist?.({ type: next });
  };

  const handleBarLayoutChange = (next: "stacked" | "grouped") => {
    setLocalV1((prev) =>
      prev && prev.type === "bar" ? { ...prev, barLayout: next } : prev
    );
    onSpecPersist?.({ barLayout: next });
  };

  // W-GMK9 · per-chart "Show value labels" toggle. Mutates the v1 spec's
  // top-level `dataLabels`; `v1ToV2.ts` propagates that to v2 config so
  // the visx renderers' collision-thinning kicks in (or doesn't).
  const handleDataLabelsChange = (next: boolean) => {
    setLocalV1((prev) => (prev ? { ...prev, dataLabels: next } : prev));
    onSpecPersist?.({ dataLabels: next });
  };

  // Wave S5 · interactive "Sort by" for bar/column charts. The hook re-orders
  // the spec's rows instantly client-side; `onSortPersist` (if given) durably
  // saves the choice. Called unconditionally with a stable fallback so the hook
  // order is constant across v1/v2 renders.
  // Hook input is the ACTIVE spec (v1 or v2); `sortedSpec` comes back the same
  // shape, re-ordered. Called unconditionally with a stable fallback so the
  // hook order is constant across v1/v2 renders.
  const { sortedSpec, sort, setSort } = useChartSort(
    sortableSpec ?? EMPTY_SORT_SPEC,
  );
  const handleSortChange = (next: ChartSortSpec) => {
    setSort(next);
    onSortPersist?.(next);
  };

  // W8 · distinct category count for the active bar breakdown — drives the
  // inline Top/Bottom-N control (> 10) and the "View all N" CTA (> 12), exactly
  // like the dashboard tile. Derived from the (locally-mutated) v1 spec's data.
  const categoryCount = useMemo(() => {
    if (!localV1 || localV1.type !== "bar" || !localV1.x) return 0;
    const xCol = localV1.x;
    const rows = Array.isArray(localV1.data) ? localV1.data : [];
    const seen = new Set<string>();
    for (const r of rows) {
      const v = (r as Record<string, unknown>)[xCol];
      if (v != null && v !== "") seen.add(String(v));
    }
    return seen.size;
  }, [localV1]);
  const showLimitControl = showSortControl && categoryCount > 10;
  const handleLimitChange = (next: ChartLimit) => {
    setLimit(next);
    onSpecPersist?.({ limit: next });
  };

  // Inject the live limit into the spec the CHART renders (so the bars narrow to
  // the selection); the pivot / "View all N" path keeps the limit-free sorted
  // spec so every record stays reachable — same contract as the dashboard tile.
  const renderedSpec = useMemo<ChartSpec | ChartSpecV2>(() => {
    if (!localV1) return sortedSpec;
    return { ...(sortedSpec as ChartSpec), limit: limit ?? undefined };
  }, [sortedSpec, localV1, limit]);

  // When the toggle is in pivot view, the chart-type and bar-layout dropdowns
  // are irrelevant (they only mutate chart-rendering choices). Hide them so
  // the toolbar doesn't lie about what's editable.
  const chartControlsVisible = effectiveView === "chart";
  const showViewAllCta =
    canPivot && effectiveView === "chart" && categoryCount > 12;

  const pivotChart = localV1 ?? (chart as ChartSpec);

  return (
    <div className={className}>
      {toolbarVisible ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {/* W3 · the mark-switch / layout / show-labels cluster now lives in the
              shared <ChartParityToolbar> so the dashboard tile can mount the same
              controls (W4). State stays here (localV1 + coerceMarkType); the
              toolbar is presentation-only and self-gates each control. */}
          {chartControlsVisible && localV1 ? (
            <ChartParityToolbar
              type={localV1.type}
              barLayout={localV1.barLayout}
              dataLabels={localV1.dataLabels}
              hasSeries={
                !!localV1.seriesColumn || (localV1.seriesKeys?.length ?? 0) > 1
              }
              show={{
                chartType: showChartType,
                barLayout: showBarLayout,
                dataLabels: showDataLabelsToggle,
              }}
              onTypeChange={handleMarkChange}
              onBarLayoutChange={handleBarLayoutChange}
              onDataLabelsChange={handleDataLabelsChange}
            />
          ) : null}
          {chartControlsVisible && showSortControl ? (
            <ChartSortControl
              value={sort ?? localV1?.sort}
              onChange={handleSortChange}
              axisLabel={sortAxisLabel}
            />
          ) : null}
          {chartControlsVisible && showLimitControl ? (
            <ChartLimitControl
              value={limit}
              onChange={handleLimitChange}
              total={categoryCount}
            />
          ) : null}
          {canPivot || showExpand ? (
            <div className="ml-auto flex items-center gap-2">
          {canPivot ? (
            <div
              className="inline-flex rounded-md border border-border overflow-hidden"
              role="group"
              aria-label="Chart or pivot view"
              data-testid="chart-pivot-toggle"
            >
              <button
                type="button"
                onClick={() => setView("chart")}
                aria-pressed={effectiveView === "chart"}
                title="View as chart"
                className={cn(
                  "px-1.5 py-1 text-xs transition-colors",
                  effectiveView === "chart"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
                )}
              >
                <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">View as chart</span>
              </button>
              <button
                type="button"
                onClick={() => setView("pivot")}
                aria-pressed={effectiveView === "pivot"}
                title="View as pivot table"
                className={cn(
                  "px-1.5 py-1 text-xs transition-colors border-l border-border",
                  effectiveView === "pivot"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
                )}
              >
                <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">View as pivot table</span>
              </button>
            </div>
          ) : null}
          {showExpand ? (
            <button
              type="button"
              onClick={() => setIsExpandOpen(true)}
              title="Expand chart"
              aria-label="Expand chart"
              data-testid="chart-expand-button"
              className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground hover:bg-muted/40"
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* W-GMK9 · axisReason subtitle — surfaces the period-resolver's
          decision (e.g. "Showing Quarter · Period (filtered to PeriodKind
          = Quarter, sorted chronologically)") so the user knows which
          time grain was picked and why. Absent for non-period charts. */}
      {localV1?.axisReason ? (
        <div
          className="mb-2 text-[11px] leading-snug text-muted-foreground"
          data-testid="chart-axis-reason"
        >
          {localV1.axisReason}
        </div>
      ) : null}
      {effectiveView === "pivot" ? (
        <div className="h-[360px] w-full" data-testid="chart-pivot-body">
          <ChartTilePivotView chart={pivotChart} />
        </div>
      ) : (
        <ChartShim
          spec={renderedSpec}
          keyInsightSessionId={keyInsightSessionId}
          legacy={() => renderLegacy(localV1 ? (renderedSpec as ChartSpec) : (chart as ChartSpec))}
        />
      )}
      {/* W8 · honest "Top/Bottom N of M" caption when a limit is hiding rows. */}
      {effectiveView === "chart" && limit && categoryCount > limit.n ? (
        <div className="mt-1 text-xs text-muted-foreground">
          {limit.mode === "top" ? "Top" : "Bottom"} {limit.n} of {categoryCount}
        </div>
      ) : null}
      {/* W8 · "View all N" escape hatch into the full sortable pivot table —
          parity with the dashboard tile. Sort ascending for worst performers. */}
      {showViewAllCta ? (
        <button
          type="button"
          onClick={() => setView("pivot")}
          className="mt-1 self-start text-xs text-primary hover:underline"
          title="Open the full sortable table — sort ascending to see the worst performers"
        >
          View all {categoryCount} {localV1?.x} as a sortable table →
        </button>
      ) : null}
      {/* W10 · explicit Maximize → rich ChartModal (lazy). v1 only; renders the
          locally-mutated spec so the modal opens in sync with the inline card. */}
      {isExpandOpen && localV1 ? (
        <Suspense fallback={null}>
          <ChartModal
            isOpen={isExpandOpen}
            onClose={() => setIsExpandOpen(false)}
            chart={renderedSpec as ChartSpec}
            keyInsightSessionId={keyInsightSessionId}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

export const __test__ = { coerceMarkType, chartIdentityKey, canShowPivotToggle };
