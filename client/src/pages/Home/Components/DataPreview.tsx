import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Table, GitCompareArrows } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ColumnsDisplay } from './ColumnsDisplay';
import type {
  ColumnCurrency,
  DimensionHierarchy,
  TemporalDisplayGrain,
  TemporalFacetColumnMeta,
  WideFormatTransform,
} from '@/shared/schema';
import { formatDateCellForGrain, inferTemporalGrainFromSample } from '@/lib/temporalDisplayFormat';
import { facetColumnHeaderLabel, isTemporalFacetFieldId } from '@/lib/temporalFacetDisplay';
import { parseDateLike } from '@/lib/parseDateLike';
import { usePreviewTableSort } from '@/hooks/usePreviewTableSort';

function formatDdMmmYy(value: unknown): string | null {
  const ts = parseDateLike(value);
  if (ts === null) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const day = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  const year = String(d.getFullYear());
  return `${day}-${month} ${year}`;
}

interface DataPreviewProps {
  data: Record<string, any>[];
  columns: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  temporalDisplayGrainsByColumn?: Record<string, TemporalDisplayGrain>;
  /** When provided, derived time-bucket column headers use grain + source (e.g. Month · Order Date). */
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  totalRows?: number;
  totalColumns?: number;
  defaultExpanded?: boolean;
  preEnrichmentSnapshot?: {
    capturedAt: number;
    rows: Record<string, any>[];
    columns: string[];
    numericColumns: string[];
    dateColumns: string[];
    totalRows: number;
    totalColumns: number;
  } | null;
  postEnrichmentSnapshot?: {
    capturedAt: number;
    rows: Record<string, any>[];
    columns: string[];
    numericColumns: string[];
    dateColumns: string[];
    totalRows: number;
    totalColumns: number;
  } | null;
  /** WF9 — per-column currency tag (server-detected). */
  currencyByColumn?: Record<string, ColumnCurrency>;
  /** WF9 — wide-format auto-melt metadata; renders the banner. */
  wideFormatTransform?: WideFormatTransform;
  /** H6 — declared dimension hierarchies; renders the banner. */
  dimensionHierarchies?: DimensionHierarchy[];
  /** EU1 — when present, banner shows ✕ Remove buttons. */
  sessionIdForHierarchyEdit?: string;
  /** EU1 — callback after successful hierarchy remove. */
  onHierarchiesChange?: (next: DimensionHierarchy[]) => void;
}

