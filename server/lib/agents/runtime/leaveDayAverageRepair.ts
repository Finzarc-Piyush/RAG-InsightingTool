/**
 * ============================================================================
 * leaveDayAverageRepair.ts — working-day-aware per-day AVERAGES (W-LEAVE)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A "per-day average" is `SUM(metric) / COUNT(DISTINCT dateCol)` (the planner's
 *   PD1 ratio shape). When a dataset has a detected structural LEAVE day (e.g.
 *   Sundays ≈0 — see inferLeaveDayPattern), that denominator counts the leave
 *   days too, so the average is divided by CALENDAR days, not WORKING days, and
 *   reads low. This module detects that exact plan shape and — only on the
 *   user's consent — injects a `Day of week · <dateCol> NOT IN (offDays)`
 *   dimensionFilter. The flat WHERE applies it to BOTH the SUM numerator AND the
 *   COUNT(DISTINCT date) denominator, so the result becomes a true working-day
 *   average with no special math (mirrors how booleanIndicatorRateRepair scopes
 *   a boolean rate to its valid universe).
 *
 * SAFETY
 *   Pure. Fires ONLY on the structural per-day-average shape over the SAME date
 *   column the leave-day was detected on, and never when the off-day is already
 *   explicitly sliced (groupBy / an existing day-of-week filter) — i.e. when the
 *   user is intentionally working with that weekday. Gated upstream by the
 *   WORKING_DAY_AVERAGES_ENABLED flag and the user's stored `decision`. The
 *   change is always DISCLOSED in a caveat — never a silent number move.
 */
import type { DataSummary } from "../../../shared/schema.js";
import type { QueryPlanBody } from "../../queryPlanExecutor.js";
import {
  facetColumnKey,
  parseTemporalFacetDisplayKey,
} from "../../temporalFacetColumns.js";
import { formatCompactNumber } from "../../formatCompactNumber.js";
import type { LeaveDayPattern } from "../../inferLeaveDayPattern.js";

type Agg = { column?: string; operation?: string; alias?: string };
type Computed = { alias?: string; expression?: string };
type Filter = { column?: string; op?: string; values?: string[] };

export function leaveDayPatternOf(summary: DataSummary): LeaveDayPattern | null {
  const lp = (summary as { leaveDayPattern?: LeaveDayPattern }).leaveDayPattern;
  return lp && Array.isArray(lp.offWeekdays) && lp.offWeekdays.length > 0 ? lp : null;
}

/** True when the off-weekday is already explicitly sliced — groupBy or a filter
 *  on the day-of-week facet of the SAME date column. Then the user is
 *  intentionally working with that weekday; leave the plan untouched. */
function alreadySlicesDayOfWeek(plan: QueryPlanBody, dateColumn: string): boolean {
  const dowDisplay = facetColumnKey(dateColumn, "day_of_week");
  const refs: Array<string | undefined> = [
    ...((plan.groupBy as string[] | undefined) ?? []),
    ...(((plan.dimensionFilters as Filter[] | undefined) ?? []).map((f) => f.column)),
  ];
  return refs.some((r) => {
    if (!r) return false;
    if (r === dowDisplay) return true;
    const facet = parseTemporalFacetDisplayKey(String(r));
    return facet?.grain === "day_of_week" && facet.sourceColumn === dateColumn;
  });
}

/**
 * Detect a per-day AVERAGE over the detected leave-day date column. Returns the
 * date column + off-weekdays when the plan is `… / COUNT(DISTINCT <leaveDayCol>)`
 * (a ratio, not a standalone day count) and the off-day isn't already sliced;
 * else null. Pure — reads `summary.leaveDayPattern`, does not consider consent.
 */
export function detectLeaveDayAveragePlan(
  plan: QueryPlanBody,
  summary: DataSummary
): { dateColumn: string; offWeekdays: string[] } | null {
  const lp = leaveDayPatternOf(summary);
  if (!lp) return null;
  const dateColumn = lp.dateColumn;
  const aggs = (plan?.aggregations as Agg[] | undefined) ?? [];
  const computed = (plan?.computedAggregations as Computed[] | undefined) ?? [];

  // Denominator: COUNT(DISTINCT <leaveDayCol>) — the "number of days" divisor.
  const denomAliases = aggs
    .filter((a) => a.operation === "count_distinct" && a.column === dateColumn && a.alias)
    .map((a) => a.alias as string);
  if (denomAliases.length === 0) return null;

  // It must be USED as a divisor in a computed ratio (a per-day AVERAGE), not a
  // standalone "how many distinct days?" count — excluding leave days from the
  // latter would wrongly answer a different question.
  const isRatioDenominator = computed.some((c) => {
    const expr = String(c.expression ?? "");
    const parts = expr.split("/").map((p) => p.trim());
    return parts
      .slice(1)
      .some((p) => denomAliases.some((d) => p === d || p.split(/[^A-Za-z0-9_]/).includes(d)));
  });
  if (!isRatioDenominator) return null;

  if (alreadySlicesDayOfWeek(plan, dateColumn)) return null;

  // Never double-inject.
  const dowDisplay = facetColumnKey(dateColumn, "day_of_week");
  const has = ((plan.dimensionFilters as Filter[] | undefined) ?? []).some(
    (f) => f.column === dowDisplay
  );
  if (has) return null;

  return { dateColumn, offWeekdays: [...lp.offWeekdays] };
}

/**
 * Return a NEW plan with a `Day of week · <dateCol> NOT IN (offWeekdays)`
 * dimensionFilter appended. Pure — does not mutate the input.
 */
