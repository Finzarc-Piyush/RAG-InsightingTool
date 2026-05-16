/**
 * Wave WD1 · `+ Add filter` popover for the dashboard global filter bar.
 *
 * Closes the explicit user requirement that the dashboard's global slicer
 * should be additive — pre-WD1 [`DashboardGlobalFilterBar.tsx`](./DashboardGlobalFilterBar.tsx)
 * could only display + dismiss filters captured at dashboard creation,
 * not add new ones.
 *
 * The popover has two views:
 *
 *   1. **Column list.** Scrollable. Lists every column available to add
 *      (those not already filtered) sorted by frequency across tiles. Each
 *      row carries an icon for its filter kind so the user can predict
 *      what the picker will look like.
 *
 *   2. **Per-column editor.** Renders one of three inline pickers based
 *      on the column's `ChartFilterDefinition.type`:
 *        - **categorical** — checkbox list of distinct values, capped at
 *          the first ~30 with a count-of-more hint
 *        - **numeric** — `min` + `max` number inputs bracketed by the
 *          observed range as placeholders
 *        - **date** — `from` + `to` date inputs (HTML5 native pickers)
 *
 * Confirm wires through to the parent's `onAddFilter(next)` with the
 * complete next `ActiveChartFilters` object — the parent already owns
 * the global filter state via `setGlobalFilters`, so this component
 * stays controlled / stateless w.r.t. persistence.
 *
 * Layout uses semantic tokens (`bg-popover`, `text-foreground`,
 * `bg-muted`) per [client/THEMING.md](../../../THEMING.md) so the
 * `npm run theme:check` lint stays clean.
 */
