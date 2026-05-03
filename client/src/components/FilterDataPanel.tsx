/**
 * Wave-FA3 · Excel-style filter panel.
 *
 * Right-side slide-in `Sheet` listing every column. Each column row expands
 * into its own filter (multi-select for categorical, min/max range for
 * numeric, date range for dates). Filter changes debounce and POST to the
 * server's active-filter endpoint — no separate "Apply" click. Closing the
 * panel does not clear the filter.
 *
 * The panel never mutates the canonical dataset. The server applies the spec
 * at read time via `loadLatestData` and the DuckDB `data_filtered` view.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  Filter as FilterIcon,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { fetchPivotColumnDistincts } from "@/lib/api";
import type { ActiveFilterCondition, ActiveFilterSpec } from "@/shared/schema";

export type FilterColumnKind = "text" | "numeric" | "date";

export interface FilterDataPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  /** Canonical / filtered row counts shown in the footer. */
  totalRows: number;
  filteredRows: number;
  /** Server's current view of the active filter. */
  activeFilter: ActiveFilterSpec | null;
  /** Fired when the user changes any condition; debounced upstream. */
  onConditionsChange: (conditions: ActiveFilterCondition[]) => void;
  /** Fired when the user clicks "Clear all". */
  onClearAll: () => void;
  /** Optional indicator while a server PUT is in flight. */
  saving?: boolean;
}

function classifyColumn(
  name: string,
  numericColumns: string[],
  dateColumns: string[]
): FilterColumnKind {
  if (dateColumns.includes(name)) return "date";
  if (numericColumns.includes(name)) return "numeric";
  return "text";
}

function conditionsByColumn(
  conditions: ActiveFilterCondition[]
): Map<string, ActiveFilterCondition> {
  const m = new Map<string, ActiveFilterCondition>();
  for (const c of conditions) m.set(c.column, c);
  return m;
}

function describeCondition(c: ActiveFilterCondition): string {
  if (c.kind === "in") return `${c.values.length} selected`;
  if (c.kind === "range") {
    const lo = c.min ?? "";
    const hi = c.max ?? "";
    if (lo === "" && hi === "") return "no bounds";
    if (lo === "") return `≤ ${hi}`;
    if (hi === "") return `≥ ${lo}`;
    return `${lo} – ${hi}`;
  }
  if (c.kind === "dateRange") {
    const f = c.from ?? "";
    const t = c.to ?? "";
    if (f && t) return `${f} → ${t}`;
    if (f) return `≥ ${f}`;
    if (t) return `≤ ${t}`;
    return "no bounds";
  }
  return "";
}

