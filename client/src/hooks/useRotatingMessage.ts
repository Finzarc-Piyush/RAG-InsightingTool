import { useEffect, useState } from "react";

export interface UseRotatingMessageOptions {
  /** Milliseconds between line changes. Defaults to 5200ms — the cadence the
   *  enrichment loader established (DatasetEnrichmentLoader.tsx). */
  intervalMs?: number;
  /** When false the timer is parked and the first (start) line is shown. Lets
   *  a caller gate rotation on a phase being active without violating the
   *  rules of hooks (the hook is always called; only the interval toggles). */
  enabled?: boolean;
  /** Where in `lines` to begin. Callers can pass a per-mount random offset so
   *  two builds don't always open on the same line; kept as a param so the
   *  hook itself stays deterministic and unit-testable. */
  startIndex?: number;
}

/**
 * Cycle through a bank of strings on a fixed interval — the rotation primitive
 * behind both the dataset-enrichment loader and the dashboard-build status
 * ticker. Returns the line that should be shown right now.
 *
 * Extracted from the inline `rotateIndex` + `setInterval(5200)` logic in
 * DatasetEnrichmentLoader.tsx so there is one place that owns "rotate a list of
 * witty lines" instead of a copy per surface.
 */
export function useRotatingMessage(
  lines: string[],
  { intervalMs = 5200, enabled = true, startIndex = 0 }: UseRotatingMessageOptions = {}
): string {
  const len = lines.length;
  const [offset, setOffset] = useState(0);

  // Reset to the start line whenever rotation (re)engages or the bank changes,
  // so a freshly-active phase doesn't resume mid-cycle from a stale offset.
  useEffect(() => {
    setOffset(0);
  }, [enabled, intervalMs, len]);

  useEffect(() => {
    if (!enabled || len <= 1) return;
    const id = window.setInterval(() => {
      setOffset((n) => (n + 1) % len);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, len]);

  if (len === 0) return "";
  const idx = (((startIndex + offset) % len) + len) % len;
  return lines[idx] ?? lines[0]!;
}
