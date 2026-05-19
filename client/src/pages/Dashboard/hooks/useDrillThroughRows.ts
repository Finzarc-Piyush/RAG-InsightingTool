/**
 * Wave WD3-sheet-fetch · React Query hook that fetches the underlying
 * rows for a drill-through request.
 *
 * Pairs with the WD3-server endpoint at
 * `POST /api/dashboards/:id/drill?chartId=&column=&value=`. Query body
 * carries `{ filters, extraPins }`. Response shape matches
 * `DrillThroughResponse` from the server service module
 * (`server/services/dashboardDrillThrough.service.ts`) byte-for-byte
 * so the consumer can `data` directly without transformation.
 *
 * `enabled: !!event` keeps the fetch idle when no drill is active —
 * the sheet renders nothing in that case anyway. queryKey serialises
 * the entire event payload (chartId / column / value / extraPins /
 * filters) so two distinct drill requests (e.g. different cell clicks
 * on a heatmap) get distinct cache slots; TanStack Query's
 * stale-while-revalidate covers re-opens.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  DrillThroughEvent,
  DrillThroughPin,
} from "../lib/drillThrough";

/** Server-side `DrillThroughResponse` shape (mirror of the service module). */
export interface DrillThroughResponse {
  rows: Array<Record<string, unknown>>;
  /** Total rows matched BEFORE the row cap. */
  totalMatched: number;
  /** True iff `totalMatched > rows.length`. */
  capApplied: boolean;
  chart: { title: string; tileId: string };
}

export interface UseDrillThroughRowsArgs {
  dashboardId: string;
  /** The active drill event; `null` keeps the query idle. */
  event: DrillThroughEvent | null;
}

/**
 * Fetch the underlying rows for a drill request via the WD3-server
 * endpoint. Returns a stock TanStack-Query result so consumers can
 * read `isLoading` / `error` / `data` without an extra layer.
 */
export function useDrillThroughRows({
  dashboardId,
  event,
}: UseDrillThroughRowsArgs): UseQueryResult<DrillThroughResponse, Error> {
  return useQuery<DrillThroughResponse, Error>({
    queryKey: [
      "drill",
      dashboardId,
      event?.chartId ?? "",
      event?.column ?? "",
      // Stringify the dynamic-typed value so the queryKey is
      // serialisable. `null`/`undefined` collapse to the literal
      // string "null" matching the server's stringifyForComparison.
      stringifyForKey(event?.value),
      JSON.stringify(event?.extraPins ?? []),
      JSON.stringify(event?.filters ?? {}),
    ],
    queryFn: async () => {
      if (!event) throw new Error("no_active_drill_event");
      const url = new URL(
        `/api/dashboards/${encodeURIComponent(dashboardId)}/drill`,
        window.location.origin,
      );
      url.searchParams.set("chartId", event.chartId);
      url.searchParams.set("column", event.column);
      // Value canonicalised the same way as the server-side
      // stringifyForComparison so the queryKey matches the wire-form
      // primary pin: null / undefined → "null"; Date → ISO; other →
      // String(v).
      url.searchParams.set("value", stringifyForKey(event.value));
      const response = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: event.filters ?? {},
          extraPins: (event.extraPins ?? []) as DrillThroughPin[],
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`drill_failed:${response.status}:${text}`);
      }
      return (await response.json()) as DrillThroughResponse;
    },
    enabled: !!event && !!dashboardId,
    // 30s SWR is long enough for back-and-forth re-opens on the same
    // pin to avoid refetching, but short enough that dashboard data
    // edits don't show stale rows.
    staleTime: 30_000,
  });
}

function stringifyForKey(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
