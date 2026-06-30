/**
 * chartSpecMutations — the single source of truth for the small, subtle spec
 * mutations the parity toolbar performs, so the chat card and the dashboard
 * tile NEVER drift on them (the whole point of the parity effort).
 *
 * The load-bearing one is `coerceMarkType`: switching a bar → line/area must
 * strip the bar-only `barLayout` AND the value-`sort` (a value sort drawn onto
 * a line would pull its points out of chronological order with no visible way
 * to undo it, since the sort control is bar-only). Both surfaces import this.
 */
import type { ChartSpec } from "@/shared/schema";

export type SwitchableMark = "bar" | "line" | "area";
export const SWITCHABLE_MARKS: readonly SwitchableMark[] = ["bar", "line", "area"];

export function isSwitchableMark(t: string): t is SwitchableMark {
  return (SWITCHABLE_MARKS as readonly string[]).includes(t);
}

/**
 * The durable patch both surfaces send when the parity toolbar (or inline
 * limit) mutates a chart view-side: chat → sessionsApi.updateMessageChartSpec,
 * dashboard → dashboardsApi.updateChartInsightOrRecommendation. `limit: null`
 * clears the Top/Bottom-N selection.
 */
export interface ChartSpecPatch {
  type?: SwitchableMark;
  barLayout?: "stacked" | "grouped";
  dataLabels?: boolean;
  limit?: { mode: "top" | "bottom"; n: number } | null;
}

/** Switch a chart's mark, stripping fields that don't survive the transition. */
export function coerceMarkType(spec: ChartSpec, next: SwitchableMark): ChartSpec {
  if (spec.type === next) return spec;
  const out: ChartSpec = { ...spec, type: next };
  if (next !== "bar") {
    delete out.barLayout;
    delete out.sort;
  }
  return out;
}
