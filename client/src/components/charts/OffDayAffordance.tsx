/**
 * OffDayAffordance — non-blocking "exclude the off-day?" offer for a daily
 * date-axis chart whose recurring near-zero weekday (e.g. every Sunday) was
 * detected server-side (`offDayHint`). The chart renders with ALL days; this
 * pill offers a one-click switch to working days only. Two states:
 *
 *   1. offer    — "Sunday looks like a recurring off-day (…)" + Exclude / Keep all
 *   2. excluded — "Excluded Sunday from this chart" + Apply to all charts / Undo
 *
 * Pure / presentational — the parent owns the exclude/regenerate + session
 * escalation. Mounts in chart WRAPPERS only (ChartBuilderDialog preview,
 * InteractiveChartCard); never inside the frozen v1 renderers.
 */
import { CalendarOff, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

export interface OffDayAffordanceProps {
  /** Detected off-day weekday name(s), e.g. ["Sunday"]. Empty hides the offer. */
  offWeekdays: string[];
  /** One-line comparison, e.g. "Sunday averages 0 vs 4.2K on other days". */
  summary?: string;
  /** Whether this chart currently excludes the off-day(s). */
  excluded: boolean;
  /** A session-wide exclusion chip already owns this weekday. */
  appliedToAll?: boolean;
  /** A request is in flight (disables the buttons). */
  busy?: boolean;
  onExclude: () => void;
  onKeepAll: () => void;
  /** Optional escalation to a session-wide exclusion (hidden when absent). */
  onApplyToAll?: () => void;
  onUndo: () => void;
  className?: string;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const PILL =
  "flex flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1.5 text-[11px]";
const CHIP_BTN =
  "inline-flex items-center rounded border border-primary/30 bg-card px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50";
const GHOST_BTN =
  "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/10 disabled:opacity-50";

export function OffDayAffordance({
  offWeekdays,
  summary,
  excluded,
  appliedToAll,
  busy,
  onExclude,
  onKeepAll,
  onApplyToAll,
  onUndo,
  className,
}: OffDayAffordanceProps) {
  if (!offWeekdays.length && !excluded) return null;
  const names = joinNames(offWeekdays);

  if (excluded) {
    return (
      <div role="region" aria-label="Off-day exclusion" className={cn(PILL, className)}>
        <CalendarOff className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
        {appliedToAll ? (
          <span className="font-medium text-foreground/80">
            {names} excluded across this session
          </span>
        ) : (
          <>
            <span className="font-medium text-foreground/80">
              Excluded {names} from this chart
            </span>
            {onApplyToAll ? (
              <button type="button" onClick={onApplyToAll} disabled={busy} className={CHIP_BTN}>
                Apply to all charts
              </button>
            ) : null}
            <button type="button" onClick={onUndo} disabled={busy} className={GHOST_BTN}>
              <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
              Undo
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div role="region" aria-label="Off-day detected" className={cn(PILL, className)}>
      <CalendarOff className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
      <span className="font-medium text-foreground/80">
        {names} {offWeekdays.length === 1 ? "looks" : "look"} like a recurring off-day
        {summary ? ` (${summary})` : ""}
      </span>
      <button type="button" onClick={onExclude} disabled={busy} className={CHIP_BTN}>
        Exclude {names}
      </button>
      <button type="button" onClick={onKeepAll} disabled={busy} className={GHOST_BTN}>
        Keep all days
      </button>
    </div>
  );
}
