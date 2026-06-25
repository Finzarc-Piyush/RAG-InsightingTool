import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import type { EnrichmentStep } from '@/lib/api/uploadStatus';
import { categoryForEnrichmentStep, wittyPoolFor } from './wittyCopy';
import { ThinkingPulseIcon, RotatingLine } from './ThinkingPulse';

export function estimateBand(rows: number, cols: number, step?: EnrichmentStep) {
  // PVT6 · recalibrated to observed wall-clock (~15s for a 10k × 44 dataset).
  // Pre-fix: rowTerm capped at 22 alone for any dataset ≥ 10k rows, low band
  // landed at 45-58s — 2-3× over actual. Real measurements skew much lower
  // because the heavy paths (DuckDB materialize, RAG index) are I/O-bound
  // and don't scale linearly with rows. Constants tuned so 10k × 44 → 15-27s.
  const r = Math.max(0, rows);
  const c = Math.max(0, cols);
  const rowTerm = Math.min(7, Math.log10(Math.max(r, 100)) * 1.75);
  const colTerm = Math.min(4, c * 0.06);
  let low = Math.round(5 + rowTerm + colTerm);
  low = Math.max(8, Math.min(low, 35));
  if (step === 'building_context') low = Math.max(7, low - 3);
  if (step === 'persisting') low = Math.max(5, low - 5);
  let high = Math.min(60, low + (step === 'persisting' ? 10 : 12));
  if (high <= low) high = low + 6;
  return { low, high };
}

function formatSeconds(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

export interface DatasetEnrichmentLoaderProps {
  totalRows: number;
  totalColumns: number;
  enrichmentPhase?: 'waiting' | 'enriching';
  enrichmentStep?: EnrichmentStep;
  uploadProgress?: number;
  startedAtMs: number | null;
  inline?: boolean;
}

export function DatasetEnrichmentLoader({
  totalRows,
  totalColumns,
  enrichmentPhase,
  enrichmentStep,
  uploadProgress,
  startedAtMs,
  inline = false,
}: DatasetEnrichmentLoaderProps) {
  const [elapsed, setElapsed] = useState(0);
  const [rotateIndex, setRotateIndex] = useState(0);

  useEffect(() => {
    if (startedAtMs == null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAtMs]);

  const { low, high } = useMemo(
    () => estimateBand(totalRows, totalColumns, enrichmentStep),
    [totalRows, totalColumns, enrichmentStep]
  );

  const takingLong = elapsed > high * 1.5;

  const lines = useMemo(() => {
    if (takingLong) {
      return [
        'Taking a bit longer than usual — richer tables deserve extra care.',
        'Still with you; we are not timing out, just thinking harder.',
      ];
    }
    // Source from the shared, category-matched witty pool (./wittyCopy) so the
    // same large bank powers Enriching, Thinking, and the dashboard build. With
    // no specific step yet, lean on the `profile` bank (first enrichment stage).
    const category = enrichmentStep ? categoryForEnrichmentStep(enrichmentStep) : 'profile';
    return [...wittyPoolFor(category), ...wittyPoolFor('generic').slice(0, 2)];
  }, [enrichmentStep, takingLong]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setRotateIndex((i) => (i + 1) % lines.length);
    }, 5200);
    return () => window.clearInterval(id);
  }, [lines.length]);

  const activeLine = lines[rotateIndex % lines.length] ?? lines[0];

  const progressVisual =
    uploadProgress != null && uploadProgress > 36
      ? Math.min(100, Math.max(0, uploadProgress))
      : null;

  return (
    <div
      className={
        inline
          ? 'overflow-hidden rounded-xl border border-border/80 shadow-lg'
          : 'absolute top-0 left-0 right-0 z-40 overflow-hidden border-b border-border/40 shadow-lg'
      }
    >
      <div className="relative bg-card/70 backdrop-blur-xl">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.55]"
          style={{
            background:
              'radial-gradient(ellipse 120% 80% at 10% -20%, hsl(var(--primary) / 0.14), transparent 50%), radial-gradient(ellipse 90% 70% at 90% 0%, hsl(262 83% 58% / 0.08), transparent 45%), linear-gradient(105deg, transparent 0%, hsl(var(--primary) / 0.06) 48%, transparent 88%)',
          }}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />

        <div className="relative px-4 py-4 sm:px-6 sm:py-4">
          <div className="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
            <ThinkingPulseIcon size="lg" />

            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h3 className="font-serif text-base font-semibold tracking-tight text-foreground sm:text-lg">
                  Enriching your data understanding
                </h3>
                {enrichmentPhase === 'waiting' && (
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Queued
                  </span>
                )}
              </div>

              <RotatingLine line={activeLine} size="lg" className="text-muted-foreground" />

              <p className="text-xs leading-relaxed text-muted-foreground">
                We are improving dataset understanding and preparing suggested analysis questions. You can type below; we will answer after enrichment.
              </p>
            </div>

            <div className="shrink-0 space-y-2 rounded-xl border border-border/80 bg-card/60 px-4 py-3 text-xs text-muted-foreground shadow-sm backdrop-blur-sm sm:min-w-[11rem]">
              <div className="font-medium text-foreground">Typical time</div>
              <div>
                Usually about{' '}
                <span className="tabular-nums font-semibold text-foreground">
                  {low}–{high}s
                </span>
              </div>
              {startedAtMs != null && (
                <div className="tabular-nums text-muted-foreground">So far {formatSeconds(elapsed)}</div>
              )}
              {progressVisual != null && (
                <div className="pt-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted/90">
                    <motion.div
                      className="h-full rounded-full bg-primary/80"
                      initial={false}
                      animate={{ width: `${progressVisual}%` }}
                      transition={{ type: 'spring', stiffness: 120, damping: 22 }}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
