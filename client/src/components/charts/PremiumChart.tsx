/**
 * PremiumChart — façade dispatcher for v2 chart specs.
 *
 * Receives a ChartSpecV2 + the raw rows (resolved upstream by
 * <RawDataProvider> in WC2.1) and dispatches to the appropriate
 * renderer family:
 *   - visx renderers (primary, sync) — bar, line, area, point, ...
 *   - echarts renderers (lazy specialty, future) — treemap, sankey, ...
 *
 * Wraps the renderer in an ErrorBoundary + state shell so loading,
 * empty, and error cases all use the shared <ChartSkeleton>,
 * <ChartEmpty>, <ChartError> components (WC1.6).
 */

import { Component, type ReactNode } from "react";
import { ParentSize } from "@visx/responsive";
import { ECHARTS_MARKS } from "@/lib/charts/featureFlags";
import type { ChartSpecV2 } from "@/shared/schema";
import type { Row } from "@/lib/charts/encodingResolver";
import { BarRenderer } from "@/lib/charts/visxRenderers/BarRenderer";
import { LineRenderer } from "@/lib/charts/visxRenderers/LineRenderer";
import { AreaRenderer } from "@/lib/charts/visxRenderers/AreaRenderer";
import { PointRenderer } from "@/lib/charts/visxRenderers/PointRenderer";
import { ArcRenderer } from "@/lib/charts/visxRenderers/ArcRenderer";
import { RectRenderer } from "@/lib/charts/visxRenderers/RectRenderer";
import { ComboRenderer } from "@/lib/charts/visxRenderers/ComboRenderer";
import { WaterfallRenderer } from "@/lib/charts/visxRenderers/WaterfallRenderer";
import { FunnelRenderer } from "@/lib/charts/visxRenderers/FunnelRenderer";
import { RadarRenderer } from "@/lib/charts/visxRenderers/RadarRenderer";
import { BoxRenderer } from "@/lib/charts/visxRenderers/BoxRenderer";
import { RegressionRenderer } from "@/lib/charts/visxRenderers/RegressionRenderer";
import { KpiRenderer } from "@/lib/charts/visxRenderers/KpiRenderer";
import { TreemapRenderer } from "@/lib/charts/echartsRenderers/TreemapRenderer";
import {
  SunburstRenderer,
  SankeyRenderer,
  ParallelRenderer,
  CalendarRenderer,
  CandlestickRenderer,
  ChoroplethRenderer,
  GaugeRenderer,
} from "@/lib/charts/echartsRenderers/SpecialtyRenderers";
import {
  ChartEmpty,
  ChartError,
  ChartSkeleton,
} from "@/components/charts/ChartStates";
import { FacetGrid, type FacetCell } from "@/components/charts/FacetGrid";
import { useChartGrid } from "@/components/charts/ChartGrid";
import { asString } from "@/lib/charts/encodingResolver";
import { chartA11ySummary } from "@/lib/charts/a11ySummary";

export interface PremiumChartProps {
  spec: ChartSpecV2;
  /** Resolved rows. Future waves: derive from <RawDataProvider> when source.kind === 'session-ref'. */
  data: Row[];
  /** Fixed height. Width is responsive via ParentSize. */
  height?: number;
  /** Override the aria-label. Defaults to spec.config.title.text. */
  ariaLabel?: string;
  /** External loading signal. Overrides spec.config.loadingState. */
  isLoading?: boolean;
  /** Optional progress info for the skeleton state. */
  loadingProgress?: { processed: number; total: number; message?: string };
  /** Optional retry callback rendered in the error state. */
  onRetry?: () => void;
  /**
   * Forwarded through ChartShim from MessageBubble. Lets future "Expand
   * to modal" callers fetch a Key Insight on demand for the active
   * session. Currently passive — the v2 expand modal isn't wired yet,
   * but the prop is preserved so flag flips don't lose the Key Insight
   * feature available on the legacy renderer (Fix-4).
   */
  keyInsightSessionId?: string | null;
}

type VisxRendererProps = {
  spec: ChartSpecV2;
  data: Row[];
  width: number;
  height: number;
  ariaLabel?: string;
};

const VISX_RENDERERS: Partial<
  Record<ChartSpecV2["mark"], (p: VisxRendererProps) => JSX.Element | null>
> = {
  // Visx primary
  bar: BarRenderer,
  line: LineRenderer,
  area: AreaRenderer,
  point: PointRenderer,
  arc: ArcRenderer,
  rect: RectRenderer,
  combo: ComboRenderer,
  waterfall: WaterfallRenderer,
  funnel: FunnelRenderer,
  radar: RadarRenderer,
  box: BoxRenderer,
  regression: RegressionRenderer,
  kpi: KpiRenderer,
  // ECharts (lazy specialty)
  treemap: TreemapRenderer,
  sunburst: SunburstRenderer,
  sankey: SankeyRenderer,
  parallel: ParallelRenderer,
  calendar: CalendarRenderer,
  candlestick: CandlestickRenderer,
  choropleth: ChoroplethRenderer,
  gauge: GaugeRenderer,
};

