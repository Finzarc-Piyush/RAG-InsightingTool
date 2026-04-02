import { useEffect, useState } from 'react';
import { Filter, Loader2 } from 'lucide-react';
import { fetchPivotColumnDistincts } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { FilterSelections } from '@/lib/pivot/types';

type PivotHeaderSliceFilterProps = {
  field: string;
  ariaLabel: string;
  sessionId: string | null;
  filterSelections: FilterSelections;
  onSliceChange: (field: string, next: Set<string>) => void;
  /** Seed options when session fetch is unavailable (e.g. current pivot column keys). */
  seedValues?: string[];
};

export function PivotHeaderSliceFilter({
  field,
  ariaLabel,
  sessionId,
  filterSelections,
  onSliceChange,
  seedValues,
}: PivotHeaderSliceFilterProps) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (seedValues && seedValues.length > 0) {
      setOptions([...new Set(seedValues)].sort());
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (!sessionId) {
      setOptions([]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    void (async () => {
      try {
        const vals = await fetchPivotColumnDistincts(sessionId, field, 2000);
        if (!cancelled) setOptions(vals);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, field, seedValues]);

  const selected = filterSelections[field];
  const effectiveSel = selected ?? new Set(options);

  const toggle = (v: string, checked: boolean) => {
    const base = selected ? new Set(selected) : new Set(options);
    if (checked) base.add(v);
    else base.delete(v);
    onSliceChange(field, base);
  };

  const selectAll = () => {
    onSliceChange(field, new Set(options));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded p-0.5 text-gray-500 hover:text-gray-900 hover:bg-gray-200/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-label={ariaLabel}
        >
          <Filter className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        {loading ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : options.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2 px-1">No values to filter.</p>
        ) : (
          <div className="space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-start text-xs"
              onClick={selectAll}
            >
              Select all
            </Button>
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {options.map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-2 text-xs cursor-pointer"
                >
                  <Checkbox
                    checked={effectiveSel.has(opt)}
                    onCheckedChange={(c) => toggle(opt, c === true)}
                  />
                  <span className="truncate">{opt || '(blank)'}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
