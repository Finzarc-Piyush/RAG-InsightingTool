import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Table, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
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

interface DataPreviewProps {
  data: Record<string, any>[];
  columns: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  temporalDisplayGrainsByColumn?: Record<string, TemporalDisplayGrain>;
  totalRows?: number;
  totalColumns?: number;
  defaultExpanded?: boolean;
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
  defaultExpanded = false 
}: DataPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

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

  if (!data || data.length === 0) return null;

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
                {sortedData.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className="border-b last:border-b-0 hover:bg-gray-50"
                    data-testid={`row-${rowIdx}`}
                  >
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
    </div>
  );
}