function UnsupportedMark({ mark }: { mark: ChartSpecV2["mark"] }) {
  const isLazy = ECHARTS_MARKS.has(mark);
  return (
    <div
      className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-border/80 bg-muted/20 p-4 text-xs text-muted-foreground"
      role="img"
      aria-label={`Unsupported mark: ${mark}`}
    >
      <div className="text-center">
        <div className="font-medium text-foreground/70">
          Mark "{mark}" not yet implemented
        </div>
        <div className="mt-1 opacity-70">
          {isLazy
            ? "ECharts specialty bundle pending (Phase 3)."
            : "Visx renderer pending."}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-chart error boundary. Renders <ChartError> if the renderer throws
 * (most commonly because encoding resolution fails — e.g. y is not
 * quantitative). Confined here so a bad spec in one chart card doesn't
 * crash a multi-chart panel.
 */
class ChartErrorBoundary extends Component<
  { height: number; onRetry?: () => void; children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    if (typeof console !== "undefined" && console.error) {
      console.error("PremiumChart render error:", error);
    }
  }
  render() {
    if (this.state.error) {
      return (
        <ChartError
          height={this.props.height}
          error={this.state.error}
          onRetry={
            this.props.onRetry
              ? () => {
                  this.setState({ error: null });
                  this.props.onRetry?.();
                }
              : () => this.setState({ error: null })
          }
        />
      );
    }
    return this.props.children;
  }
}

export function PremiumChart({
  spec,
  data,
  height = 280,
  ariaLabel,
  isLoading,
  loadingProgress,
  onRetry,
}: PremiumChartProps) {
  // Loading state — explicit prop wins; otherwise read from spec.
  const loading =
    isLoading ??
    (spec.config?.loadingState === "computing" ||
      spec.config?.loadingState === "sampling");
  if (loading) {
    return <ChartSkeleton height={height} progress={loadingProgress} />;
  }

  // Apply cross-filter from any surrounding <ChartGrid>.
  const grid = useChartGrid();
  const filteredData = grid.applyFilter(data ?? []);

  // Empty state.
  if (!filteredData || filteredData.length === 0) {
    return <ChartEmpty height={height} />;
  }
  // Reassign for downstream code paths.
  data = filteredData;

  // Faceting (small multiples). When facetCol or facetRow is set, partition
  // the data and render one inner PremiumChart per group inside a grid.
  // Inner specs strip the facet encodings to avoid recursion.
  const facetCol = spec.encoding.facetCol;
  const facetRow = spec.encoding.facetRow;
  if (facetCol || facetRow) {
    const partitionKey = (r: Row): { col?: string; row?: string } => ({
      col: facetCol ? asString(r[facetCol.field]) : undefined,
      row: facetRow ? asString(r[facetRow.field]) : undefined,
    });
    const partitions = new Map<string, Row[]>();
    const labelMap = new Map<string, { col?: string; row?: string }>();
    for (const r of data) {
      const k = partitionKey(r);
      const composite = `${k.col ?? ""}|${k.row ?? ""}`;
      const arr = partitions.get(composite) ?? [];
      arr.push(r);
      partitions.set(composite, arr);
      labelMap.set(composite, k);
    }

    const innerSpec: ChartSpecV2 = {
      ...spec,
      encoding: {
        ...spec.encoding,
        facetCol: undefined,
        facetRow: undefined,
      },
    };

    const facetCount = partitions.size;
    const wrapCols =
      facetCol?.columns ??
      (facetRow ? Array.from(new Set(Array.from(labelMap.values()).map((l) => l.col))).length || 1 : Math.min(4, facetCount));

    const cellHeight = Math.max(120, Math.floor(height / Math.ceil(facetCount / Math.max(1, wrapCols))));

    const cells: FacetCell[] = Array.from(partitions.entries()).map(
      ([composite, rows]) => {
        const labels = labelMap.get(composite) ?? {};
        return {
          key: composite,
          colLabel: labels.col,
          rowLabel: labels.row,
          content: (
            <PremiumChart
              spec={innerSpec}
              data={rows}
              height={cellHeight - 24}
              ariaLabel={
                [labels.col, labels.row].filter(Boolean).join(" · ") ||
                ariaLabel
              }
              onRetry={onRetry}
            />
          ),
        };
      },
    );

    return (
      <ChartErrorBoundary height={height} onRetry={onRetry}>
        <div className="chart-fade-in w-full overflow-x-auto">
          <FacetGrid
            cells={cells}
            columns={wrapCols}
            cellWidth={Math.max(180, Math.floor(800 / Math.max(1, wrapCols)))}
            cellHeight={cellHeight}
          />
        </div>
      </ChartErrorBoundary>
    );
  }

  // Unsupported mark.
  const Renderer = VISX_RENDERERS[spec.mark];
  if (!Renderer) {
    return (
      <div style={{ height }}>
        <UnsupportedMark mark={spec.mark} />
      </div>
    );
  }

  // WC8.3 — auto-generated screen-reader summary. Live region so AT
  // re-announces when the data shape changes.
  const a11yDescription =
    spec.config?.accessibility?.description ?? chartA11ySummary(spec, data);

  return (
    <ChartErrorBoundary height={height} onRetry={onRetry}>
      <div className="chart-fade-in w-full" style={{ height }}>
        <span className="sr-only" role="status" aria-live="polite">
          {a11yDescription}
        </span>
        <ParentSize>
          {({ width }: { width: number }) =>
            width > 0 ? (
              <Renderer
                spec={spec}
                data={data}
                width={width}
                height={height}
                ariaLabel={ariaLabel ?? a11yDescription}
              />
            ) : null
          }
        </ParentSize>
      </div>
    </ChartErrorBoundary>
  );
}
