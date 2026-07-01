import type { DashboardScorecardSpec } from "@/shared/schema";
import { DashboardScorecard } from "./DashboardScorecard";

/**
 * Wave W7 (data-bound cards) · the Executive-Summary KPI scorecard strip — a
 * fixed responsive grid ABOVE the narrative canvas (structured + print-friendly,
 * never dragged into the prose). Gated by `VITE_SCORECARD_EXEC_SUMMARY`.
 */

/** Build-time Vite flag + optional localStorage override (dev/QA). */
export function isScorecardExecSummaryOn(): boolean {
  try {
    const ls =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("scorecard.execSummary")
        : null;
    if (ls === "true") return true;
    if (ls === "false") return false;
  } catch {
    /* private mode — ignore */
  }
  return import.meta.env.VITE_SCORECARD_EXEC_SUMMARY === "true";
}

export function DashboardScorecardRow({
  scorecards,
}: {
  scorecards?: DashboardScorecardSpec[] | null;
}) {
  if (!isScorecardExecSummaryOn()) return null;
  const cards = (scorecards ?? []).filter((s) => !!s && !!s.cardDefinition);
  if (cards.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cards.map((sc) => (
        <DashboardScorecard key={sc.id} scorecard={sc} />
      ))}
    </div>
  );
}
