// SU-UX1 · Surfaced when one or more (date column, time-of-day column) pairs
// are declared for the current session. Tells the user the system knows the
// time column carries the time component for the date column on the same
// row, so analyses that need a combined datetime ("earliest weekday clock-in
// by region", "% of late check-ins on Mondays") can compose the two halves
// via SU-DT2's add_computed_columns.datetime_concat.
//
// Mirrors DimensionHierarchiesBanner: collapsed default, ✕ Remove button per
// entry powered by PUT /api/sessions/:id/schema-annotations. To ADD a pair,
// the user re-states it in chat (the user-merge LLM extracts it).

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  X,
} from 'lucide-react';
import type { DateTimeColumnPair } from '@/shared/schema';
import { sessionsApi } from '@/lib/api';

interface Props {
  pairs: DateTimeColumnPair[];
  /** When present, each entry shows a ✕ Remove button. */
  sessionId?: string;
  /** Called with the new array after a successful remove (optimistic UI). */
  onChange?: (next: DateTimeColumnPair[]) => void;
}

export function DateTimePairsBanner({ pairs, sessionId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [removingTime, setRemovingTime] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!pairs.length) return null;

  const summary =
    pairs.length === 1
      ? `"${pairs[0].timeColumn}" pairs with "${pairs[0].dateColumn}"`
      : `${pairs.length} date×time pairings`;

  const canEdit = !!(sessionId && onChange);

  const handleRemove = async (timeColumn: string) => {
    if (!canEdit) return;
    setError(null);
    setRemovingTime(timeColumn);
    try {
      const next = pairs.filter((p) => p.timeColumn !== timeColumn);
      await sessionsApi.updateSchemaAnnotations(sessionId!, {
        dateTimeColumnPairs: next,
      });
      onChange!(next);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to remove pairing';
      setError(`Could not remove "${timeColumn}": ${msg}`);
    } finally {
      setRemovingTime(null);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
        <div className="flex-1">
          <div className="font-medium text-foreground">
            Date × time pairings
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {summary} — analyses can combine them into a single datetime when
            needed.{' '}
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
              {pairs.map((p, i) => {
                const removing = removingTime === p.timeColumn;
                return (
                  <li
                    key={`${p.timeColumn}-${i}`}
                    className="flex items-start justify-between gap-2 text-muted-foreground"
                  >
                    <div className="flex-1">
                      <span className="font-mono text-foreground">
                        {p.timeColumn}
                      </span>
                      {' ↔ '}
                      <span className="font-mono text-foreground">
                        {p.dateColumn}
                      </span>
                      {p.source === 'auto' && (
                        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          auto
                        </span>
                      )}
                      {p.description ? (
                        <div className="mt-0.5 ml-2 italic text-muted-foreground/80">
                          {p.description}
                        </div>
                      ) : null}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleRemove(p.timeColumn)}
                        disabled={removing}
                        title={`Remove "${p.timeColumn}" ↔ "${p.dateColumn}" pairing`}
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
                  ? 'To add a pairing, type it in chat (e.g. "Clock-In Time goes with Day Date").'
                  : 'To change a pairing, restate it in chat.'}
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
