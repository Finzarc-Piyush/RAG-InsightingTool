import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Table, ArrowUp, ArrowDown, ArrowUpDown, GitCompareArrows } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColumnsDisplay } from './ColumnsDisplay';
import type { TemporalDisplayGrain } from '@/shared/schema';
import { formatDateCellForGrain, inferTemporalGrainFromSample } from '@/lib/temporalDisplayFormat';

// Helpers for robust date parsing and detection
const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function parseDateLike(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
  const str = String(value).trim();
  if (!str) return null;

  // Match formats like "Apr-24", "Apr 24", "Apr-2024", "August 2024"
  const mmmYyMatch = str.match(/^([A-Za-z]{3,})[-\s/]?(\d{2,4})$/i);
  if (mmmYyMatch) {
    const monthName = mmmYyMatch[1].toLowerCase().substring(0, 3);
    const month = MONTH_MAP[monthName];
    if (month !== undefined) {
      let year = parseInt(mmmYyMatch[2], 10);
      if (year < 100) {
        year = year <= 30 ? 2000 + year : 1900 + year;
      }
      return new Date(year, month, 1).getTime();
    }
  }

  const native = new Date(str);
  if (!isNaN(native.getTime())) return native.getTime();
  return null;
}

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
}

type SortDirection = 'asc' | 'desc' | null;

