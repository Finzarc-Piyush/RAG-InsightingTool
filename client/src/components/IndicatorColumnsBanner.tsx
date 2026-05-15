// SU-UX1 · Surfaced when one or more "indicator" columns are detected on
// the dataset — pre-computed boolean / short-categorical columns that
// directly answer common questions (e.g. a "Clock-In <09:30" column with
// values Yes/No/Absent answers attendance-punctuality questions). Tells
// the user which columns the agent will prefer when a question matches
// the indicator's pre-computed answer shape.
//
// Mirrors DimensionHierarchiesBanner: collapsed default, ✕ Remove button per
// entry powered by PUT /api/sessions/:id/schema-annotations. Removing an
// indicator clears its `indicator` annotation on the dataSummary so the
// agent stops surfacing it as a pre-computed shortcut. To ADD an indicator,
// the user re-states it in chat.

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Loader2,
  X,
} from 'lucide-react';
import type { DataSummary } from '@/shared/schema';
import { sessionsApi } from '@/lib/api';

/** Compact descriptor for what we render — derived from DataSummary.columns. */
export interface IndicatorEntry {
  column: string;
  kind: 'boolean' | 'categorical';
  positiveValues?: string[];
  negativeValues?: string[];
  sentinelValues?: string[];
  source: 'auto' | 'llm' | 'user';
  answersQuestions?: string[];
}

/** Derive entries from a DataSummary; returns empty when no indicators tagged. */
export function indicatorsFromSummary(
  summary: DataSummary | undefined,
): IndicatorEntry[] {
  if (!summary?.columns) return [];
  const out: IndicatorEntry[] = [];
  for (const c of summary.columns) {
    if (!c.indicator) continue;
    out.push({
      column: c.name,
      kind: c.indicator.kind,
      ...(c.indicator.positiveValues
        ? { positiveValues: c.indicator.positiveValues }
        : {}),
      ...(c.indicator.negativeValues
        ? { negativeValues: c.indicator.negativeValues }
        : {}),
      ...(c.indicator.sentinelValues
        ? { sentinelValues: c.indicator.sentinelValues }
        : {}),
      source: c.indicator.source,
      ...(c.answersQuestions ? { answersQuestions: c.answersQuestions } : {}),
    });
  }
  return out;
}

interface Props {
  indicators: IndicatorEntry[];
  /** When present, each entry shows a ✕ Remove button. */
  sessionId?: string;
  /** Called with the new indicator list after a successful remove. */
  onChange?: (next: IndicatorEntry[]) => void;
}

export function IndicatorColumnsBanner({
  indicators,
  sessionId,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [removingColumn, setRemovingColumn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!indicators.length) return null;

  const summary =
    indicators.length === 1
      ? `"${indicators[0].column}" answers a pre-computed question`
      : `${indicators.length} pre-computed indicator columns`;

  const canEdit = !!(sessionId && onChange);

  const handleRemove = async (column: string) => {
    if (!canEdit) return;
    setError(null);
    setRemovingColumn(column);
    try {
      const next = indicators.filter((i) => i.column !== column);
      await sessionsApi.updateSchemaAnnotations(sessionId!, {
        indicators: next.map((i) => ({
          column: i.column,
          kind: i.kind,
          ...(i.positiveValues ? { positiveValues: i.positiveValues } : {}),
          ...(i.negativeValues ? { negativeValues: i.negativeValues } : {}),
          ...(i.sentinelValues ? { sentinelValues: i.sentinelValues } : {}),
        })),
      });
      onChange!(next);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to remove indicator';
      setError(`Could not remove "${column}": ${msg}`);
    } finally {
      setRemovingColumn(null);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
        <div className="flex-1">
          <div className="font-medium text-foreground">
            Pre-computed indicator columns
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {summary} — when a question matches one of these, the agent uses
            the column directly instead of deriving the answer.{' '}
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
              {indicators.map((i) => {
                const removing = removingColumn === i.column;
                const polarity =
                  i.kind === 'boolean'
                    ? `${(i.positiveValues ?? ['Yes']).join('/')} vs ${(
                        i.negativeValues ?? ['No']
                      ).join('/')}`
                    : 'categorical';
                return (
                  <li
                    key={i.column}
                    className="flex items-start justify-between gap-2 text-muted-foreground"
                  >
                    <div className="flex-1">
                      <span className="font-mono text-foreground">
                        {i.column}
                      </span>
                      {' · '}
                      <span>{polarity}</span>
                      {i.sentinelValues?.length ? (
                        <>
                          {' · sentinel: '}
                          <span className="font-mono">
                            {i.sentinelValues.join('/')}
                          </span>
                        </>
                      ) : null}
                      {i.source !== 'user' && (
                        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {i.source}
                        </span>
                      )}
                      {i.answersQuestions?.length ? (
                        <div className="mt-0.5 ml-2 italic text-muted-foreground/80">
                          answers:{' '}
                          {i.answersQuestions
                            .slice(0, 3)
                            .map((q) => `"${q}"`)
                            .join(', ')}
                        </div>
                      ) : null}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleRemove(i.column)}
                        disabled={removing}
                        title={`Remove "${i.column}" indicator`}
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
                  ? 'To add or restate an indicator, type it in chat (e.g. "X is the column for the late-clock-in question").'
                  : 'To change an indicator, restate it in chat.'}
              </li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
