import { useEffect, useRef } from 'react';

/**
 * Report `(sessionId, fileName)` upward whenever EITHER value genuinely
 * changes — and ONLY then.
 *
 * The callback is held in a ref so the notify effect does **not** re-fire when
 * the parent passes a fresh `onSessionChange` identity on an unrelated
 * re-render. This is the fix for P-NEW-ANALYSIS-HANG / L-040:
 *
 *   App's `handleSessionChange` is an inline (unmemoized) closure, so it gets a
 *   new function identity on every `Router` render. If the notify effect
 *   depended on that callback directly (the old `[sessionId, fileName,
 *   onSessionChange]` deps), clicking **"New analysis"** — which re-renders App
 *   while Home's internal `sessionId` is still the OLD session — would re-fire
 *   the effect and report the STALE `sessionId` back to App. App then
 *   "self-mints" the URL back to that session (with no loaded snapshot), and
 *   the rehydration fetch is suppressed by `selfMintedSessionRef`, trapping
 *   Home in an unrecoverable `isResumingSession` loading spinner.
 *
 * Gating the effect on `[sessionId, fileName]` only means: an upload that mints
 * a brand-new sessionId (null → real) still fires exactly once with the latest
 * callback, but a parent re-render that merely churns the callback identity
 * fires nothing. The ref always holds the freshest closure, so when the effect
 * does fire it reads the parent's current `urlSessionId` / `location`.
 */
export function useNotifySessionChange(
  sessionId: string | null,
  fileName: string | null,
  onSessionChange?: (sessionId: string | null, fileName: string | null) => void,
): void {
  const onSessionChangeRef = useRef(onSessionChange);
  useEffect(() => {
    onSessionChangeRef.current = onSessionChange;
  }, [onSessionChange]);

  useEffect(() => {
    onSessionChangeRef.current?.(sessionId, fileName);
  }, [sessionId, fileName]);
}
