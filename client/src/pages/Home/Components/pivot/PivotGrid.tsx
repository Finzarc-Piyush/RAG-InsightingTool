import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatAnalysisNumber } from '@/lib/formatAnalysisNumber';
import type { FilterSelections, PivotFlatRow, PivotModel, PivotUiConfig } from '@/lib/pivot/types';
import type { TemporalFacetColumnMeta } from '@/shared/schema';
import { facetColumnHeaderLabelForColumn } from '@/lib/temporalFacetDisplay';
import { PivotHeaderSliceFilter } from './PivotHeaderSliceFilter';

function fieldLabel(
  field: string,
  temporalFacetColumns: TemporalFacetColumnMeta[] | undefined
): string {
  return facetColumnHeaderLabelForColumn(field, temporalFacetColumns ?? []);
}

function formatCell(n: number): string {
  return formatAnalysisNumber(n);
}

export type PivotShowValuesAsMode = "raw" | "percentOfColumnTotal";

export type PivotGridProps = {
  model: PivotModel;
  flatRows: PivotFlatRow[];
  onToggleCollapse: (pathKey: string) => void;
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  rowSort?: PivotUiConfig["rowSort"];
  onRowSortChange?: (byValueSpecId: string) => void;
  /** Toggle chronological / reverse-chronological row label ordering. */
  onRowLabelSortChange?: () => void;
  showValuesAs?: PivotShowValuesAsMode;
  onDrillthroughCell?: (params: {
    rowPathKey: string;
    colKey: string | null;
    valueSpecId: string;
  }) => void;
  /** Embedded: fixed max height in card. Expanded: fill flex parent (use with flex column + min-h-0). */
  layout?: 'embedded' | 'expanded';
  /** Optional header filters for row/column dimensions (same selection map as pivot Filters zone). */
  sliceFilter?: {
    sessionId: string | null;
    rowField: string | null;
    colField: string | null;
    filterSelections: FilterSelections;
    onSliceChange: (field: string, next: Set<string>) => void;
  };
  /** Remove one column key from the column dimension slice (hide matrix column). */
  onHideColumnMember?: (colField: string, memberKey: string) => void;
};

