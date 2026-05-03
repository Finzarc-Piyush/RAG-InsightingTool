// H6 + EU1 · Surfaced when one or more dimension hierarchies are declared
// for the current session — values in a column that are category totals
// rolling up the other values in the same column. Two sources:
//   - "user"  · stated in chat ("FEMALE SHOWER GEL is the category")
//   - "auto"  · detected at upload time by `detectRollupHierarchies`
// EU1 adds an inline ✕ Remove button per entry (powered by PUT
// /api/sessions/:id/hierarchies). To ADD a hierarchy, the user re-states
// it in chat — the user-merge LLM extracts it and persists it via the
// H5 chat-flow path; this banner refreshes via `session_context_updated`
// SSE.
//
// Reads from `sessionAnalysisContext.dataset.dimensionHierarchies`.

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  X,
} from 'lucide-react';
import type { DimensionHierarchy } from '@/shared/schema';
import { sessionsApi } from '@/lib/api';

interface Props {
  hierarchies: DimensionHierarchy[];
  /** When present, each entry shows a ✕ Remove button. */
  sessionId?: string;
  /** Called with the new array after a successful remove (optimistic UI). */
  onChange?: (next: DimensionHierarchy[]) => void;
}

export function DimensionHierarchiesBanner({
  hierarchies,
  sessionId,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [removingColumn, setRemovingColumn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!hierarchies.length) return null;

  const summary =
    hierarchies.length === 1
      ? `"${hierarchies[0].rollupValue}" in "${hierarchies[0].column}"`
      : `${hierarchies.length} declared hierarchies`;

  const canEdit = !!(sessionId && onChange);

  const handleRemove = async (column: string, rollupValue: string) => {
    if (!canEdit) return;
    setError(null);
    setRemovingColumn(column);
    try {
      const next = hierarchies.filter(
        (h) => !(h.column === column && h.rollupValue === rollupValue),
      );
      await sessionsApi.updateSessionHierarchies(sessionId!, next);
      onChange!(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to remove hierarchy';
      setError(`Could not remove "${rollupValue}": ${msg}`);
    } finally {
      setRemovingColumn(null);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <GitBranch className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
        <div className="flex-1">
          <div className="font-medium text-foreground">
            Defined dimension hierarchies
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {summary} treated as a category total — auto-excluded from
            peer-comparison breakdowns.{' '}
            <button
              type="button"
              className="inline-flex items-center text-xs underline-offset-2 hover:underline text-foreground/80"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronRight className="mr-0.5 h-3 w-3" />
              )}
              {open ? 'Hide' : 'View'} details
            </button>
          </div>
          {open && (
            <ul className="mt-2 space-y-1.5 rounded border border-border bg-card p-2 text-xs">
              {hierarchies.map((h, i) => {
                const removing = removingColumn === h.column;
                return (
                  <li
                    key={`${h.column}-${i}`}
                    className="flex items-start justify-between gap-2 text-muted-foreground"
                  >
                    <div className="flex-1">
                      <span className="font-mono text-foreground">{h.column}</span>
                      {' · '}
                      <span className="font-mono text-foreground">"{h.rollupValue}"</span>
                      {' is the category total'}
                      {h.source === 'auto' && (
                        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          auto
                        </span>
                      )}
                      {h.itemValues?.length ? (
                        <>
                          {' '}
                          <span className="text-muted-foreground/80">
                            (children:{' '}
                            {h.itemValues.slice(0, 6).join(', ')}
                            {h.itemValues.length > 6 ? ', …' : ''})
                          </span>
                        </>
                      ) : null}
                      {h.description ? (
                        <div className="mt-0.5 ml-2 italic text-muted-foreground/80">
                          {h.description}
                        </div>
                      ) : null}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleRemove(h.column, h.rollupValue)}
                        disabled={removing}
                        title={`Remove "${h.rollupValue}" hierarchy`}
                        className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        {removing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </li>
                );
              })}
              {error && (
                <li className="text-destructive text-[11px]">{error}</li>
              )}
              <li className="pt-1 text-muted-foreground/70">
                {canEdit
                  ? 'To add or restate a hierarchy, type it in chat (e.g. "X is the category, Y and Z are products within it").'
                  : 'To change a hierarchy, restate it in chat (e.g. "X is no longer the category").'}
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
