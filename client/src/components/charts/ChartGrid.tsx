/**
 * ChartGrid — multi-chart container with cross-filter awareness. WC6.x.
 *
 * Charts inside a <ChartGrid> can publish click events; other charts
 * read the active cross-filter from context and apply it as a row
 * predicate before rendering. Click again on the same value to clear.
 *
 * Minimal v1: a single (field, value) tuple as the active filter.
 * Phase 6+ can extend to multi-field AND/OR composition.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import type { Row } from "@/lib/charts/encodingResolver";

export interface CrossFilter {
  field: string;
  value: unknown;
}

export interface ChartGridContextValue {
  filter: CrossFilter | null;
  setFilter: (filter: CrossFilter | null) => void;
  /** Toggle a filter — sets if different, clears if same. */
  toggleFilter: (filter: CrossFilter) => void;
  /** Apply the active filter to a row list. */
  applyFilter: (rows: Row[]) => Row[];
  /**
   * True only when this context is provided by a real <ChartGrid>.
   * The `useChartGrid()` no-op shim returns false, so renderers can
   * suppress click-to-cross-filter UI when nothing would happen
   * (Fix-5).
   */
  inGrid: boolean;
}

const ChartGridContext = createContext<ChartGridContextValue | null>(null);

export interface ChartGridProps {
  children: ReactNode;
  /** Layout columns; defaults to 2. */
  columns?: number;
  className?: string;
}

export function ChartGrid({ children, columns = 2, className }: ChartGridProps) {
  const [filter, setFilter] = useState<CrossFilter | null>(null);

  const toggleFilter = useCallback((f: CrossFilter) => {
    setFilter((prev) =>
      prev && prev.field === f.field && prev.value === f.value ? null : f,
    );
  }, []);

  const applyFilter = useCallback(
    (rows: Row[]): Row[] => {
      if (!filter) return rows;
      return rows.filter((r) => r[filter.field] === filter.value);
    },
    [filter],
  );

  const value = useMemo<ChartGridContextValue>(
    () => ({ filter, setFilter, toggleFilter, applyFilter, inGrid: true }),
    [filter, toggleFilter, applyFilter],
  );

  return (
    <ChartGridContext.Provider value={value}>
      <div className={cn("flex flex-col gap-2", className)}>
        {filter && (
          <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-1.5 text-[11px]">
            <span className="font-medium text-foreground/80">Cross-filtered:</span>
            <span className="rounded border border-primary/30 bg-card px-1.5 py-0.5 font-medium text-primary">
              {filter.field} = {String(filter.value)}
            </span>
            <button
              type="button"
              onClick={() => setFilter(null)}
              className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            >
              Clear ✕
            </button>
          </div>
        )}
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {children}
        </div>
      </div>
    </ChartGridContext.Provider>
  );
}

/** Read the cross-filter context. Returns no-op shim when not inside a ChartGrid. */
export function useChartGrid(): ChartGridContextValue {
  const ctx = useContext(ChartGridContext);
  if (ctx) return ctx;
  return {
    filter: null,
    setFilter: () => {},
    toggleFilter: () => {},
    applyFilter: (rows) => rows,
    inGrid: false,
  };
}