export function DataPreview({
  data,
  columns,
  numericColumns = [],
  dateColumns = [],
  temporalDisplayGrainsByColumn = {},
  temporalFacetColumns = [],
  totalRows,
  totalColumns,
  defaultExpanded = false,
  preEnrichmentSnapshot = null,
  postEnrichmentSnapshot = null,
  currencyByColumn,
  wideFormatTransform,
  dimensionHierarchies,
  sessionIdForHierarchyEdit,
  onHierarchiesChange,
}: DataPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [compareMode, setCompareMode] = useState(false);
  const [showDerivedTimeColumns, setShowDerivedTimeColumns] = useState(false);

  const hasTfColumns = useMemo(
    () => (columns ?? []).some((c) => isTemporalFacetFieldId(c)),
    [columns]
  );

  const facetLabelByColumn = useMemo(() => {
    const m: Record<string, string> = {};
    for (const meta of temporalFacetColumns) {
      m[meta.name] = facetColumnHeaderLabel(meta);
    }
    return m;
  }, [temporalFacetColumns]);

  const visibleColumns = useMemo(() => {
    const cols = columns ?? [];
    if (showDerivedTimeColumns) return cols;
    return cols.filter((c) => !isTemporalFacetFieldId(c));
  }, [columns, showDerivedTimeColumns]);

  const displayAsDateColumns = useMemo(() => {
    // Strict preview behavior: only format dates from authoritative dateColumns metadata.
    return new Set(dateColumns);
  }, [dateColumns]);

  const resolvedGrainsByColumn = useMemo(() => {
    const out: Record<string, TemporalDisplayGrain> = { ...temporalDisplayGrainsByColumn };
    for (const col of displayAsDateColumns) {
      if (!out[col]) {
        const vals = data.slice(0, 500).map((row) => row[col]);
        out[col] = inferTemporalGrainFromSample(vals);
      }
    }
    return out;
  }, [data, displayAsDateColumns, temporalDisplayGrainsByColumn]);

  const { sortedData, handleSort, getSortIcon } = usePreviewTableSort({
    data,
    columns: visibleColumns,
    numericColumns,
    dateColumns,
    variant: 'dataset',
  });

  const compareColumns = useMemo(() => {
    if (!preEnrichmentSnapshot || !postEnrichmentSnapshot) return [];
    const hideTf = (c: string) => !isTemporalFacetFieldId(c);
    const set = new Set<string>([
      ...preEnrichmentSnapshot.columns.filter(hideTf),
      ...postEnrichmentSnapshot.columns.filter(hideTf),
    ]);
    return Array.from(set);
  }, [preEnrichmentSnapshot, postEnrichmentSnapshot]);

  const compareDateColumns = useMemo(() => {
    if (!preEnrichmentSnapshot || !postEnrichmentSnapshot) return new Set<string>();
    return new Set<string>([
      ...(preEnrichmentSnapshot.dateColumns || []),
      ...(postEnrichmentSnapshot.dateColumns || []),
    ]);
  }, [preEnrichmentSnapshot, postEnrichmentSnapshot]);

  const changedCellKeys = useMemo(() => {
    const changed = new Set<string>();
    if (!preEnrichmentSnapshot || !postEnrichmentSnapshot) return changed;
    const maxRows = Math.min(
      Math.max(preEnrichmentSnapshot.rows.length, postEnrichmentSnapshot.rows.length),
      50
    );
    for (let rowIdx = 0; rowIdx < maxRows; rowIdx += 1) {
      const pre = preEnrichmentSnapshot.rows[rowIdx] || {};
      const post = postEnrichmentSnapshot.rows[rowIdx] || {};
      for (const col of compareColumns) {
        const preVal = pre[col] ?? null;
        const postVal = post[col] ?? null;
        if (String(preVal) !== String(postVal)) {
          changed.add(`${rowIdx}::${col}`);
        }
      }
    }
    return changed;
  }, [preEnrichmentSnapshot, postEnrichmentSnapshot, compareColumns]);

  const changedColumns = useMemo(() => {
    const changed = new Set<string>();
    changedCellKeys.forEach((k) => changed.add(k.split('::')[1]));
    return changed;
  }, [changedCellKeys]);

  const hasCompareData = !!preEnrichmentSnapshot && !!postEnrichmentSnapshot;
  const hasVisibleChanges = changedCellKeys.size > 0;
  const changedValuesCount = changedCellKeys.size;

  if (!columns?.length) return null;

  return (
    <div className="mt-4" data-testid="data-preview-container">
      {/* Columns Display */}
      <ColumnsDisplay
        columns={visibleColumns}
        numericColumns={numericColumns}
        dateColumns={dateColumns}
        totalRows={totalRows}
        totalColumns={totalColumns}
        currencyByColumn={currencyByColumn}
        wideFormatTransform={wideFormatTransform}
        dimensionHierarchies={dimensionHierarchies}
        sessionId={sessionIdForHierarchyEdit}
        onHierarchiesChange={onHierarchiesChange}
      />
      
      {/* Data Preview Table */}
      <div className="border border-border rounded-md bg-card">
        <Button
          variant="ghost"
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full justify-start gap-2 rounded-none border-b hover-elevate active-elevate-2"
          data-testid="button-toggle-preview"
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <Table className="h-4 w-4" />
          <span className="font-medium">Data Preview</span>
          <span className="text-muted-foreground ml-1">
            ({sortedData.length} {sortedData.length === 1 ? 'sample row' : 'sample rows'}
            {typeof totalRows === 'number' &&
            totalRows > 0 &&
            totalRows !== sortedData.length
              ? ` · Total: ${totalRows.toLocaleString()}`
              : ''})
          </span>
        </Button>

        {isExpanded && (
          <>
            {hasTfColumns && (
              <div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-border bg-muted/20">
                <Label
                  htmlFor="show-derived-tf-cols"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  Show derived time columns
                </Label>
                <Switch
                  id="show-derived-tf-cols"
                  checked={showDerivedTimeColumns}
                  onCheckedChange={setShowDerivedTimeColumns}
                  data-testid="toggle-derived-time-columns"
                />
              </div>
            )}
            <div className="h-80 overflow-auto relative" data-testid="preview-table-scroll">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-20">
                <tr className="border-b border-border bg-muted/60 shadow-sm">
                  <th
                    className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap bg-muted/60 w-10"
                    scope="col"
                  >
                    #
                  </th>
                  {visibleColumns.map((col, idx) => (
                    <th
                      key={idx}
                      className="px-4 py-2 text-left font-medium text-foreground whitespace-nowrap bg-muted/60 cursor-pointer hover:bg-muted/90 select-none transition-colors"
                      onClick={() => handleSort(col)}
                      data-testid={`header-${col}`}
                    >
                      <div className="flex items-center">
                        {facetLabelByColumn[col] ?? col}
                        {getSortIcon(col)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!visibleColumns.length && hasTfColumns && !showDerivedTimeColumns && (
                  <tr>
                    <td
                      className="px-4 py-6 text-center text-sm text-muted-foreground"
                      colSpan={2}
                    >
                      Derived time columns are hidden. Turn on &quot;Show derived time columns&quot; above.
                    </td>
                  </tr>
                )}
                {sortedData.length === 0 && visibleColumns.length > 0 && (
                  <tr>
                    <td
                      className="px-4 py-6 text-center text-sm text-muted-foreground"
                      colSpan={visibleColumns.length + 1}
                    >
                      No sample rows available yet. Columns are ready.
                    </td>
                  </tr>
                )}
                {visibleColumns.length > 0 &&
                  sortedData.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className="border-b border-border last:border-b-0 hover:bg-muted/30"
                    data-testid={`row-${rowIdx}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground tabular-nums w-10">
                      {rowIdx + 1}
                    </td>
                    {visibleColumns.map((col, colIdx) => {
                      const value = row[col];
                      let displayValue = value;
                      
                      if (value !== null && value !== undefined) {
                        if (displayAsDateColumns.has(col)) {
                          const g = resolvedGrainsByColumn[col];
                          const formatted =
                            g !== undefined ? formatDateCellForGrain(value, g) : null;
                          displayValue = formatted ?? String(value);
                        } else if (typeof value === 'number' && !Number.isInteger(value)) {
                          displayValue = value.toFixed(2);
                        } else {
                          displayValue = String(value);
                        }
                      } else {
                        displayValue = '—';
                      }
                      
                      return (
                        <td
                          key={colIdx}
                          className="px-4 py-2 whitespace-nowrap"
                          data-testid={`cell-${rowIdx}-${col}`}
                        >
                          {displayValue}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
      </div>

      {hasCompareData && (
        <div className="mt-3 rounded-md border border-border bg-card">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="text-sm font-medium text-foreground flex items-center gap-2">
              <GitCompareArrows className="h-4 w-4" />
              Compare pre/post enrichment
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setCompareMode((prev) => !prev)}
            >
              {compareMode ? 'Hide comparison' : 'Show comparison'}
            </Button>
          </div>
          <div className="px-3 py-2 flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center rounded-full bg-muted/30 border border-border px-2 py-0.5 text-foreground">
              Pre rows: {preEnrichmentSnapshot?.rows.length ?? 0}
            </span>
            <span className="inline-flex items-center rounded-full bg-muted/30 border border-border px-2 py-0.5 text-foreground">
              Post rows: {postEnrichmentSnapshot?.rows.length ?? 0}
            </span>
            <span className="inline-flex items-center rounded-full bg-muted/30 border border-border px-2 py-0.5 text-foreground">
              Changed columns: {changedColumns.size}
            </span>
            <span className="inline-flex items-center rounded-full bg-muted/30 border border-border px-2 py-0.5 text-foreground">
              Values changed: {changedValuesCount}
            </span>
            <span className="inline-flex items-center rounded-full bg-primary/10 border border-primary/25 px-2 py-0.5 text-primary">
              Green = updated after enrichment
            </span>
          </div>
          {compareMode && (
            <div className="px-3 pb-3">
              {!hasVisibleChanges && (
                <div className="text-xs text-muted-foreground pb-2">
                  No visible preview differences after enrichment.
                </div>
              )}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                <div className="rounded-md border border-border bg-card overflow-auto max-h-[28rem]">
                  <div className="px-3 py-2 text-xs font-semibold border-b border-border">Pre-enrichment snapshot</div>
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr>
                        <th className="px-2 py-1 text-left">#</th>
                        {compareColumns.map((c) => (
                          <th key={`pre-h-${c}`} className="px-2 py-1 text-left whitespace-nowrap">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(preEnrichmentSnapshot?.rows || []).map((row, rowIdx) => (
                        <tr key={`pre-r-${rowIdx}`} className="border-b border-border">
                          <td className="px-2 py-1 text-muted-foreground">{rowIdx + 1}</td>
                          {compareColumns.map((c) => (
                            <td key={`pre-c-${rowIdx}-${c}`} className="px-2 py-1 whitespace-nowrap">
                              {row[c] == null
                                ? '—'
                                : compareDateColumns.has(c)
                                ? (formatDdMmmYy(row[c]) ?? String(row[c]))
                                : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-md border border-border bg-card overflow-auto max-h-[28rem]">
                  <div className="px-3 py-2 text-xs font-semibold border-b border-border text-foreground">Post-enrichment snapshot</div>
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr>
                        <th className="px-2 py-1 text-left">#</th>
                        {compareColumns.map((c) => (
                          <th
                            key={`post-h-${c}`}
                            className={`px-2 py-1 text-left whitespace-nowrap ${
                              changedColumns.has(c) ? 'bg-primary/10 text-primary' : ''
                            }`}
                          >
                            {c}
                            {changedColumns.has(c) ? ' (updated)' : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(postEnrichmentSnapshot?.rows || []).map((row, rowIdx) => (
                        <tr key={`post-r-${rowIdx}`} className="border-b border-border">
                          <td className="px-2 py-1 text-muted-foreground">{rowIdx + 1}</td>
                          {compareColumns.map((c) => {
                            const changed = changedCellKeys.has(`${rowIdx}::${c}`);
                            return (
                              <td
                                key={`post-c-${rowIdx}-${c}`}
                                className={`px-2 py-1 whitespace-nowrap ${
                                  changed
                                    ? 'bg-primary/10 border border-primary/25 text-primary font-medium'
                                    : ''
                                }`}
                                title={changed ? 'Updated after enrichment' : undefined}
                              >
                                {row[c] == null
                                  ? '—'
                                  : compareDateColumns.has(c)
                                  ? (formatDdMmmYy(row[c]) ?? String(row[c]))
                                  : String(row[c])}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground mt-2">
                Rows are compared by visible order in preview. If row order changes, differences may reflect reordered records.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
