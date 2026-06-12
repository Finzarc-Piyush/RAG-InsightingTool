import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Database,
  Hash,
  CalendarDays,
  Tags,
  ToggleRight,
  Search,
  AlertTriangle,
  Loader2,
  Fingerprint,
  Sigma,
  Layers,
} from 'lucide-react';
import {
  dataApi,
  type RichDataSummaryResponse,
  type RichColumnProfile,
  type NumericColumnProfile,
  type DateColumnProfile,
  type CategoricalColumnProfile,
  type ColumnKind,
} from '@/lib/api/data';
import { useToast } from '@/hooks/use-toast';
import { AvailableModelsDialog } from '@/components/AvailableModelsDialog';
import { logger } from "@/lib/logger";

interface DataSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string | null;
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

function fmtNum(n: number | null | undefined, currency?: string | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  let body: string;
  if (abs >= 1000 || Number.isInteger(n)) {
    body = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } else if (abs >= 1) {
    body = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } else if (abs > 0) {
    body = n.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  } else {
    body = '0';
  }
  return currency ? `${currency}${body}` : body;
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function humanizeSpan(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return '—';
  if (days <= 0) return 'Single day';
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const rest = Math.floor((days % 365) % 30);
  const parts: string[] = [];
  if (years) parts.push(`${years}y`);
  if (months) parts.push(`${months}mo`);
  if (!years && rest) parts.push(`${rest}d`);
  return parts.length ? parts.join(' ') : `${days}d`;
}

const GRAIN_LABEL: Record<string, string> = {
  dayOrWeek: 'Daily / weekly',
  monthOrQuarter: 'Monthly / quarterly',
  year: 'Yearly',
};

/* ------------------------------------------------------------------ *
 * Per-kind visual identity
 * ------------------------------------------------------------------ */

interface KindStyle {
  label: string;
  Icon: typeof Hash;
  text: string;
  soft: string;
  bar: string;
}

const KIND_STYLE: Record<ColumnKind, KindStyle> = {
  numeric: {
    label: 'Numeric',
    Icon: Hash,
    text: 'text-emerald-600 dark:text-emerald-400',
    soft: 'bg-emerald-500/10',
    bar: 'bg-emerald-500',
  },
  date: {
    label: 'Date',
    Icon: CalendarDays,
    text: 'text-violet-600 dark:text-violet-400',
    soft: 'bg-violet-500/10',
    bar: 'bg-violet-500',
  },
  categorical: {
    label: 'Categorical',
    Icon: Tags,
    text: 'text-amber-600 dark:text-amber-400',
    soft: 'bg-amber-500/10',
    bar: 'bg-amber-500',
  },
  boolean: {
    label: 'Yes / No',
    Icon: ToggleRight,
    text: 'text-sky-600 dark:text-sky-400',
    soft: 'bg-sky-500/10',
    bar: 'bg-sky-500',
  },
};

/* ------------------------------------------------------------------ *
 * Small presentational pieces
 * ------------------------------------------------------------------ */

function StatTile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-lg font-semibold tabular-nums ${
          accent ? 'text-primary' : 'text-foreground'
        }`}
        title={value}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** Responsive bar chart from raw counts (histogram / timeline). */
function BarChart({
  values,
  barClass,
  startLabel,
  endLabel,
  height = 132,
}: {
  values: number[];
  barClass: string;
  startLabel?: string;
  endLabel?: string;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {values.map((v, i) => (
          <div
            key={i}
            className={`flex-1 rounded-t-sm ${barClass} transition-all`}
            style={{ height: `${Math.max(2, (v / max) * 100)}%`, opacity: v === 0 ? 0.25 : 1 }}
            title={`${v.toLocaleString()}`}
          />
        ))}
      </div>
      {(startLabel || endLabel) && (
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
          <span className="truncate">{startLabel}</span>
          <span className="truncate text-right">{endLabel}</span>
        </div>
      )}
    </div>
  );
}

/** Tiny inline sparkline for the column rail. */
function Sparkline({ values, barClass }: { values: number[]; barClass: string }) {
  if (!values.length) return <div className="h-6 w-16" />;
  const max = Math.max(1, ...values);
  const shown = values.slice(0, 16);
  return (
    <div className="flex h-6 w-16 items-end gap-[1px]">
      {shown.map((v, i) => (
        <div
          key={i}
          className={`flex-1 rounded-[1px] ${barClass}`}
          style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: 0.85 }}
        />
      ))}
    </div>
  );
}

/** Five-number-summary box plot positioned across [min, max]. */
function BoxPlot({ profile }: { profile: NumericColumnProfile }) {
  const { min, max, q1, q3, median } = profile;
  if (min === null || max === null || q1 === null || q3 === null || median === null || max === min) {
    return null;
  }
  const span = max - min;
  const pos = (v: number) => ((v - min) / span) * 100;
  return (
    <div>
      <div className="relative h-9">
        {/* whisker line */}
        <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-border" />
        {/* box q1..q3 */}
        <div
          className="absolute top-1/2 h-6 -translate-y-1/2 rounded-sm bg-emerald-500/25 ring-1 ring-emerald-500/60"
          style={{ left: `${pos(q1)}%`, width: `${Math.max(1, pos(q3) - pos(q1))}%` }}
        />
        {/* median */}
        <div
          className="absolute top-1/2 h-6 w-0.5 -translate-y-1/2 bg-emerald-600 dark:bg-emerald-400"
          style={{ left: `${pos(median)}%` }}
        />
        {/* min / max caps */}
        <div className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-muted-foreground" style={{ left: 0 }} />
        <div className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-muted-foreground" style={{ right: 0 }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{fmtNum(min, profile.currencySymbol)}</span>
        <span>Q1 {fmtNum(q1, profile.currencySymbol)}</span>
        <span>Med {fmtNum(median, profile.currencySymbol)}</span>
        <span>Q3 {fmtNum(q3, profile.currencySymbol)}</span>
        <span>{fmtNum(max, profile.currencySymbol)}</span>
      </div>
    </div>
  );
}

function CompletenessRing({ pct, accent }: { pct: number; accent: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} className="fill-none stroke-muted" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          className={`fill-none ${accent}`}
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums text-foreground">
        {Math.round(pct)}%
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Quality callout chips per column
 * ------------------------------------------------------------------ */

function qualityFlags(col: RichColumnProfile): Array<{ tone: 'warn' | 'info'; text: string }> {
  const flags: Array<{ tone: 'warn' | 'info'; text: string }> = [];
  if (col.nullPct >= 1) {
    flags.push({
      tone: col.nullPct >= 20 ? 'warn' : 'info',
      text: `${fmtPct(col.nullPct)} missing`,
    });
  }
  if (col.kind === 'numeric') {
    if (col.outlierCount > 0) flags.push({ tone: 'info', text: `${fmtInt(col.outlierCount)} outliers` });
    if (col.nonNumericCount > 0)
      flags.push({ tone: 'warn', text: `${fmtInt(col.nonNumericCount)} non-numeric` });
  }
  if (col.kind === 'date' && col.unparseableCount > 0) {
    flags.push({ tone: 'warn', text: `${fmtInt(col.unparseableCount)} unparseable` });
  }
  if (col.kind === 'categorical' || col.kind === 'boolean') {
    if (col.isConstant) flags.push({ tone: 'warn', text: 'Constant' });
    if (col.isLikelyId) flags.push({ tone: 'info', text: 'Likely identifier' });
    else if (col.isHighCardinality) flags.push({ tone: 'info', text: 'High cardinality' });
  }
  return flags;
}

function FlagChips({ col }: { col: RichColumnProfile }) {
  const flags = qualityFlags(col);
  if (!flags.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {flags.map((f, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            f.tone === 'warn'
              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {f.tone === 'warn' ? <AlertTriangle className="h-3 w-3" /> : null}
          {f.text}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Detail panels per kind
 * ------------------------------------------------------------------ */

function NumericDetail({ col }: { col: NumericColumnProfile }) {
  const cur = col.currencySymbol;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Mean" value={fmtNum(col.mean, cur)} accent />
        <StatTile label="Median" value={fmtNum(col.median, cur)} />
        <StatTile label="Std dev" value={fmtNum(col.std, cur)} />
        <StatTile label="Min" value={fmtNum(col.min, cur)} />
        <StatTile label="Max" value={fmtNum(col.max, cur)} />
        <StatTile label="Range" value={fmtNum(col.range, cur)} />
        <StatTile label="Sum" value={fmtNum(col.sum, cur)} />
        <StatTile label="Distinct" value={fmtInt(col.distinctCount)} />
      </div>

      <section className="rounded-lg border border-border/60 bg-card/40 p-4">
        <h4 className="mb-3 text-sm font-semibold text-foreground">Distribution</h4>
        {col.histogram.length ? (
          <BarChart
            values={col.histogram.map((b) => b.count)}
            barClass={KIND_STYLE.numeric.bar}
            startLabel={fmtNum(col.min, cur)}
            endLabel={fmtNum(col.max, cur)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Not enough values to chart.</p>
        )}
        <div className="mt-4">
          <BoxPlot profile={col} />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Q1 (25%)" value={fmtNum(col.q1, cur)} />
        <StatTile label="Q3 (75%)" value={fmtNum(col.q3, cur)} />
        <StatTile label="P5" value={fmtNum(col.p5, cur)} />
        <StatTile label="P95" value={fmtNum(col.p95, cur)} />
        <StatTile label="Skewness" value={fmtNum(col.skewness)} hint={skewHint(col.skewness)} />
        <StatTile label="Coeff. of var." value={col.cv === null ? '—' : fmtNum(col.cv)} />
        <StatTile label="Zeros" value={fmtInt(col.zeroCount)} />
        <StatTile label="Negatives" value={fmtInt(col.negativeCount)} />
      </div>
    </div>
  );
}

function skewHint(s: number | null): string | undefined {
  if (s === null) return undefined;
  if (Math.abs(s) < 0.5) return 'Roughly symmetric';
  return s > 0 ? 'Right-skewed' : 'Left-skewed';
}

function DateDetail({ col }: { col: DateColumnProfile }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Earliest" value={col.minIso ?? '—'} accent />
        <StatTile label="Latest" value={col.maxIso ?? '—'} accent />
        <StatTile label="Time span" value={humanizeSpan(col.spanDays)} />
        <StatTile label="Distinct days" value={fmtInt(col.distinctDayCount)} />
        <StatTile label="Granularity" value={col.grain ? GRAIN_LABEL[col.grain] : '—'} />
        <StatTile label="Filled" value={fmtPct(col.completeness)} />
      </div>

      <section className="rounded-lg border border-border/60 bg-card/40 p-4">
        <h4 className="mb-3 text-sm font-semibold text-foreground">Records over time</h4>
        {col.timeline.length ? (
          <BarChart
            values={col.timeline.map((t) => t.count)}
            barClass={KIND_STYLE.date.bar}
            startLabel={col.timeline[0]?.label}
            endLabel={col.timeline[col.timeline.length - 1]?.label}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No parseable dates to chart.</p>
        )}
      </section>
    </div>
  );
}

function CategoricalDetail({ col }: { col: CategoricalColumnProfile }) {
  const isBool = col.kind === 'boolean';
  const top = col.topValues;
  const maxCount = Math.max(1, ...top.map((t) => t.count));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile label="Distinct values" value={fmtInt(col.distinctCount)} accent />
        <StatTile label="Most common" value={col.mode === null ? '—' : String(col.mode)} />
        <StatTile label="Top share" value={fmtPct(top[0]?.pct ?? null)} />
        <StatTile
          label="Uniqueness"
          value={fmtPct(col.cardinalityRatio * 100)}
          hint="distinct ÷ filled"
        />
        {col.avgLength !== null && (
          <StatTile label="Avg length" value={`${col.avgLength} chars`} />
        )}
        <StatTile label="Filled" value={fmtPct(col.completeness)} />
      </div>

      {isBool && (col.positiveValues?.length || col.negativeValues?.length) ? (
        <div className="flex flex-wrap gap-2">
          {col.positiveValues?.map((v) => (
            <Badge key={`p-${v}`} className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
              ✓ {v}
            </Badge>
          ))}
          {col.negativeValues?.map((v) => (
            <Badge key={`n-${v}`} variant="outline">
              ✗ {v}
            </Badge>
          ))}
        </div>
      ) : null}

      <section className="rounded-lg border border-border/60 bg-card/40 p-4">
        <h4 className="mb-3 text-sm font-semibold text-foreground">
          Top {top.length} value{top.length === 1 ? '' : 's'}
          <span className="ml-2 font-normal text-muted-foreground">
            of {fmtInt(col.distinctCount)} distinct
          </span>
        </h4>
        <div className="space-y-2">
          {top.map((t, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-40 shrink-0 truncate text-sm text-foreground" title={String(t.value)}>
                {String(t.value)}
              </div>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className={`h-full rounded ${col.kind === 'boolean' ? KIND_STYLE.boolean.bar : KIND_STYLE.categorical.bar}`}
                  style={{ width: `${Math.max(2, (t.count / maxCount) * 100)}%` }}
                />
              </div>
              <div className="w-28 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                {fmtInt(t.count)} · {fmtPct(t.pct)}
              </div>
            </div>
          ))}
          {col.otherCount > 0 && (
            <div className="flex items-center gap-3 pt-1 text-sm text-muted-foreground">
              <div className="w-40 shrink-0 truncate italic">Other</div>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded bg-muted-foreground/40"
                  style={{ width: `${Math.max(2, (col.otherCount / maxCount) * 100)}%` }}
                />
              </div>
              <div className="w-28 shrink-0 text-right tabular-nums">
                {fmtInt(col.otherCount)} · {fmtPct(col.otherPct)}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rail sparkline source values
 * ------------------------------------------------------------------ */

function railSpark(col: RichColumnProfile): number[] {
  if (col.kind === 'numeric') return col.histogram.map((b) => b.count);
  if (col.kind === 'date') return col.timeline.map((t) => t.count);
  return col.topValues.map((t) => t.count);
}

function categoricalKind(k: ColumnKind): boolean {
  return k === 'categorical' || k === 'boolean';
}

/* ------------------------------------------------------------------ *
 * Main modal
 * ------------------------------------------------------------------ */

type TypeFilter = 'all' | 'numeric' | 'date' | 'categorical';

export function DataSummaryModal({ isOpen, onClose, sessionId }: DataSummaryModalProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<RichDataSummaryResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const { toast } = useToast();

  useEffect(() => {
    if (isOpen && sessionId) {
      void loadSummary(sessionId);
    } else {
      setData(null);
      setSelected(null);
      setSearch('');
      setTypeFilter('all');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId]);

  const loadSummary = async (sid: string) => {
    setLoading(true);
    try {
      const res = await dataApi.getDataSummary(sid);
      setData(res);
      setSelected(res.columns[0]?.name ?? null);
    } catch (error) {
      logger.error('Failed to load data summary:', error);
      toast({
        title: 'Error',
        description: 'Failed to load data summary. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.columns.filter((c) => {
      if (q && !c.name.toLowerCase().includes(q)) return false;
      if (typeFilter === 'all') return true;
      if (typeFilter === 'categorical') return categoricalKind(c.kind);
      return c.kind === typeFilter;
    });
  }, [data, search, typeFilter]);

  // Keep a valid selection as filters change.
  useEffect(() => {
    if (!filtered.length) return;
    if (!selected || !filtered.some((c) => c.name === selected)) {
      setSelected(filtered[0].name);
    }
  }, [filtered, selected]);

  const selectedCol = useMemo(
    () => data?.columns.find((c) => c.name === selected) ?? null,
    [data, selected],
  );

  const ds = data?.dataset;
  const catCount = ds ? ds.typeBreakdown.categorical + ds.typeBreakdown.boolean : 0;

  const filterPills: Array<{ key: TypeFilter; label: string; count: number }> = ds
    ? [
        { key: 'all', label: 'All', count: ds.columnCount },
        { key: 'numeric', label: 'Numeric', count: ds.typeBreakdown.numeric },
        { key: 'date', label: 'Date', count: ds.typeBreakdown.date },
        { key: 'categorical', label: 'Categorical', count: catCount },
      ]
    : [];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[95vh] max-h-[95vh] w-[95vw] max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Database className="h-5 w-5 text-primary" />
            Data Summary
          </DialogTitle>
          <DialogDescription className="sr-only">
            Type-aware profile of every column in your dataset
          </DialogDescription>

          {ds && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <HeroChip icon={<Layers className="h-3.5 w-3.5" />} label="Rows" value={fmtInt(ds.rowCount)} />
              <HeroChip icon={<Sigma className="h-3.5 w-3.5" />} label="Columns" value={fmtInt(ds.columnCount)} />
              <TypeChip kind="numeric" count={ds.typeBreakdown.numeric} />
              <TypeChip kind="date" count={ds.typeBreakdown.date} />
              <TypeChip kind="categorical" count={catCount} />
              {ds.duplicateRowCount && ds.duplicateRowCount > 0 ? (
                <HeroChip
                  icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                  label="Duplicate rows"
                  value={fmtInt(ds.duplicateRowCount)}
                />
              ) : null}
              {data?.sampling?.sampled ? (
                <HeroChip
                  icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                  label="Profiled on sample"
                  value={`${fmtInt(data.sampling.profiledRowCount)} of ${fmtInt(data.sampling.totalRowCount)}`}
                />
              ) : null}
              <div className="ml-auto flex items-center gap-2 rounded-full bg-muted px-3 py-1">
                <span className="text-xs text-muted-foreground">Complete</span>
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {fmtPct(ds.overallCompleteness)}
                </span>
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-border">
                  <div
                    className={`h-full rounded-full ${
                      ds.overallCompleteness >= 90
                        ? 'bg-emerald-500'
                        : ds.overallCompleteness >= 70
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                    }`}
                    style={{ width: `${ds.overallCompleteness}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : !data || data.columns.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            No columns to summarise for this dataset.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Column navigator */}
            <aside className="flex w-[320px] shrink-0 flex-col border-r border-border">
              <div className="space-y-2 border-b border-border p-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search columns…"
                    className="pl-8"
                  />
                </div>
                <div className="flex flex-wrap gap-1">
                  {filterPills.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setTypeFilter(p.key)}
                      className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                        typeFilter === p.key
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-muted/70'
                      }`}
                    >
                      {p.label} <span className="opacity-70">{p.count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2">
                  {filtered.map((col) => {
                    const style = KIND_STYLE[col.kind];
                    const Icon = style.Icon;
                    const active = col.name === selected;
                    return (
                      <button
                        key={col.name}
                        type="button"
                        onClick={() => setSelected(col.name)}
                        className={`mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                          active ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-muted/60'
                        }`}
                      >
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${style.soft} ${style.text}`}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {col.name}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5">
                            <span className="h-1 w-16 overflow-hidden rounded-full bg-border">
                              <span
                                className={`block h-full rounded-full ${style.bar}`}
                                style={{ width: `${col.completeness}%` }}
                              />
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {col.nullPct > 0 ? `${fmtPct(col.nullPct)} null` : 'complete'}
                            </span>
                          </span>
                        </span>
                        <Sparkline values={railSpark(col)} barClass={style.bar} />
                      </button>
                    );
                  })}
                  {filtered.length === 0 && (
                    <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                      No columns match.
                    </p>
                  )}
                </div>
              </ScrollArea>
            </aside>

            {/* Detail */}
            <ScrollArea className="min-w-0 flex-1">
              {selectedCol ? (
                <div className="space-y-5 p-6">
                  <ColumnHeader col={selectedCol} />
                  <FlagChips col={selectedCol} />
                  {selectedCol.kind === 'numeric' && <NumericDetail col={selectedCol} />}
                  {selectedCol.kind === 'date' && <DateDetail col={selectedCol} />}
                  {categoricalKind(selectedCol.kind) && (
                    <CategoricalDetail col={selectedCol as CategoricalColumnProfile} />
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Select a column to view its profile.
                </div>
              )}
            </ScrollArea>
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between border-t border-border px-6 py-2.5">
          <p className="text-xs text-muted-foreground">
            Statistics reflect the current working dataset, by column type.
          </p>
          <AvailableModelsDialog triggerLabel="ML model catalog" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HeroChip({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1">
      {icon}
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function TypeChip({ kind, count }: { kind: ColumnKind; count: number }) {
  const style = KIND_STYLE[kind];
  const Icon = style.Icon;
  return (
    <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 ${style.soft}`}>
      <Icon className={`h-3.5 w-3.5 ${style.text}`} />
      <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{count}</span>
    </div>
  );
}

function ColumnHeader({ col }: { col: RichColumnProfile }) {
  const style = KIND_STYLE[col.kind];
  const Icon = style.Icon;
  return (
    <div className="flex items-start gap-4">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${style.soft} ${style.text}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-xl font-semibold text-foreground" title={col.name}>
            {col.name}
          </h3>
          <Badge variant="outline" className={style.text}>
            {style.label}
          </Badge>
          <Badge variant="secondary">{col.datatypeLabel}</Badge>
          {(col.kind === 'categorical' || col.kind === 'boolean') && col.isLikelyId ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Fingerprint className="h-3.5 w-3.5" /> identifier-like
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {fmtInt(col.totalValues)} values · {fmtInt(col.distinctCount)} distinct ·{' '}
          {fmtInt(col.nullCount)} missing
        </p>
      </div>
      <CompletenessRing pct={col.completeness} accent={style.text} />
    </div>
  );
}
