import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import type { DashboardScorecardSpec } from "@/shared/schema";
import { formatChartValue } from "@/lib/charts/format";
import { cn } from "@/lib/utils";

/**
 * Wave W7 (data-bound cards) · a single DATA-BOUND KPI scorecard — big current
 * value + period-over-period delta (▲/▼, direction-aware colour) + a mini
 * sparkline. Unlike the legacy free-typed "Key numbers", the number is computed
 * from the dataset; `metricPolarity` decides whether a rise is green or red.
 */

type Tone = "good" | "warn" | "bad" | "neutral";

interface ToneStyle {
  card: string;
  bar: string;
  delta: string;
  spark: string;
}

function toneStyle(tone: Tone): ToneStyle {
  switch (tone) {
    case "good":
      return {
        card: "border-[hsl(var(--success)/0.30)] bg-[hsl(var(--success)/0.06)]",
        bar: "bg-[hsl(var(--success))]",
        delta: "text-[hsl(var(--success))]",
        spark: "hsl(var(--success))",
      };
    case "bad":
      return {
        card: "border-destructive/30 bg-destructive/[0.06]",
        bar: "bg-destructive",
        delta: "text-destructive",
        spark: "hsl(var(--destructive))",
      };
    case "warn":
      return {
        card: "border-amber-500/30 bg-amber-500/[0.06]",
        bar: "bg-amber-500",
        delta: "text-amber-600",
        spark: "hsl(38 92% 50%)",
      };
    default:
      return {
        card: "border-border/60 bg-muted/20",
        bar: "bg-muted-foreground/40",
        delta: "text-muted-foreground",
        spark: "hsl(var(--muted-foreground))",
      };
  }
}

/** Map the scorecard's semantic format onto the universal chart formatter. */
function formatOpts(sc: DashboardScorecardSpec) {
  const f = sc.format;
  const format =
    f === "ratio" ? "percent" : f === "number" || f === undefined ? "kmb" : f;
  return {
    format,
    ...(sc.currencyCode ? { currencySymbol: undefined } : {}),
    precision: sc.decimals ?? 1,
  };
}

/** Delta chip text — percentage points for ratio/percent measures, else % change. */
function deltaText(sc: DashboardScorecardSpec): string | null {
  const s = sc.snapshot;
  if (!s) return null;
  const isPct = sc.format === "percent" || sc.format === "ratio";
  if (isPct) {
    if (s.deltaAbs == null || !Number.isFinite(s.deltaAbs)) return null;
    const sign = s.deltaAbs > 0 ? "+" : "";
    return `${sign}${s.deltaAbs.toFixed(1)}pp`;
  }
  if (s.deltaPct == null || !Number.isFinite(s.deltaPct)) return null;
  const sign = s.deltaPct > 0 ? "+" : "";
  return `${sign}${(s.deltaPct * 100).toFixed(1)}%`;
}

export function DashboardScorecard({ scorecard }: { scorecard: DashboardScorecardSpec }) {
  const s = scorecard.snapshot;
  const tone = toneStyle((s?.tone ?? "neutral") as Tone);
  const value = s?.value;
  const display =
    value == null || !Number.isFinite(value)
      ? "—"
      : formatChartValue(value, scorecard.cardDefinition.measure.ref, formatOpts(scorecard));

  const delta = deltaText(scorecard);
  const dir = s?.deltaPct == null ? 0 : s.deltaPct > 0 ? 1 : s.deltaPct < 0 ? -1 : 0;
  const spark = (s?.sparkline ?? []).filter((p) => Number.isFinite(p.value));

  return (
    <div
      className={cn(
        "relative flex min-h-[104px] flex-col overflow-hidden rounded-brand-md border pl-3 pr-3 pt-2.5 pb-2",
        tone.card
      )}
    >
      <div className={cn("absolute left-0 top-0 h-full w-1", tone.bar)} aria-hidden="true" />
      <div className="truncate text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground">
        {scorecard.title}
      </div>
      <div className="mt-0.5 text-2xl font-semibold leading-tight text-foreground">
        {display}
      </div>
      {delta ? (
        <div className={cn("mt-0.5 flex items-center gap-1 text-xs font-medium", tone.delta)}>
          {dir > 0 ? (
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : dir < 0 ? (
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Minus className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{delta}</span>
          {s?.periodLabel ? (
            <span className="truncate font-normal text-muted-foreground">
              {s.periodLabel}
            </span>
          ) : null}
        </div>
      ) : null}
      {spark.length >= 2 ? (
        <div className="mt-auto h-8 w-full pt-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={spark} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={tone.spark}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : null}
    </div>
  );
}
