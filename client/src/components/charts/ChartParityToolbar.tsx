/**
 * ChartParityToolbar — the small, shared, presentational cluster of chart
 * controls that BOTH surfaces mount so a chart exposes the same affordances
 * wherever it appears:
 *   • mark switch (bar | line | area)
 *   • stacked / grouped layout toggle (bar + series only)
 *   • "Show labels" checkbox (bar / line / area / scatter / point)
 *
 * Consumers:
 *   - chat:      InteractiveChartCard (mounts it above <ChartShim>)
 *   - dashboard: ChartTileBody (mounts it in the TileHeader actions slot)
 *
 * Presentation ONLY — it owns no spec state. Each surface keeps its own local
 * spec copy + persistence wiring (chat → sessionsApi.updateMessageChartSpec;
 * dashboard → the dashboards charts PATCH) and feeds `value` + `onChange` here.
 * The three controls self-gate on the active mark, so a caller can mount the
 * component unconditionally; it renders nothing when no control applies.
 *
 * This is NOT the (deliberately out-of-scope) render-core unification: it is a
 * thin cluster of <select>/checkbox JSX that emits callbacks and never renders
 * a chart. The mark-switch STATE machine (localV1 copy, coerceMarkType,
 * chartIdentityKey reset) stays in each wrapper.
 */
import { useId } from "react";
import {
  isSwitchableMark,
  type SwitchableMark,
} from "@/lib/charts/chartSpecMutations";

// Re-exported so existing `import { isSwitchableMark } from "./ChartParityToolbar"`
// call-sites keep working; the canonical home is chartSpecMutations.
export { isSwitchableMark };

/** Marks for which the "Show labels" toggle is meaningful. */
const DATA_LABEL_MARKS = ["bar", "line", "area", "scatter", "point"];

export interface ChartParityToolbarProps {
  /** The active mark; drives which controls self-show. */
  type: string;
  barLayout?: "stacked" | "grouped";
  /** undefined → treated as true (labels default on, matching v1ToV2). */
  dataLabels?: boolean;
  /** Whether the chart has a series dimension (enables the layout toggle). */
  hasSeries: boolean;
  /** Per-control visibility overrides (a caller may already supply one externally). */
  show?: { chartType?: boolean; barLayout?: boolean; dataLabels?: boolean };
  onTypeChange: (next: SwitchableMark) => void;
  onBarLayoutChange: (next: "stacked" | "grouped") => void;
  onDataLabelsChange: (next: boolean) => void;
}

export function ChartParityToolbar({
  type,
  barLayout,
  dataLabels,
  hasSeries,
  show,
  onTypeChange,
  onBarLayoutChange,
  onDataLabelsChange,
}: ChartParityToolbarProps) {
  // useId guarantees label/select pairing stays correct when several charts
  // render side-by-side (the original Bug F in InteractiveChartCard).
  const reactId = useId();
  const chartTypeId = `cpt-chart-type-${reactId}`;
  const barLayoutId = `cpt-bar-layout-${reactId}`;
  const dataLabelsId = `cpt-data-labels-${reactId}`;

  const showChartType = show?.chartType !== false && isSwitchableMark(type);
  const showBarLayout = show?.barLayout !== false && type === "bar" && hasSeries;
  const showDataLabels =
    show?.dataLabels !== false && DATA_LABEL_MARKS.includes(type);
  const currentDataLabels = dataLabels !== false; // default true

  if (!showChartType && !showBarLayout && !showDataLabels) return null;

  return (
    <>
      {showChartType ? (
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
            value={type}
            onChange={(e) => onTypeChange(e.target.value as SwitchableMark)}
          >
            <option value="bar">Bar</option>
            <option value="line">Line</option>
            <option value="area">Area</option>
          </select>
        </div>
      ) : null}
      {showBarLayout ? (
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
            value={barLayout ?? "stacked"}
            onChange={(e) =>
              onBarLayoutChange(e.target.value as "stacked" | "grouped")
            }
          >
            <option value="stacked">Stacked</option>
            <option value="grouped">Grouped</option>
          </select>
        </div>
      ) : null}
      {showDataLabels ? (
        <div className="flex items-center gap-1.5">
          <input
            id={dataLabelsId}
            type="checkbox"
            checked={currentDataLabels}
            onChange={(e) => onDataLabelsChange(e.target.checked)}
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
    </>
  );
}