export function PivotGrid({
  model,
  flatRows,
  onToggleCollapse,
  temporalFacetColumns = [],
  rowSort,
  onRowSortChange,
  onRowLabelSortChange,
  showValuesAs = "raw",
  onDrillthroughCell,
  layout = 'embedded',
  sliceFilter,
  onHideColumnMember,
}: PivotGridProps) {
  const { colField, colKeys, valueSpecs, columnFieldTruncated } = model;
  const hasMatrix = Boolean(colField && colKeys.length > 0);
  const matrixColumnsEmpty = Boolean(colField && colKeys.length === 0);

  const sortIconForRowLabel = (): string => {
    if (!rowSort || rowSort.primary !== 'rowLabel') return '↕';
    return rowSort.direction === 'desc' ? '↓' : '↑';
  };

  const sortIconFor = (specId: string): string => {
    if (rowSort?.primary === 'rowLabel') return '↕';
    if (!rowSort || rowSort.byValueSpecId !== specId) return '↕';
    return rowSort.direction === 'desc' ? '↓' : '↑';
  };

  const handleSortClick = (specId: string) => {
    onRowSortChange?.(specId);
  };

  const valueHeader = (spec: (typeof valueSpecs)[0]) =>
    `${fieldLabel(spec.field, temporalFacetColumns)} (${spec.agg})`;
  const grandTotalForCell = (ck: string | null, specId: string): number => {
    if (!hasMatrix || !ck) {
      return model.tree.grandTotal.flatValues?.[specId] ?? 0;
    }
    return model.tree.grandTotal.matrixValues?.[ck]?.[specId] ?? 0;
  };

  const displayValue = (raw: number, ck: string | null, specId: string): string => {
    if (showValuesAs === "raw") return formatCell(raw);
    if (showValuesAs === "percentOfColumnTotal") {
      const denom = grandTotalForCell(ck, specId);
      const pct = denom ? (raw / denom) * 100 : 0;
      return `${formatCell(pct)}%`;
    }
    return formatCell(raw);
  };

  if (matrixColumnsEmpty) {
    return (
      <div className="rounded-lg border border-dashed border-amber-200/80 bg-amber-50/40 px-4 py-8 text-center text-sm text-muted-foreground">
        No rows match the current filters, so the column breakdown is empty. Adjust filters
        or move fields out of <strong>Columns</strong>.
      </div>
    );
  }

  const shellClass =
    layout === 'expanded'
      ? 'overflow-x-auto overflow-y-auto flex-1 min-h-0 max-h-full border border-gray-200/90 rounded-lg bg-white/60 shadow-inner'
      : 'overflow-x-auto max-h-[500px] overflow-y-auto border border-gray-200/90 rounded-lg bg-white/60 shadow-inner';

  return (
    <div className={shellClass}>
      {columnFieldTruncated && model.columnFields[0] && (
        <p className="text-[11px] text-muted-foreground px-3 py-1.5 border-b border-gray-100 bg-amber-50/50">
          Multiple column fields: using the first (
          {fieldLabel(model.columnFields[0], temporalFacetColumns)}) for the matrix.
        </p>
      )}
      <table className="w-max min-w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-gradient-to-b from-slate-50 to-slate-50/95 backdrop-blur-sm">
          {hasMatrix ? (
            <>
              <tr className="border-b border-gray-200">
                <th
                  rowSpan={valueSpecs.length > 1 ? 2 : 1}
                  className="px-3 py-2.5 text-left font-semibold text-gray-800 whitespace-nowrap align-bottom min-w-[10rem]"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>Row labels</span>
                    {sliceFilter?.rowField ? (
                      <PivotHeaderSliceFilter
                        field={sliceFilter.rowField}
                        ariaLabel={`Filter ${fieldLabel(sliceFilter.rowField, temporalFacetColumns)}`}
                        sessionId={sliceFilter.sessionId}
                        filterSelections={sliceFilter.filterSelections}
                        onSliceChange={sliceFilter.onSliceChange}
                      />
                    ) : null}
                    {hasMatrix && sliceFilter?.colField ? (
                      <PivotHeaderSliceFilter
                        field={sliceFilter.colField}
                        ariaLabel={`Filter ${fieldLabel(sliceFilter.colField, temporalFacetColumns)}`}
                        sessionId={sliceFilter.sessionId}
                        filterSelections={sliceFilter.filterSelections}
                        onSliceChange={sliceFilter.onSliceChange}
                        seedValues={colKeys}
                      />
                    ) : null}
                    {onRowLabelSortChange && model.rowFields.length > 0 && (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => onRowLabelSortChange()}
                        aria-label="Sort rows by row labels (time order when applicable)"
                      >
                        {sortIconForRowLabel()}
                      </button>
                    )}
                    {onRowSortChange && valueSpecs.length === 1 && (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => handleSortClick(valueSpecs[0]!.id)}
                        aria-label={`Sort rows by ${valueHeader(valueSpecs[0]!)}`}
                      >
                        {sortIconFor(valueSpecs[0]!.id)}
                      </button>
                    )}
                  </div>
                </th>
                {colKeys.map((ck) => (
                  <th
                    key={ck}
                    colSpan={Math.max(1, valueSpecs.length)}
                    className="px-3 py-2 text-center font-semibold text-gray-700 border-l border-gray-200/80 whitespace-nowrap"
                  >
                    <div className="inline-flex items-center justify-center gap-1 flex-wrap">
                      <span>
                        {fieldLabel(colField!, temporalFacetColumns)}: {ck || '(blank)'}
                      </span>
                      {sliceFilter?.colField && onHideColumnMember ? (
                        <button
                          type="button"
                          className="rounded p-0.5 text-gray-400 hover:text-red-600 hover:bg-red-50/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          title="Hide this column"
                          aria-label={`Hide column ${ck || '(blank)'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onHideColumnMember(sliceFilter.colField!, ck);
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  </th>
                ))}
              </tr>
              {valueSpecs.length > 1 && (
                <tr className="border-b border-gray-200">
                  {colKeys.map((ck) =>
                    valueSpecs.map((spec) => (
                      <th
                        key={`${ck}-${spec.id}`}
                        className="px-2 py-1.5 text-center text-xs font-medium text-gray-600 border-l border-gray-200/80 whitespace-nowrap"
                      >
                        <div className="flex items-center justify-center gap-1">
                          <span>{valueHeader(spec)}</span>
                          {onRowSortChange && (
                            <button
                              type="button"
                              className="text-[10px] text-muted-foreground hover:text-foreground"
                              onClick={() => handleSortClick(spec.id)}
                              aria-label={`Sort rows by ${valueHeader(spec)}`}
                            >
                              {sortIconFor(spec.id)}
                            </button>
                          )}
                        </div>
                      </th>
                    ))
                  )}
                </tr>
              )}
            </>
          ) : (
            <tr className="border-b border-gray-200">
              <th className="px-3 py-2.5 text-left font-semibold text-gray-800 whitespace-nowrap min-w-[10rem]">
                <div className="flex items-center gap-2 flex-wrap">
                  <span>Row labels</span>
                  {sliceFilter?.rowField ? (
                    <PivotHeaderSliceFilter
                      field={sliceFilter.rowField}
                      ariaLabel={`Filter ${fieldLabel(sliceFilter.rowField, temporalFacetColumns)}`}
                      sessionId={sliceFilter.sessionId}
                      filterSelections={sliceFilter.filterSelections}
                      onSliceChange={sliceFilter.onSliceChange}
                    />
                  ) : null}
                  {onRowLabelSortChange && model.rowFields.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => onRowLabelSortChange()}
                      aria-label="Sort rows by row labels (time order when applicable)"
                    >
                      {sortIconForRowLabel()}
                    </button>
                  )}
                </div>
              </th>
              {valueSpecs.map((spec) => (
                <th
                  key={spec.id}
                  className="px-3 py-2.5 text-left font-semibold text-gray-700 border-l border-gray-100 whitespace-nowrap"
                >
                  <div className="flex items-center gap-2">
                    <span>{valueHeader(spec)}</span>
                    {onRowSortChange && (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => handleSortClick(spec.id)}
                        aria-label={`Sort rows by ${valueHeader(spec)}`}
                      >
                        {sortIconFor(spec.id)}
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {flatRows.map((row) => {
            const isStrong =
              row.kind === 'subtotal' || row.kind === 'grand' || row.kind === 'collapsed';
            const pad =
              row.kind === 'grand' ? 12 : (row.depth + 1) * 12;
            const isCollapsedRow = row.kind === 'collapsed';
            const valueColSpan = hasMatrix
              ? colKeys.length * valueSpecs.length
              : valueSpecs.length;

            return (
              <tr
                key={`${row.pathKey}-${row.kind}`}
                className={cn(
                  'border-b border-gray-100/90 transition-colors',
                  row.kind === 'grand' && 'border-t-2 border-t-gray-300 bg-slate-50/90',
                  row.kind === 'subtotal' && 'bg-slate-50/70 font-medium',
                  isCollapsedRow && 'bg-slate-50/40',
                  !isStrong && 'hover:bg-gray-50/80'
                )}
              >
                <td
                  className={cn(
                    'px-3 py-2 text-gray-800 align-middle',
                    isStrong && 'font-semibold text-gray-900'
                  )}
                  style={{ paddingLeft: pad }}
                >
                  <div className="flex items-center gap-1.5 min-h-[1.25rem]">
                    {(row.kind === 'header' || row.kind === 'collapsed') && (
                      <button
                        type="button"
                        onClick={() => onToggleCollapse(row.pathKey)}
                        className="rounded p-0.5 text-gray-500 hover:text-gray-900 hover:bg-gray-200/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        aria-expanded={row.kind === 'header'}
                        aria-label={row.kind === 'header' ? 'Collapse group' : 'Expand group'}
                      >
                        {row.kind === 'header' ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    )}
                    <span>{row.label}</span>
                  </div>
                </td>
                {row.kind === 'header' || !row.values ? (
                  <td
                    colSpan={valueColSpan}
                    className="border-l border-gray-100/40 bg-slate-50/10"
                  />
                ) : hasMatrix ? (
                  colKeys.flatMap((ck) =>
                    valueSpecs.map((spec) => {
                      const v = row.values.matrixValues?.[ck]?.[spec.id] ?? 0;
                      return (
                        <td
                          key={`${row.pathKey}-${ck}-${spec.id}`}
                          className={cn(
                            'px-3 py-2 text-right tabular-nums text-gray-800 border-l border-gray-100/80 whitespace-nowrap',
                            isStrong && 'font-semibold'
                          )}
                          onClick={() => {
                            if (!onDrillthroughCell) return;
                            if (row.kind !== 'data') return;
                            onDrillthroughCell({
                              rowPathKey: row.pathKey,
                              colKey: ck,
                              valueSpecId: spec.id,
                            });
                          }}
                          role={row.kind === 'data' && onDrillthroughCell ? 'button' : undefined}
                          aria-label={
                            row.kind === 'data' && onDrillthroughCell
                              ? 'Drill through this pivot cell'
                              : undefined
                          }
                        >
                          {displayValue(v, ck, spec.id)}
                        </td>
                      );
                    })
                  )
                ) : (
                  valueSpecs.map((spec) => {
                    const v = row.values.flatValues?.[spec.id] ?? 0;
                    return (
                      <td
                        key={`${row.pathKey}-${spec.id}`}
                        className={cn(
                          'px-3 py-2 text-right tabular-nums text-gray-800 border-l border-gray-100/80 whitespace-nowrap',
                          isStrong && 'font-semibold'
                        )}
                        onClick={() => {
                          if (!onDrillthroughCell) return;
                          if (row.kind !== 'data') return;
                          onDrillthroughCell({
                            rowPathKey: row.pathKey,
                            colKey: null,
                            valueSpecId: spec.id,
                          });
                        }}
                        role={row.kind === 'data' && onDrillthroughCell ? 'button' : undefined}
                        aria-label={
                          row.kind === 'data' && onDrillthroughCell
                            ? 'Drill through this pivot cell'
                            : undefined
                        }
                      >
                        {displayValue(v, null, spec.id)}
                      </td>
                    );
                  })
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
