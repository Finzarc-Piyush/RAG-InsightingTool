/**
 * RawDataProvider — session-scoped raw dataset cache. WC2.1.
 *
 * Why:
 *   Chat charts ship with aggregated data, which prevents client-side
 *   re-derivation when the user changes encoding shelves. By holding
 *   the *raw* dataset for the active session in a React context, every
 *   <ChartCanvas> can re-aggregate locally via dataEngine.ts when a
 *   shelf changes — no SSE round-trip, no server compute.
 *
 * How:
 *   <RawDataProvider sessionId={...} initialRows={...}>{...}</RawDataProvider>
 *
 *   useRawData()           → reads context (rows, isLoading, error, version).
 *   useRawDataForSession() → for cards that pin to a specific session id.
 *
 * The provider accepts inline `initialRows` (used by upload/preview
 * flows that already have the rows in memory). For agent-emitted
 * charts the future wiring will populate this via the existing pivot
 * query API; that landing wave will swap `initialRows` for an async
 * fetcher without breaking consumers.
 */

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { Row } from "./encodingResolver";

export interface RawDataState {
  /** Active session id (or null when no session yet). */
  sessionId: string | null;
  /** Monotonic version counter incremented on each dataset replacement. */
  version: number;
  /** Raw rows for the active session, if available. */
  rows: Row[] | null;
  /** True while a fetch is in-flight (always false when initialRows is supplied). */
  isLoading: boolean;
  error: Error | null;
}

const RawDataContext = createContext<RawDataState | null>(null);

export interface RawDataProviderProps {
  sessionId: string | null;
  /** When supplied, used directly as the rows for this session. */
  initialRows?: Row[];
  /** Monotonic version counter (e.g., currentDataBlob.version). */
  dataVersion?: number;
  /** Loading state bubbled from the consumer. */
  isLoading?: boolean;
  error?: Error | null;
  children: ReactNode;
}

export function RawDataProvider({
  sessionId,
  initialRows,
  dataVersion = 0,
  isLoading = false,
  error = null,
  children,
}: RawDataProviderProps) {
  // Stabilize the rows reference. A new `initialRows` prop replaces
  // the cached rows, but ref-equality on the same array won't churn
  // every consumer.
  const lastRowsRef = useRef<Row[] | null>(null);
  if (initialRows && initialRows !== lastRowsRef.current) {
    lastRowsRef.current = initialRows;
  } else if (!initialRows) {
    lastRowsRef.current = null;
  }

  const value = useMemo<RawDataState>(
    () => ({
      sessionId,
      version: dataVersion,
      rows: lastRowsRef.current,
      isLoading,
      error,
    }),
    [sessionId, dataVersion, isLoading, error, initialRows],
  );

  return (
    <RawDataContext.Provider value={value}>{children}</RawDataContext.Provider>
  );
}

/** Read the active raw dataset from the surrounding RawDataProvider. */
export function useRawData(): RawDataState {
  const ctx = useContext(RawDataContext);
  if (!ctx) {
    return {
      sessionId: null,
      version: 0,
      rows: null,
      isLoading: false,
      error: null,
    };
  }
  return ctx;
}

/**
 * Pin a chart to a specific session id. Returns null rows when the
 * surrounding provider's session id doesn't match (chart was forked
 * from a different session, etc.).
 */
export function useRawDataForSession(
  sessionId: string | null | undefined,
): RawDataState {
  const all = useRawData();
  if (!sessionId) return all;
  if (all.sessionId !== sessionId) {
    return {
      sessionId: sessionId ?? null,
      version: 0,
      rows: null,
      isLoading: false,
      error: null,
    };
  }
  return all;
}

/**
 * Resolve the row list a chart should render. Inline source uses the
 * spec's own rows; session-ref source pulls from RawDataProvider.
 * Returns an empty array when nothing is available — renderers fall
 * through to the empty state in PremiumChart.
 */
export function rowsFromSource(
  source: { kind: string; rows?: unknown; sessionId?: string | null },
  ctx: RawDataState,
): Row[] {
  if (source.kind === "inline" && Array.isArray(source.rows)) {
    return source.rows as Row[];
  }
  if (source.kind === "session-ref") {
    if (source.sessionId && ctx.sessionId !== source.sessionId) return [];
    return ctx.rows ?? [];
  }
  return [];
}