export function injectLeaveDayExclusion(
  plan: QueryPlanBody,
  dateColumn: string,
  offWeekdays: string[]
): QueryPlanBody {
  const dowDisplay = facetColumnKey(dateColumn, "day_of_week");
  const filters: Filter[] = [
    ...((plan.dimensionFilters as Filter[] | undefined) ?? []),
    { column: dowDisplay, op: "not_in", values: [...offWeekdays] },
  ];
  return { ...plan, dimensionFilters: filters as QueryPlanBody["dimensionFilters"] };
}

/** Human-readable list, e.g. ["Sunday"] → "Sunday", ["Sat","Sun"] → "Saturday and Sunday". */
export function formatWeekdayList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The DISCLOSURE caveat — the "tell + ask" vehicle. `applied` → the average was
 * computed over working days (transparency); otherwise → it still counts all
 * calendar days and we ASK the user to exclude. Always surfaces in the envelope.
 */
export function buildLeaveDayCaveat(
  applied: boolean,
  offWeekdays: string[],
  offMean: number,
  workingMean: number
): string {
  const names = formatWeekdayList(offWeekdays);
  const off = formatCompactNumber(offMean);
  const work = formatCompactNumber(workingMean);
  if (applied) {
    return `Daily averages are computed over WORKING days only — ${names} excluded as a recurring non-working/leave day (averaged ${off} vs ${work} on working days). Reply "include ${offWeekdays[0]}" to count all calendar days instead.`;
  }
  return `This daily average counts all calendar days, including ${names} — which looks like a recurring non-working/leave day (averaged ${off} vs ${work} on working days), so the figure reads low. Reply "exclude ${offWeekdays[0]}" to average over working days only.`;
}

/** A clickable next-step offer (no "or" — suggestedQuestionGuard-safe). */
export function buildLeaveDayOfferCta(offWeekdays: string[]): string {
  return `Recompute daily averages excluding ${formatWeekdayList(offWeekdays)}`;
}

/**
 * W-LEAVE (Wave 3) · should the CHART BUILDER auto-apply the leave-day exclusion
 * to keep an Average consistent with the engine's remembered consent? Only for a
 * mean (a SUM over all days is correct), only when the user set no explicit
 * per-chart exclusion, and only when the dataset's stored decision is "exclude".
 */
export function shouldBuilderExcludeLeaveDays(
  aggregate: string | null | undefined,
  hasExplicitExclusion: boolean,
  leaveDayPattern: { offWeekdays?: string[]; decision?: string } | null | undefined
): boolean {
  return (
    aggregate === "mean" &&
    !hasExplicitExclusion &&
    leaveDayPattern?.decision === "exclude" &&
    (leaveDayPattern.offWeekdays?.length ?? 0) > 0
  );
}

const EXCLUDE_VERB_RE =
  /\b(exclude|excluding|omit|omitting|ignore|ignoring|skip|skipping|without|remove|removing|drop|dropping|leave out|leaving out|don'?t count|do not count|not count)\b/i;
const WORKING_DAY_RE = /\bworking[ -]?days?\b|\bbusiness[ -]?days?\b|\bnon[ -]?working\b/i;
const LEAVE_DAY_RE = /\bleave[ -]?days?\b|\boff[ -]?days?\b|\bweekly off\b/i;
const AVERAGE_RE = /\baverage|\bavg\b|\bmean\b|\bper day\b/i;

/**
 * Lightweight, deterministic detection that the user is asking to AVERAGE OVER
 * WORKING DAYS (consent to exclude the detected leave day). Requires an explicit
 * exclusion verb tied to the off-weekday / leave-day vocabulary, OR a direct
 * "average over working days" phrasing. Does NOT fire for "how many visits on
 * Sunday?" (no exclusion verb) or "exclude Mondays" (not the off-day).
 */
export function questionRequestsLeaveDayExclusion(
  question: string | undefined | null,
  offWeekdays: string[]
): boolean {
  const q = (question ?? "").toLowerCase();
  if (!q) return false;
  const namesOff = offWeekdays.some((w) => q.includes(w.toLowerCase()));
  if (EXCLUDE_VERB_RE.test(q) && (namesOff || LEAVE_DAY_RE.test(q))) return true;
  if (WORKING_DAY_RE.test(q) && AVERAGE_RE.test(q)) return true;
  return false;
}

const INCLUDE_VERB_RE = /\b(include|including|count|counting|keep|keeping)\b/i;
const STOP_EXCLUDING_RE = /\b(don'?t|do not|stop|no longer)\s+(exclude|excluding|omit|omitting|ignore|ignoring|skip|skipping)\b/i;
const ALL_DAYS_RE = /\ball (the )?(calendar )?days\b|\bevery day\b|\bcalendar days\b/i;

/**
 * The REVERSE consent — the user wants averages back over ALL calendar days
 * (undo a prior exclusion). Conservative: only in an averaging context, and only
 * on an explicit include/keep verb tied to the off-day / "all days" vocabulary,
 * or an explicit "stop excluding". Avoids flipping on a plain "count visits on
 * Sunday" data question (no averaging context).
 */
export function questionRequestsAllCalendarDays(
  question: string | undefined | null,
  offWeekdays: string[]
): boolean {
  const q = (question ?? "").toLowerCase();
  if (!q) return false;
  if (STOP_EXCLUDING_RE.test(q)) return true;
  if (!AVERAGE_RE.test(q)) return false;
  // "average over all calendar days" — the all-days phrase alone signals intent.
  if (ALL_DAYS_RE.test(q)) return true;
  const namesOff = offWeekdays.some((w) => q.includes(w.toLowerCase()));
  if (INCLUDE_VERB_RE.test(q) && (namesOff || LEAVE_DAY_RE.test(q))) return true;
  return false;
}
