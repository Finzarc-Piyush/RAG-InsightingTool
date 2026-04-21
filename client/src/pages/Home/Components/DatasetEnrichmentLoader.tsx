import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import type { EnrichmentStep } from '@/lib/api/uploadStatus';

const ROTATING_GENERIC = [
  'Improving understanding of your columns and relationships…',
  'Preparing meaningful analysis questions for you to start with…',
  'Mapping types, grains, and what the numbers might mean…',
  'Composing suggested analysis questions tailored to your fields…',
  'Almost there — polish beats haste.',
];

const ROTATING_BY_STEP: Record<EnrichmentStep, string[]> = {
  inferring_profile: [
    'Reading the shape and intent of your dataset…',
    'Inferring roles for each column — the quiet groundwork…',
    'Naming patterns the way a careful analyst would…',
  ],
  dirty_date_enrichment: [
    'Cleaning date-like strings into stable time signals…',
    'Resolving ambiguous date formats before deeper reasoning…',
    'Normalizing calendar values for reliable trends…',
  ],
  building_context: [
    'Seeding durable context so future answers stay grounded…',
    'Teaching the assistant your domain, one structured pass…',
    'Weaving profile, summary, and question hints into durable context…',
  ],
  persisting: [
    'Writing insights to your session…',
    'Finalizing storage and suggested questions…',
    'Crossing the last mile — persistence, not theatre…',
  ],
};

function estimateBand(rows: number, cols: number, step?: EnrichmentStep) {
  const r = Math.max(0, rows);
  const c = Math.max(0, cols);
  const rowTerm = Math.min(22, Math.log10(Math.max(r, 50)) * 9);
  const colTerm = Math.min(18, c * 0.35);
  let low = Math.round(14 + rowTerm + colTerm);
  low = Math.max(15, Math.min(low, 58));
  if (step === 'building_context') low = Math.max(12, low - 4);
  if (step === 'persisting') low = Math.max(8, low - 8);
  let high = Math.min(95, low + (step === 'persisting' ? 18 : 24));
  if (high <= low) high = low + 12;
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
    if (enrichmentStep && ROTATING_BY_STEP[enrichmentStep]?.length) {
      return [...ROTATING_BY_STEP[enrichmentStep], ...ROTATING_GENERIC.slice(0, 2)];
    }
    return ROTATING_GENERIC;
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
            <div className="relative flex h-14 w-14 shrink-0 items-center justify-center sm:h-16 sm:w-16">
              <motion.div
                className="absolute inset-0 rounded-full border border-primary/20 bg-primary/[0.07]"
                animate={{ scale: [1, 1.06, 1], opacity: [0.85, 1, 0.85] }}
                transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <motion.div
                className="absolute inset-1 rounded-full border border-primary/10"
                style={{ borderStyle: 'dashed' }}
                animate={{ rotate: 360 }}
                transition={{ duration: 28, repeat: Infinity, ease: 'linear' }}
              />
              <motion.div
                className="absolute inset-0 flex items-center justify-center"
                animate={{ rotate: 360 }}
                transition={{ duration: 5, repeat: Infinity, ease: 'linear' }}
              >
                <div className="h-2 w-2 -translate-y-[22px] rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.55)] sm:-translate-y-[26px]" />
              </motion.div>
              <Sparkles className="relative z-10 h-6 w-6 text-primary/90 sm:h-7 sm:w-7" strokeWidth={1.25} />
            </div>

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

              <div className="relative min-h-[2.5rem] text-sm leading-relaxed text-muted-foreground">
                <AnimatePresence mode="wait">
                  <motion.p
                    key={activeLine}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.35 }}
                    className="text-pretty"
                  >
                    {activeLine}
                  </motion.p>
                </AnimatePresence>
              </div>

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