/** Multi-select picker for a single categorical column. */
function CategoricalPicker({
  field,
  sessionId,
  selected,
  onChange,
}: {
  field: string;
  sessionId: string | null;
  selected: string[] | null;
  onChange: (next: string[]) => void;
}) {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!sessionId) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        // Excel cross-column behavior: include other active filters but exclude
        // any condition on this column itself, so the value list always shows
        // every value the user could pick.
        const values = await fetchPivotColumnDistincts(sessionId, field, 100_000, {
          excludeColumn: field,
        });
        if (!cancelled) setOptions(values);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, field]);

  const visible = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter((v) => v.toLowerCase().includes(q));
  }, [options, search]);

  const selectedSet = useMemo(() => new Set(selected ?? []), [selected]);
  const allSelected = selected !== null && selected.length === options.length;

  const toggle = (v: string, checked: boolean) => {
    const base = new Set(selectedSet);
    if (checked) base.add(v);
    else base.delete(v);
    onChange([...base]);
  };

  const selectAll = () => onChange([...options]);
  const clear = () => onChange([]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search values…"
          className="h-8 pl-7 text-xs"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={selectAll}
          disabled={loading}
        >
          {allSelected ? "Deselect all" : "Select all"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={clear}
          disabled={loading || (selected !== null && selected.length === 0)}
        >
          Clear
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {selected === null
            ? `${options.length} values`
            : `${selected.length} of ${options.length}`}
        </span>
      </div>
      {loading ? (
        <div className="flex justify-center py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">No values</p>
      ) : (
        <ScrollArea className="h-56 pr-2">
          <div className="space-y-1.5">
            {visible.map((opt) => {
              // Default state when the user hasn't touched the column: "all
              // selected" so unchecking one value behaves like Excel. We only
              // emit a concrete `selected` array on first interaction.
              const checked =
                selected === null ? true : selectedSet.has(opt);
              return (
                <label
                  key={opt}
                  className="flex cursor-pointer items-center gap-2 text-xs"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(c) => {
                      // First interaction: materialize the full list, then toggle.
                      if (selected === null) {
                        const next = c ? [...options] : options.filter((v) => v !== opt);
                        onChange(next);
                      } else {
                        toggle(opt, c === true);
                      }
                    }}
                  />
                  <span className="truncate">{opt || "(blank)"}</span>
                </label>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function NumericRange({
  min,
  max,
  onChange,
}: {
  min?: number;
  max?: number;
  onChange: (next: { min?: number; max?: number }) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Min</label>
        <Input
          type="number"
          value={min ?? ""}
          onChange={(e) =>
            onChange({
              min: e.target.value === "" ? undefined : Number(e.target.value),
              max,
            })
          }
          placeholder="(no min)"
          className="h-8 text-xs"
        />
      </div>
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Max</label>
        <Input
          type="number"
          value={max ?? ""}
          onChange={(e) =>
            onChange({
              min,
              max: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
          placeholder="(no max)"
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}

function DateRange({
  from,
  to,
  onChange,
}: {
  from?: string;
  to?: string;
  onChange: (next: { from?: string; to?: string }) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">From</label>
        <Input
          type="date"
          value={from ?? ""}
          onChange={(e) => onChange({ from: e.target.value || undefined, to })}
          className="h-8 text-xs"
        />
      </div>
      <div>
        <label className="block text-xs text-muted-foreground mb-1">To</label>
        <Input
          type="date"
          value={to ?? ""}
          onChange={(e) => onChange({ from, to: e.target.value || undefined })}
          className="h-8 text-xs"
        />
      </div>
    </div>
  );
}

export function FilterDataPanel({
  open,
  onOpenChange,
  sessionId,
  columns,
  numericColumns,
  dateColumns,
  totalRows,
  filteredRows,
  activeFilter,
  onConditionsChange,
  onClearAll,
  saving,
}: FilterDataPanelProps) {
  // Local working copy of the conditions; pushed to parent (debounced upstream).
  const [working, setWorking] = useState<ActiveFilterCondition[]>(
    activeFilter?.conditions ?? []
  );
  const [columnSearch, setColumnSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Sync server-side updates into the working copy when the version changes
  // (e.g. another tab pushes a new filter, or the panel reopens).
  const lastVersion = useRef<number | undefined>(activeFilter?.version);
  useEffect(() => {
    if (activeFilter?.version !== lastVersion.current) {
      setWorking(activeFilter?.conditions ?? []);
      lastVersion.current = activeFilter?.version;
    }
  }, [activeFilter?.version, activeFilter?.conditions]);

  const byColumn = useMemo(() => conditionsByColumn(working), [working]);

  const update = useCallback(
    (next: ActiveFilterCondition[]) => {
      setWorking(next);
      onConditionsChange(next);
    },
    [onConditionsChange]
  );

  const setColumnCondition = useCallback(
    (column: string, condition: ActiveFilterCondition | null) => {
      const stripped = working.filter((c) => c.column !== column);
      const next = condition ? [...stripped, condition] : stripped;
      update(next);
    },
    [working, update]
  );

  const visibleColumns = useMemo(() => {
    if (!columnSearch.trim()) return columns;
    const q = columnSearch.toLowerCase();
    return columns.filter((c) => c.toLowerCase().includes(q));
  }, [columns, columnSearch]);

  const conditionCount = working.length;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full max-w-md flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border/80 p-4">
          <div className="flex items-center gap-2">
            <FilterIcon className="h-5 w-5 text-primary" />
            <SheetTitle>Filter Data</SheetTitle>
            {conditionCount > 0 && (
              <Badge variant="secondary" className="ml-1">
                {conditionCount}
              </Badge>
            )}
          </div>
          <SheetDescription className="text-xs">
            Filters are applied to all analyses on this dataset. Your original
            data is never modified.
          </SheetDescription>
          <div className="mt-3 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={columnSearch}
                onChange={(e) => setColumnSearch(e.target.value)}
                placeholder="Search columns…"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setWorking([]);
                onClearAll();
              }}
              disabled={conditionCount === 0 || saving}
              className="h-8 text-xs"
            >
              Clear all
            </Button>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="divide-y divide-border/60">
            {visibleColumns.map((column) => {
              const kind = classifyColumn(column, numericColumns, dateColumns);
              const isOpen = expanded.has(column);
              const condition = byColumn.get(column);
              const summary = condition ? describeCondition(condition) : null;
              return (
                <div key={column} className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(column)) next.delete(column);
                        else next.add(column);
                        return next;
                      });
                    }}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate text-sm font-medium">
                      {column}
                    </span>
                    <span className="text-[10px] uppercase text-muted-foreground">
                      {kind}
                    </span>
                    {summary && (
                      <Badge variant="outline" className="text-[10px]">
                        {summary}
                      </Badge>
                    )}
                  </button>
                  {isOpen && (
                    <div className="mt-2 pl-6">
                      {kind === "text" && (
                        <CategoricalPicker
                          field={column}
                          sessionId={sessionId}
                          selected={
                            condition && condition.kind === "in"
                              ? condition.values
                              : null
                          }
                          onChange={(values) => {
                            // null-state happens when user hasn't touched it; we always
                            // emit a concrete array here. Empty array means "exclude all".
                            setColumnCondition(column, {
                              kind: "in",
                              column,
                              values,
                            });
                          }}
                        />
                      )}
                      {kind === "numeric" && (
                        <NumericRange
                          min={condition && condition.kind === "range" ? condition.min : undefined}
                          max={condition && condition.kind === "range" ? condition.max : undefined}
                          onChange={({ min, max }) => {
                            if (min === undefined && max === undefined) {
                              setColumnCondition(column, null);
                            } else {
                              setColumnCondition(column, {
                                kind: "range",
                                column,
                                min,
                                max,
                              });
                            }
                          }}
                        />
                      )}
                      {kind === "date" && (
                        <DateRange
                          from={
                            condition && condition.kind === "dateRange"
                              ? condition.from
                              : undefined
                          }
                          to={
                            condition && condition.kind === "dateRange"
                              ? condition.to
                              : undefined
                          }
                          onChange={({ from, to }) => {
                            if (!from && !to) {
                              setColumnCondition(column, null);
                            } else {
                              setColumnCondition(column, {
                                kind: "dateRange",
                                column,
                                from,
                                to,
                              });
                            }
                          }}
                        />
                      )}
                      {condition && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-2 h-6 gap-1 px-2 text-xs text-muted-foreground"
                          onClick={() => setColumnCondition(column, null)}
                        >
                          <X className="h-3 w-3" /> Remove this filter
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <div className="border-t border-border/80 bg-card p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {filteredRows.toLocaleString()} of {totalRows.toLocaleString()} rows match
            </span>
            {saving && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Updating…
              </span>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
