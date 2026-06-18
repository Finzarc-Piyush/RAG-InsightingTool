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
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { BarChart3, Table2 } from "lucide-react";
import { isChartSpecV2, type ChartSpec, type ChartSpecV2 } from "@/shared/schema";
import { cn } from "@/lib/utils";
import { ChartShim } from "./ChartShim";
import { ChartTilePivotView } from "./ChartTilePivotView";
import { chartSpecToPivotConfig } from "./chartSpecToPivotConfig";
import { ChartSortControl } from "./ChartSortControl";
import {
  useChartSort,
  chartSupportsSort,
  type ChartSortSpec,
} from "@/lib/charts/useChartSort";

// Stable fallback so the useChartSort hook can be called unconditionally even
// when there is no v1 spec to sort (v2 marks). Module-level → stable identity.
const EMPTY_SORT_SPEC: ChartSpec = { type: "bar", title: "", x: "", y: "", data: [] };

type SwitchableMark = "bar" | "line" | "area";
const SWITCHABLE_MARKS: readonly SwitchableMark[] = ["bar", "line", "area"];

function isSwitchableMark(t: string): t is SwitchableMark {
  return (SWITCHABLE_MARKS as readonly string[]).includes(t);
}

function coerceMarkType(spec: ChartSpec, next: SwitchableMark): ChartSpec {
  if (spec.type === next) return spec;
  const out: ChartSpec = { ...spec, type: next };
  if (next !== "bar") {
    delete out.barLayout;
    // The "Sort by" control is bar/column-only; carrying a value-sort onto a
    // line/area would draw its points out of natural (e.g. chronological)
    // order, and the user can't see/undo it (control hidden for lines). Strip
    // it on leaving bar, mirroring barLayout.
    delete out.sort;
  }
  return out;
}

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
}