import { useMemo, useState } from "react";
import { Calendar, Hash, ListTree, Plus, Search, Tag, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type {
  ActiveChartFilters,
  ChartFilterDefinition,
  CategoricalFilterDefinition,
  DateFilterDefinition,
  NumericFilterDefinition,
} from "@/lib/chartFilters";
import {
  addCategoricalFilter,
  addDateFilter,
  addNumericFilter,
} from "../dashboardGlobalFilters";

interface AddFilterPopoverProps {
  available: ChartFilterDefinition[];
  current: ActiveChartFilters;
  onAddFilter: (next: ActiveChartFilters) => void;
  /** Visible only when there is at least one available filter. Parent owns the gating choice. */
  disabled?: boolean;
}

const MAX_CATEGORICAL_OPTIONS = 30;

function iconForType(type: ChartFilterDefinition["type"]) {
  if (type === "categorical") return <Tag className="h-3.5 w-3.5" />;
  if (type === "numeric") return <Hash className="h-3.5 w-3.5" />;
  return <Calendar className="h-3.5 w-3.5" />;
}

function labelForType(type: ChartFilterDefinition["type"]): string {
  if (type === "categorical") return "Categorical";
  if (type === "numeric") return "Numeric range";
  return "Date range";
}

export function AddFilterPopover({
  available,
  current,
  onAddFilter,
  disabled,
}: AddFilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ChartFilterDefinition | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return available;
    return available.filter((d) => d.key.toLowerCase().includes(q));
  }, [available, search]);

  const reset = () => {
    setSelected(null);
    setSearch("");
  };

  const close = () => {
    setOpen(false);
    // delay reset until after popover unmounts so user doesn't see flicker
    setTimeout(reset, 200);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTimeout(reset, 200);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
          disabled={disabled || available.length === 0}
          data-testid="dashboard-add-filter-button"
          aria-label="Add filter"
        >
          <Plus className="h-3.5 w-3.5" />
          Add filter
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-[320px] p-0 bg-popover text-popover-foreground"
        data-testid="dashboard-add-filter-popover"
      >
        {selected === null ? (
          <div>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search columns..."
                className="h-7 border-0 px-0 text-sm focus-visible:ring-0 bg-transparent"
                aria-label="Search filter columns"
              />
            </div>
            <div
              className="max-h-[300px] overflow-y-auto py-1"
              role="listbox"
              aria-label="Available filter columns"
            >
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {available.length === 0
                    ? "No columns available to filter."
                    : "No matches."}
                </div>
              ) : (
                filtered.map((def) => (
                  <button
                    key={def.key}
                    type="button"
                    onClick={() => setSelected(def)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm",
                      "hover:bg-muted/60 focus-visible:bg-muted/60 outline-none",
                    )}
                    role="option"
                    aria-selected={false}
                  >
                    <span className="text-muted-foreground">
                      {iconForType(def.type)}
                    </span>
                    <span className="flex-1 truncate text-foreground">{def.key}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {labelForType(def.type)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <FilterEditor
            def={selected}
            onCancel={() => setSelected(null)}
            onConfirm={(next) => {
              onAddFilter(next);
              close();
            }}
            current={current}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

interface EditorProps {
  def: ChartFilterDefinition;
  onCancel: () => void;
  onConfirm: (next: ActiveChartFilters) => void;
  current: ActiveChartFilters;
}

function FilterEditor({ def, onCancel, onConfirm, current }: EditorProps) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Back to column list"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {labelForType(def.type)}
        </span>
        <span className="text-sm font-medium text-foreground truncate">
          {def.key}
        </span>
      </div>
      <div className="p-3">
        {def.type === "categorical" ? (
          <CategoricalEditor
            def={def}
            current={current}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        ) : def.type === "numeric" ? (
          <NumericEditor
            def={def}
            current={current}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        ) : (
          <DateEditor
            def={def}
            current={current}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        )}
      </div>
    </div>
  );
}

interface SubEditorProps<T extends ChartFilterDefinition> {
  def: T;
  current: ActiveChartFilters;
  onConfirm: (next: ActiveChartFilters) => void;
  onCancel: () => void;
}

function CategoricalEditor({
  def,
  current,
  onConfirm,
  onCancel,
}: SubEditorProps<CategoricalFilterDefinition>) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const visibleOptions = def.options.slice(0, MAX_CATEGORICAL_OPTIONS);
  const moreCount = Math.max(0, def.options.length - visibleOptions.length);
  const toggle = (value: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };
  return (
    <div>
      <div className="max-h-[220px] overflow-y-auto pr-1 space-y-1">
        {visibleOptions.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 px-1 py-0.5 rounded"
          >
            <Checkbox
              checked={selected.has(opt.value)}
              onCheckedChange={() => toggle(opt.value)}
              aria-label={`Toggle ${opt.value}`}
            />
            <span className="flex-1 truncate text-foreground">{opt.value}</span>
            <span className="text-[10px] text-muted-foreground">{opt.count}</span>
          </label>
        ))}
        {moreCount > 0 ? (
          <div className="text-[11px] text-muted-foreground px-1 pt-1">
            + {moreCount} more values not shown
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 px-2 text-xs">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() =>
            onConfirm(addCategoricalFilter(current, def.key, Array.from(selected)))
          }
          className="h-7 px-2 text-xs"
          disabled={selected.size === 0}
        >
          Apply ({selected.size})
        </Button>
      </div>
    </div>
  );
}

function NumericEditor({
  def,
  current,
  onConfirm,
  onCancel,
}: SubEditorProps<NumericFilterDefinition>) {
  const [min, setMin] = useState<string>("");
  const [max, setMax] = useState<string>("");
  const parsedMin = min.trim() === "" ? undefined : Number(min);
  const parsedMax = max.trim() === "" ? undefined : Number(max);
  const isValid =
    (parsedMin === undefined || Number.isFinite(parsedMin)) &&
    (parsedMax === undefined || Number.isFinite(parsedMax)) &&
    (parsedMin !== undefined || parsedMax !== undefined);
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted-foreground">
          Min
          <Input
            type="number"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder={String(def.min)}
            className="h-7 mt-1 text-sm"
            aria-label={`Minimum ${def.key}`}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          Max
          <Input
            type="number"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder={String(def.max)}
            className="h-7 mt-1 text-sm"
            aria-label={`Maximum ${def.key}`}
          />
        </label>
      </div>
      <div className="text-[11px] text-muted-foreground mt-2">
        Observed range: {def.min} → {def.max}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 px-2 text-xs">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onConfirm(addNumericFilter(current, def.key, parsedMin, parsedMax))}
          className="h-7 px-2 text-xs"
          disabled={!isValid}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

function DateEditor({
  def,
  current,
  onConfirm,
  onCancel,
}: SubEditorProps<DateFilterDefinition>) {
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const isValid = !!from || !!to;
  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted-foreground">
          From
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-7 mt-1 text-sm"
            aria-label={`From ${def.key}`}
          />
        </label>
        <label className="text-xs text-muted-foreground">
          To
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-7 mt-1 text-sm"
            aria-label={`To ${def.key}`}
          />
        </label>
      </div>
      <div className="text-[11px] text-muted-foreground mt-2">
        Observed range: {def.min ?? "—"} → {def.max ?? "—"}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 px-2 text-xs">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() =>
            onConfirm(
              addDateFilter(current, def.key, from || undefined, to || undefined),
            )
          }
          className="h-7 px-2 text-xs"
          disabled={!isValid}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

/** Default export not used; named export pattern matches sibling components. */
