/**
 * Wave-FA · React glue for the "Entire dataset" preview mode.
 *
 * When `enabled` (the preview toggle is on "full"), fetches the full
 * filter-aware row set, debounced and re-fetched whenever the active-filter
 * `version` changes. Superseded responses are dropped (seq guard) and prior
 * rows are kept on screen during a refetch (stale-while-revalidate) so the
 * pane never flashes empty mid-edit. The fetch + mapping live in
 * `@/lib/filteredFullRows` (unit-tested); this hook is the lifecycle wrapper.
 */
import { useEffect, useRef, useState } from "react";
import { fetchFilteredFullRows } from "@/lib/filteredFullRows";

export interface UseFilteredFullRows {
  rows: Record<string, unknown>[];
  loading: boolean;
  truncated: boolean;
}

const FULL_FETCH_DEBOUNCE_MS = 300;

export function useFilteredFullRows(
  sessionId: string | null,
  version: number | undefined,
  enabled: boolean
): UseFilteredFullRows {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !sessionId) {
      // Not in full mode — cancel any pending fetch and drop the spinner.
      // Keep `rows` so re-entering full mode shows the last set instantly
      // while the refresh flies.
      seqRef.current++;
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const out = await fetchFilteredFullRows(sessionId);
          if (seq !== seqRef.current) return; // superseded by a newer request
          setRows(out.rows); // swap only on success — stale-while-revalidate
          setTruncated(out.truncated);
        } catch {
          // Keep the stale rows; the 200-row preview is the safe fallback.
        } finally {
          if (seq === seqRef.current) setLoading(false);
        }
      })();
    }, FULL_FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, version, enabled]);

  return { rows, loading, truncated };
}