export function InteractiveChartCard({
  chart,
  keyInsightSessionId,
  controls,
  renderLegacy,
  className,
  onSortPersist,
}: InteractiveChartCardProps) {
  const showChartType = controls?.chartType !== false;
  const showBarLayout = controls?.barLayout !== false;
  const showPivotToggle = controls?.pivotToggle !== false;
  const showDataLabelsToggle = controls?.dataLabels !== false;

  // useId guarantees label/select pairing stays correct when a chat message
  // renders multiple charts side-by-side (Bug F).
  const reactId = useId();
  const chartTypeId = `ic-chart-type-${reactId}`;
  const barLayoutId = `ic-bar-layout-${reactId}`;
  const dataLabelsId = `ic-data-labels-${reactId}`;

  const [localV1, setLocalV1] = useState<ChartSpec | null>(() =>
    isChartSpecV2(chart) ? null : (chart as ChartSpec)
  );
  const [view, setView] = useState<"chart" | "pivot">("chart");

  // Reset only when the chart's STRUCTURAL identity changes — not on every
  // parent re-render that hands back a new object reference for the same
  // spec. Otherwise toolbar state would be wiped on streaming-driven re-renders.
  const identity = useMemo(() => chartIdentityKey(chart), [chart]);
  useEffect(() => {
    if (isChartSpecV2(chart)) {
      setLocalV1(null);
    } else {
      setLocalV1(chart as ChartSpec);
    }
    setView("chart");
    // chart intentionally excluded — `identity` is the structural-content key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  const v2Spec = isChartSpecV2(chart) ? (chart as ChartSpecV2) : null;
  const activeSpec: ChartSpec | ChartSpecV2 = v2Spec ?? (localV1 as ChartSpec);

  const canPivot = useMemo(() => {
    if (!showPivotToggle) return false;
    const spec = isChartSpecV2(chart) ? null : (chart as ChartSpec);
    if (!spec) return false;
    if (chartSpecToPivotConfig(spec) === null) return false;
    return Array.isArray(spec.data) && spec.data.length > 0;
  }, [chart, showPivotToggle]);
  const effectiveView: "chart" | "pivot" = canPivot ? view : "chart";

  const toolbarVisible = useMemo(() => {
    if (canPivot) return true;
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
    const hasSortControl =
      controls?.sort !== false && chartSupportsSort(localV1);
    return hasMarkSwitch || hasLayoutSwitch || hasDataLabelsSwitch || hasSortControl;
  }, [canPivot, localV1, showChartType, showBarLayout, showDataLabelsToggle, controls?.sort]);

  const handleMarkChange = (next: SwitchableMark) => {
    setLocalV1((prev) => (prev ? coerceMarkType(prev, next) : prev));
  };

  const handleBarLayoutChange = (next: "stacked" | "grouped") => {
    setLocalV1((prev) =>
      prev && prev.type === "bar" ? { ...prev, barLayout: next } : prev
    );
  };

  // W-GMK9 · per-chart "Show value labels" toggle. Mutates the v1 spec's
  // top-level `dataLabels`; `v1ToV2.ts` propagates that to v2 config so
  // the visx renderers' collision-thinning kicks in (or doesn't).
  const handleDataLabelsChange = (next: boolean) => {
    setLocalV1((prev) => (prev ? { ...prev, dataLabels: next } : prev));
  };
  const currentDataLabels = localV1?.dataLabels !== false; // default true

  // Wave S5 · interactive "Sort by" for bar/column charts. The hook re-orders
  // the spec's rows instantly client-side; `onSortPersist` (if given) durably
  // saves the choice. Called unconditionally with a stable fallback so the hook
  // order is constant across v1/v2 renders.
  const { sortedSpec, sort, setSort } = useChartSort(localV1 ?? EMPTY_SORT_SPEC);
  const showSortControl =
    !!localV1 && controls?.sort !== false && chartSupportsSort(localV1);
  const handleSortChange = (next: ChartSortSpec) => {
    setSort(next);
    onSortPersist?.(next);
  };

  // When the toggle is in pivot view, the chart-type and bar-layout dropdowns
  // are irrelevant (they only mutate chart-rendering choices). Hide them so
  // the toolbar doesn't lie about what's editable.
  const chartControlsVisible = effectiveView === "chart";

  const pivotChart = localV1 ?? (chart as ChartSpec);

  return (
    <div className={className}>
      {toolbarVisible ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {chartControlsVisible && localV1 && showChartType && isSwitchableMark(localV1.type) ? (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={chartTypeId}
                className="text-[11px] uppercase tracking-wide text-muted-foreground"
              >
                Type
              </label>
              <select
                id={chartTypeId}
                className="rounded border border-border/60 bg-background px-2 py-1 text-xs"
                value={localV1.type}
                onChange={(e) => handleMarkChange(e.target.value as SwitchableMark)}
              >
                <option value="bar">Bar</option>
                <option value="line">Line</option>
                <option value="area">Area</option>
              </select>
            </div>
          ) : null}
          {chartControlsVisible &&
          localV1 &&
          showBarLayout &&
          localV1.type === "bar" &&
          (!!localV1.seriesColumn || (localV1.seriesKeys?.length ?? 0) > 1) ? (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor={barLayoutId}
                className="text-[11px] uppercase tracking-wide text-muted-foreground"
              >
                Layout
              </label>
              <select
                id={barLayoutId}
                className="rounded border border-border/60 bg-background px-2 py-1 text-xs"
                value={localV1.barLayout ?? "stacked"}
                onChange={(e) =>
                  handleBarLayoutChange(e.target.value as "stacked" | "grouped")
                }
              >
                <option value="stacked">Stacked</option>
                <option value="grouped">Grouped</option>
              </select>
            </div>
          ) : null}
          {chartControlsVisible &&
          localV1 &&
          showDataLabelsToggle &&
          ["bar", "line", "area", "scatter", "point"].includes(localV1.type) ? (
            <div className="flex items-center gap-1.5">
              <input
                id={dataLabelsId}
                type="checkbox"
                checked={currentDataLabels}
                onChange={(e) => handleDataLabelsChange(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border/60 bg-background"
              />
              <label
                htmlFor={dataLabelsId}
                className="text-[11px] uppercase tracking-wide text-muted-foreground"
              >
                Show labels
              </label>
            </div>
          ) : null}
          {chartControlsVisible && localV1 && showSortControl ? (
            <ChartSortControl
              value={sort ?? localV1.sort}
              onChange={handleSortChange}
              axisLabel={localV1.xLabel || localV1.x}
            />
          ) : null}
          {canPivot ? (
            <div
              className="ml-auto inline-flex rounded-md border border-border overflow-hidden"
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
          spec={localV1 ? sortedSpec : activeSpec}
          keyInsightSessionId={keyInsightSessionId}
          legacy={() => renderLegacy(localV1 ? sortedSpec : (chart as ChartSpec))}
        />
      )}
    </div>
  );
}

export const __test__ = { coerceMarkType, chartIdentityKey, canShowPivotToggle };
