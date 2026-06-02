/**
 * Wave-FA · Live data-preview pane shown beside the Filter Data panel.
 *
 * Renders the filter-aware working dataset — the exact rows the agent answers
 * from — as a virtualized grid that updates as the user edits filters on the
 * right. Two depths, chosen by a toggle:
 *   - "200 rows" (default): the `previewRows` already returned by every
 *     active-filter response (live, free).
 *   - "Entire dataset": `fullRows`, fetched on demand (see `useFilteredFullRows`),
 *     bounded by the server cap.
 *
 * Cell rendering mirrors the dataset-variant preview in `DataPreviewTable`
 * (null → italic "null", date columns → grain-formatted, everything else raw)
 * so the two views agree. Sorting reuses `usePreviewTableSort`.
 *
 * Rows are virtualized (`@tanstack/react-virtual`) so the "entire dataset" mode
 * stays responsive for large filtered sets. Header and body share one
 * `gridTemplateColumns` template, guaranteeing column alignment despite the
 * sticky header living in a separate stacking context from the virtual rows.
 */
import { useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { usePreviewTableSort } from "@/hooks/usePreviewTableSort";
import { inferTemporalGrainFromSample } from "@/lib/temporalDisplayFormat";
import {
  buildPreviewCaption,
  estimateColumnWidth,
  resolvePreviewCellText,
  type PreviewMode,
} from "@/lib/datasetPreviewModel";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { TemporalDisplayGrain } from "@/shared/schema";

export type { PreviewMode };

export interface DatasetPreviewPaneProps {
  /** First-N filter-aware rows from the active-filter response (200 mode). */
  previewRows: Record<string, unknown>[];
  /** Full filter-aware rows, fetched on demand (entire-dataset mode). */
  fullRows: Record<string, unknown>[];
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  /** True while the full-mode fetch is in flight. */
  loadingFull?: boolean;
  /** True when the full set was capped at the server limit. */
  truncated?: boolean;
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  temporalDisplayGrainsByColumn?: Record<string, TemporalDisplayGrain>;
  /** Total rows surviving the filter (preview is the first N of these). */
  filteredRows: number;
  /** A filter PUT is in flight upstream — surface a subtle "Updating…". */
  saving?: boolean;
}

const ROW_HEIGHT = 37; // px-3 py-2 text-sm + 1px border
/** Human label for the server preview cap (keep in sync with FULL_PREVIEW_CAP). */
const FULL_CAP_LABEL = "50,000";

export function DatasetPreviewPane({
  previewRows,
  fullRows,
  mode,
  onModeChange,
  loadingFull,
  truncated,
  columns,
  numericColumns,
  dateColumns,
  temporalDisplayGrainsByColumn = {},
  filteredRows,
  saving,
}: DatasetPreviewPaneProps) {
  const rows = mode === "full" ? fullRows : previewRows;

  const { sortedData, handleSort, getSortIcon } = usePreviewTableSort({
    data: rows,
    columns,
    numericColumns,
    dateColumns,
    variant: "dataset",
  });

  // Resolve a display grain per date column (prop wins, else inferred).
  const grainsByColumn = useMemo(() => {
    const out: Record<string, TemporalDisplayGrain> = {
      ...temporalDisplayGrainsByColumn,
    };
    for (const col of dateColumns) {
      if (!out[col]) {
        out[col] = inferTemporalGrainFromSample(
          rows.slice(0, 500).map((r) => r[col])
        );
      }
    }
    return out;
  }, [rows, dateColumns, temporalDisplayGrainsByColumn]);

  // Shared column template — header and every body row use the same widths so
  // they stay aligned across the separate stacking contexts.
  const colWidths = useMemo(
    () => columns.map((c) => estimateColumnWidth(c, rows)),
    [columns, rows]
  );
  const gridTemplateColumns = useMemo(
    () => colWidths.map((w) => `${w}px`).join(" "),
    [colWidths]
  );
  const totalWidth = useMemo(
    () => colWidths.reduce((a, b) => a + b, 0),
    [colWidths]
  );

  const dateSet = useMemo(() => new Set(dateColumns), [dateColumns]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: sortedData.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const renderCell = (col: string, raw: unknown): ReactNode => {
    const text = resolvePreviewCellText(raw, dateSet.has(col), grainsByColumn[col]);
    return text === null ? (
      <span className="italic text-muted-foreground">null</span>
    ) : (
      text
    );
  };

  const updating = Boolean(saving || loadingFull);

  const caption = buildPreviewCaption({
    mode,
    shown: sortedData.length,
    filteredRows,
    truncated,
    capLabel: FULL_CAP_LABEL,
  });

  const hasColumns = columns.length > 0;
  const hasRows = sortedData.length > 0;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="dataset-preview-pane">
      <div className="flex items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Data preview</h2>
          {updating && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Updating…
            </span>
          )}
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          value={mode}
          onValueChange={(v) => {
            if (v === "200" || v === "full") onModeChange(v);
          }}
          aria-label="Preview row count"
        >
          <ToggleGroupItem value="200" className="h-7 px-2.5 text-xs">
            200 rows
          </ToggleGroupItem>
          <ToggleGroupItem value="full" className="h-7 px-2.5 text-xs">
            Entire dataset
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {!hasColumns || !hasRows ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          {!hasColumns
            ? "No columns to preview."
            : "No rows match the current filters."}
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ width: totalWidth, minWidth: "100%" }}>
            {/* Sticky header — shares the column template with body rows. */}
            <div
              className="sticky top-0 z-10 grid border-b border-border bg-muted/60 backdrop-blur-sm"
              style={{ gridTemplateColumns }}
            >
              {columns.map((col) => (
                <button
                  key={col}
                  type="button"
                  onClick={() => handleSort(col)}
                  title={col}
                  className="flex w-full items-center overflow-hidden whitespace-nowrap px-3 py-2 text-left text-sm font-semibold text-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                >
                  <span className="min-w-0 truncate">{col}</span>
                  <span className="shrink-0">{getSortIcon(col)}</span>
                </button>
              ))}
            </div>

            {/* Virtualized body. */}
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const row = sortedData[vi.index];
                return (
                  <div
                    key={vi.key}
                    className="absolute left-0 grid border-b border-border/60 hover:bg-muted/30"
                    style={{
                      top: 0,
                      transform: `translateY(${vi.start}px)`,
                      height: ROW_HEIGHT,
                      width: "100%",
                      gridTemplateColumns,
                    }}
                  >
                    {columns.map((col) => {
                      const raw = row?.[col];
                      return (
                        <div
                          key={col}
                          title={
                            raw === null || raw === undefined
                              ? undefined
                              : String(raw)
                          }
                          className="overflow-hidden whitespace-nowrap px-3 py-2 text-sm text-foreground"
                        >
                          <span className="block truncate">
                            {renderCell(col, raw)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="border-t border-border/80 bg-card px-4 py-2 text-xs text-muted-foreground">
        {hasColumns ? caption : ""}
      </div>
    </div>
  );
}