export function DataPreview({ 
  data, 
  columns, 
  numericColumns = [], 
  dateColumns = [], 
  temporalDisplayGrainsByColumn = {},
  totalRows,
  totalColumns,
  defaultExpanded = false,
  preEnrichmentSnapshot = null,
  postEnrichmentSnapshot = null,
}: DataPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [compareMode, setCompareMode] = useState(false);

  /** Stale sessions: format date-like columns even if server did not list them in dateColumns. */
  const displayAsDateColumns = useMemo(() => {
    const set = new Set(dateColumns);
    for (const col of columns) {
      if (set.has(col)) continue;
      const lower = col.toLowerCase();
      const nameSuggestsDate = /(month|date|week|year|time|period|day|quarter)/.test(lower);
      const sample = data.slice(0, 12).map((row) => row[col]);
      const anyParses = sample.some((v) => parseDateLike(v) !== null);
      if (nameSuggestsDate || anyParses) set.add(col);
    }
    return set;
  }, [columns, dateColumns, data]);

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

  // Sort data based on current sort column and direction
  const sortedData = useMemo(() => {
    if (!sortColumn || !sortDirection) {
      return data;
    }

    const isNumeric = numericColumns.includes(sortColumn);
    // Consider date if declared OR column name suggests a date OR values parse as dates
    const columnNameLower = sortColumn.toLowerCase();
    const nameSuggestsDate = /(month|date|week|year)/.test(columnNameLower);
    const valuesSample = data.slice(0, 12).map(row => row[sortColumn]);
    const anyValueParsesAsDate = valuesSample.some(v => parseDateLike(v) !== null);
    const isDate = dateColumns.includes(sortColumn) || nameSuggestsDate || anyValueParsesAsDate;

    return [...data].sort((a, b) => {
      let aVal = a[sortColumn];
      let bVal = b[sortColumn];

      // Handle null/undefined values
      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      let comparison = 0;

      if (isDate) {
        // Sort dates (robust parsing including "Apr-24" style)
        const aTs = parseDateLike(aVal);
        const bTs = parseDateLike(bVal);
        if (aTs === null && bTs === null) {
          comparison = 0;
        } else if (aTs === null) {
          comparison = 1;
        } else if (bTs === null) {
          comparison = -1;
        } else {
          comparison = aTs - bTs;
        }
      } else if (isNumeric) {
        // Sort numbers
        const aNum = typeof aVal === 'number' ? aVal : parseFloat(String(aVal));
        const bNum = typeof bVal === 'number' ? bVal : parseFloat(String(bVal));
        comparison = (isNaN(aNum) ? 0 : aNum) - (isNaN(bNum) ? 0 : bNum);
      } else {
        // Sort strings
        comparison = String(aVal).localeCompare(String(bVal));
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [data, sortColumn, sortDirection, numericColumns, dateColumns]);

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      // Cycle through: asc -> desc -> null
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else if (sortDirection === 'desc') {
        setSortColumn(null);
        setSortDirection(null);
      }
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const getSortIcon = (column: string) => {
    if (sortColumn !== column) {
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    }
    if (sortDirection === 'asc') {
      return <ArrowUp className="h-3 w-3 ml-1" />;
    }
    if (sortDirection === 'desc') {
      return <ArrowDown className="h-3 w-3 ml-1" />;
    }
    return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
  };

  if (!columns || columns.length === 0) return null;

  const compareColumns = useMemo(() => {
    if (!preEnrichmentSnapshot || !postEnrichmentSnapshot) return [];
    const set = new Set<string>([
      ...preEnrichmentSnapshot.columns,
      ...postEnrichmentSnapshot.columns,
    ]);
    return Array.from(set);
  }, [preEnrichmentSnapshot, postEnrichmentSnapshot]);

  const compareDateColumns = useMemo(() => {
    if (!preEnrichmentSnapshot || !postEnrichmentSnapshot) return new Set<string>();
    const set = new Set<string>([
      ...(preEnrichmentSnapshot.dateColumns || []),
      ...(postEnrichmentSnapshot.dateColumns || []),
    ]);
    for (const col of compareColumns) {
      if (set.has(col)) continue;
      const sample = [
        ...preEnrichmentSnapshot.rows.slice(0, 8).map((r) => r[col]),
        ...postEnrichmentSnapshot.rows.slice(0, 8).map((r) => r[col]),
      ];
      if (sample.some((v) => parseDateLike(v) !== null)) {
        set.add(col);
      }
    }
    return set;
  }, [preEnrichmentSnapshot, postEnrichmentSnapshot, compareColumns]);

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

  return (
    <div className="mt-4" data-testid="data-preview-container">
      {/* Columns Display */}
      <ColumnsDisplay 
        columns={columns}
        numericColumns={numericColumns}
        dateColumns={dateColumns}
        totalRows={totalRows}
        totalColumns={totalColumns}
      />
      
      {/* Data Preview Table */}
      <div className="border rounded-md">
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
            ({sortedData.length} {sortedData.length === 1 ? 'row' : 'rows'})
          </span>
        </Button>

        {isExpanded && (
          <div className="h-80 overflow-auto relative" data-testid="preview-table-scroll">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-20">
                <tr className="border-b bg-gray-100 shadow-sm">
                  <th
                    className="px-3 py-2 text-left font-medium text-gray-500 whitespace-nowrap bg-gray-100 w-10"
                    scope="col"
                  >
                    #
                  </th>
                  {columns.map((col, idx) => (
                    <th
                      key={idx}
                      className="px-4 py-2 text-left font-medium text-gray-700 whitespace-nowrap bg-gray-100 cursor-pointer hover:bg-gray-200 select-none transition-colors"
                      onClick={() => handleSort(col)}
                      data-testid={`header-${col}`}
                    >
                      <div className="flex items-center">
                        {col}
                        {getSortIcon(col)}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedData.length === 0 && (
                  <tr>
                    <td
                      className="px-4 py-6 text-center text-sm text-muted-foreground"
                      colSpan={columns.length + 1}
                    >
                      No sample rows available yet. Columns are ready.
                    </td>
                  </tr>
                )}
                {sortedData.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className="border-b last:border-b-0 hover:bg-gray-50"
                    data-testid={`row-${rowIdx}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground tabular-nums w-10">
                      {rowIdx + 1}
                    </td>
                    {columns.map((col, colIdx) => {
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
        )}
      </div>

      {hasCompareData && (
        <div className="mt-3 rounded-md border border-emerald-200/80 bg-emerald-50/40">
          <div className="flex items-center justify-between px-3 py-2 border-b border-emerald-200/70">
            <div className="text-sm font-medium text-emerald-800 flex items-center gap-2">
              <GitCompareArrows className="h-4 w-4" />
              Compare pre/post enrichment
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-emerald-300 text-emerald-800 hover:bg-emerald-100"
              onClick={() => setCompareMode((prev) => !prev)}
            >
              {compareMode ? 'Hide comparison' : 'Show comparison'}
            </Button>
          </div>
          <div className="px-3 py-2 flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center rounded-full bg-white border border-emerald-200 px-2 py-0.5 text-emerald-900">
              Pre rows: {preEnrichmentSnapshot?.rows.length ?? 0}
            </span>
            <span className="inline-flex items-center rounded-full bg-white border border-emerald-200 px-2 py-0.5 text-emerald-900">
              Post rows: {postEnrichmentSnapshot?.rows.length ?? 0}
            </span>
            <span className="inline-flex items-center rounded-full bg-white border border-emerald-200 px-2 py-0.5 text-emerald-900">
              Changed columns: {changedColumns.size}
            </span>
            <span className="inline-flex items-center rounded-full bg-white border border-emerald-200 px-2 py-0.5 text-emerald-900">
              Values changed: {changedValuesCount}
            </span>
            <span className="inline-flex items-center rounded-full bg-emerald-100 border border-emerald-300 px-2 py-0.5 text-emerald-900">
              Green = updated after enrichment
            </span>
          </div>
          {compareMode && (
            <div className="px-3 pb-3">
              {!hasVisibleChanges && (
                <div className="text-xs text-emerald-900/80 pb-2">
                  No visible preview differences after enrichment.
                </div>
              )}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                <div className="rounded-md border bg-white overflow-auto max-h-[28rem]">
                  <div className="px-3 py-2 text-xs font-semibold border-b">Pre-enrichment snapshot</div>
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-100">
                      <tr>
                        <th className="px-2 py-1 text-left">#</th>
                        {compareColumns.map((c) => (
                          <th key={`pre-h-${c}`} className="px-2 py-1 text-left whitespace-nowrap">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(preEnrichmentSnapshot?.rows || []).map((row, rowIdx) => (
                        <tr key={`pre-r-${rowIdx}`} className="border-b">
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
                <div className="rounded-md border bg-white overflow-auto max-h-[28rem]">
                  <div className="px-3 py-2 text-xs font-semibold border-b text-emerald-800">Post-enrichment snapshot</div>
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-100">
                      <tr>
                        <th className="px-2 py-1 text-left">#</th>
                        {compareColumns.map((c) => (
                          <th
                            key={`post-h-${c}`}
                            className={`px-2 py-1 text-left whitespace-nowrap ${
                              changedColumns.has(c) ? 'bg-emerald-100 text-emerald-900' : ''
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
                        <tr key={`post-r-${rowIdx}`} className="border-b">
                          <td className="px-2 py-1 text-muted-foreground">{rowIdx + 1}</td>
                          {compareColumns.map((c) => {
                            const changed = changedCellKeys.has(`${rowIdx}::${c}`);
                            return (
                              <td
                                key={`post-c-${rowIdx}-${c}`}
                                className={`px-2 py-1 whitespace-nowrap ${
                                  changed
                                    ? 'bg-emerald-100/80 border border-emerald-300 text-emerald-900 font-medium'
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
              <div className="text-[11px] text-emerald-900/70 mt-2">
                Rows are compared by visible order in preview. If row order changes, differences may reflect reordered records.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
