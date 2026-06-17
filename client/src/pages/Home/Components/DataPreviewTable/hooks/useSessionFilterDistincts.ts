import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPivotColumnDistincts } from '@/lib/api';

/**
 * ARCH-5 / CQ-3 / FE-2 · Self-contained slice of the DataPreviewTable pivot
 * state web: the authoritative per-field DuckDB distinct-value fetcher for the
 * FILTERS shelf.
 *
 * Extracted VERBATIM from DataPreviewTable.tsx (behaviour-preserving code
 * motion). This sub-cluster is genuinely separable from the rest of the pivot
 * web: it OWNS `sessionFilterDistincts` / `sessionFilterDistinctsErrors`, the
 * fetch sequence ref, and the retry nonce; it READS only the four inputs below
 * (variant / sessionId / the slice-filter field set + its stable signature);
 * and the rest of the component consumes its three outputs read-only. It does
 * NOT touch `filterSelections`, `pivotConfig`, chart state, or any of the other
 * ~25 useStates — so moving it changes nothing about render output, effect
 * timing, or memo deps.
 *
 * Inputs:
 *  - `variant` / `sessionId` — gate the fetch to the analysis variant with a
 *    live session (matches the original effect's early-return).
 *  - `pivotSyncFields` — the slice-filter field set the popover needs distincts
 *    for (`pivotSliceFilterFields(normalizedPivotConfig)`).
 *  - `pivotDistinctFieldsSignature` — the stable `\0`-joined signature of
 *    `pivotSyncFields`; the fetch effect is keyed off it (not the array
 *    identity) so distincts refetch only when the field SET changes.
 *
 * Outputs:
 *  - `sessionFilterDistincts` — `{ [field]: string[] }` authoritative distincts.
 *  - `filterDistinctsResolution` — per-field `'loading' | 'loaded' | 'error'`,
 *    derived synchronously so the popover never flashes "No values to filter".
 *  - `handleRetryFilterDistincts` — clears a field's error marker and bumps the
 *    retry nonce so the fetch effect re-fires for it.
 */
export function useSessionFilterDistincts(params: {
  variant: 'dataset' | 'analysis';
  sessionId?: string | null;
  pivotSyncFields: string[];
  pivotDistinctFieldsSignature: string;
}): {
  sessionFilterDistincts: Record<string, string[]>;
  filterDistinctsResolution: Record<string, 'loading' | 'loaded' | 'error'>;
  handleRetryFilterDistincts: (field: string) => void;
} {
  const { variant, sessionId, pivotSyncFields, pivotDistinctFieldsSignature } =
    params;

  const filterDistinctFetchSeqRef = useRef(0);
  const [sessionFilterDistincts, setSessionFilterDistincts] = useState<
    Record<string, string[]>
  >({});
  const [sessionFilterDistinctsErrors, setSessionFilterDistinctsErrors] =
    useState<Record<string, string>>({});
  /**
   * Bumping this counter forces the per-field distincts fetch to re-fire even
   * when `pivotDistinctFieldsSignature` is unchanged. Used by the popover's
   * "Retry" button after a prior fetch failed.
   */
  const [filterDistinctsRetryNonce, setFilterDistinctsRetryNonce] = useState(0);

  useEffect(() => {
    if (variant !== 'analysis' || !sessionId) {
      setSessionFilterDistincts({});
      setSessionFilterDistinctsErrors({});
      return;
    }
    const fields = [...new Set(pivotSyncFields)];
    if (fields.length === 0) {
      setSessionFilterDistincts({});
      setSessionFilterDistinctsErrors({});
      return;
    }
    let cancelled = false;
    const seq = ++filterDistinctFetchSeqRef.current;
    // Clear any prior error markers for the fields we're about to refetch so
    // the popover doesn't flash "Couldn't load values" while the retry is in
    // flight.
    setSessionFilterDistinctsErrors((prev) => {
      if (fields.every((f) => !(f in prev))) return prev;
      const next = { ...prev };
      for (const f of fields) delete next[f];
      return next;
    });
    void (async () => {
      const values: Record<string, string[]> = {};
      const errors: Record<string, string> = {};
      await Promise.all(
        fields.map(async (f) => {
          try {
            // Full DuckDB distincts (no pagination, no cap that bites in
            // practice). Same authoritative table the agent's tools see.
            values[f] = await fetchPivotColumnDistincts(sessionId, f);
          } catch (e) {
            errors[f] =
              e instanceof Error ? e.message : 'Failed to load filter values';
          }
        })
      );
      if (cancelled || seq !== filterDistinctFetchSeqRef.current) return;
      setSessionFilterDistincts(values);
      setSessionFilterDistinctsErrors((prev) => {
        const next = { ...prev };
        for (const [f, msg] of Object.entries(errors)) next[f] = msg;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // `pivotSyncFields` is intentionally read via its stable string signature
    // (`pivotDistinctFieldsSignature`) so we refetch distincts only when the
    // field SET changes, not on every array-identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    variant,
    sessionId,
    pivotDistinctFieldsSignature,
    filterDistinctsRetryNonce,
  ]);

  // Per-field render-time resolution: every field in the FILTERS shelf is
  // either 'loading' (we haven't completed a fetch attempt yet), 'loaded'
  // (sessionFilterDistincts has the key — value list is authoritative), or
  // 'error' (last fetch attempt failed). Derived synchronously from
  // pivotSyncFields membership rather than effect-set state, so the popover
  // can never render "No values to filter" in the sub-frame window before
  // the fetch effect runs.
  const filterDistinctsResolution = useMemo<
    Record<string, 'loading' | 'loaded' | 'error'>
  >(() => {
    const out: Record<string, 'loading' | 'loaded' | 'error'> = {};
    for (const f of pivotSyncFields) {
      if (Object.prototype.hasOwnProperty.call(sessionFilterDistincts, f)) {
        out[f] = 'loaded';
      } else if (Object.prototype.hasOwnProperty.call(sessionFilterDistinctsErrors, f)) {
        out[f] = 'error';
      } else {
        out[f] = 'loading';
      }
    }
    return out;
  }, [pivotSyncFields, sessionFilterDistincts, sessionFilterDistinctsErrors]);

  const handleRetryFilterDistincts = useCallback((field: string) => {
    setSessionFilterDistinctsErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setFilterDistinctsRetryNonce((n) => n + 1);
  }, []);

  return {
    sessionFilterDistincts,
    filterDistinctsResolution,
    handleRetryFilterDistincts,
  };
}
