import { useCallback, useEffect, useState } from 'react';
import { fetchSessionSampleRows } from '@/lib/api';

/**
 * ARCH-5 / CQ-3 / FE-2 · Self-contained slice of the DataPreviewTable pivot
 * state web: the row-level session-sample fetcher used as a defense-in-depth
 * fallback when the message preview payload is aggregated-only.
 *
 * Extracted VERBATIM from DataPreviewTable.tsx (behaviour-preserving code
 * motion). This sub-cluster is genuinely separable from the rest of the pivot
 * web: it OWNS `sessionSampleRows` / `sessionSampleError`; it READS only the two
 * inputs below (variant / sessionId); and the rest of the component consumes its
 * outputs read-only — `sessionSampleRows` feeds the `pivotRows` fallback memo,
 * `sessionSampleError` is rendered in the pivot-unavailable banner. It does NOT
 * touch `filterSelections`, `pivotConfig`, chart state, or any of the other
 * ~25 useStates, so moving it changes nothing about render output, effect
 * timing, or memo deps.
 *
 * Inputs:
 *  - `variant` / `sessionId` — gate the fetch to the analysis variant with a
 *    live session (matches the original effect's early-return, which also
 *    clears both state slices for the non-analysis / no-session case).
 *
 * Outputs:
 *  - `sessionSampleRows` — `Record<string, unknown>[] | null` row-level rows
 *    from the columnar store, or null when not fetched / on failure.
 *  - `sessionSampleError` — last fetch error message, or null.
 *  - `clearSessionSampleError` — clears the error marker. The component's
 *    reset-on-data-shape-change effect calls this (it previously inlined
 *    `setSessionSampleError(null)`), preserving the original behaviour where a
 *    new pivot data signature wipes a stale sample-fetch error.
 */
export function useSessionSampleRows(params: {
  variant: 'dataset' | 'analysis';
  sessionId?: string | null;
}): {
  sessionSampleRows: Record<string, unknown>[] | null;
  sessionSampleError: string | null;
  clearSessionSampleError: () => void;
} {
  const { variant, sessionId } = params;

  /** Row-level rows from columnar store when sessionId is set (defense in depth vs aggregated-only preview). */
  const [sessionSampleRows, setSessionSampleRows] = useState<
    Record<string, unknown>[] | null
  >(null);
  const [sessionSampleError, setSessionSampleError] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (variant !== 'analysis' || !sessionId) {
      setSessionSampleRows(null);
      setSessionSampleError(null);
      return;
    }
    let cancelled = false;
    setSessionSampleError(null);
    void (async () => {
      try {
        const res = await fetchSessionSampleRows(sessionId, 2000);
        if (!cancelled && Array.isArray(res.rows)) {
          setSessionSampleRows(res.rows as Record<string, unknown>[]);
          setSessionSampleError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setSessionSampleRows(null);
          setSessionSampleError(
            e instanceof Error ? e.message : 'Failed to fetch session sample rows'
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, sessionId]);

  const clearSessionSampleError = useCallback(() => {
    setSessionSampleError(null);
  }, []);

  return {
    sessionSampleRows,
    sessionSampleError,
    clearSessionSampleError,
  };
}
