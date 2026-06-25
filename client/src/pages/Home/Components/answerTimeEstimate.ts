// Coarse "time to get an answer" estimator for the live Thinking panel.
//
// Unlike enrichment (DatasetEnrichmentLoader.estimateBand), answer time is
// highly variable — a plain lookup lands in a few seconds, a full agentic
// investigation with a dashboard build runs ~a minute. We have two cheap live
// signals client-side: how many thinking steps have been emitted (a rough proxy
// for how much work the loop is doing) and whether the long post-answer
// dashboard-build phase has started. The band is intentionally wide and honest;
// it sets expectations without pretending to predict precisely.

export interface AnswerBandInput {
  /** True once the long post-answer dashboard build has begun (LATE signal —
   *  the server only emits the "Building dashboard" step after the whole
   *  investigation + answer draft). */
  dashboardActive: boolean;
  /** True as soon as we can tell this is a multi-minute deep run: a spawned
   *  sub-question has arrived OR the user explicitly asked for a dashboard.
   *  This is the EARLY signal that keeps the band honest from second one,
   *  instead of waiting ~3 min for `dashboardActive`. */
  deepInvestigation: boolean;
  /** Distinct thinking-step categories surfaced so far. */
  stepCount: number;
}

/** A coarse, clamped "usually about low–high" band for an answer (seconds). */
export function estimateAnswerBand({
  dashboardActive,
  deepInvestigation,
  stepCount,
}: AnswerBandInput): {
  low: number;
  high: number;
} {
  const steps = Math.max(0, stepCount);
  // Each emitted step proxies a bit of work done; nudge the band up with depth.
  let low = 8 + Math.min(12, steps * 1.2);
  let high = low + 18 + Math.min(14, steps);
  if (deepInvestigation || dashboardActive) {
    // A deep multi-question investigation plus the dashboard build runs ~2–4
    // minutes in practice (observed 170–250s). The old 38–85s band undershot by
    // 3–5×, so the timer flipped to "a little longer…" within a minute and
    // stuck. Widen to minutes so the expectation matches reality.
    low = Math.max(low, 120);
    high = Math.max(high, 240);
  }
  low = Math.round(Math.max(6, Math.min(low, 240)));
  high = Math.round(Math.max(low + 8, Math.min(high, 360)));
  return { low, high };
}

/**
 * Format a band for display: compact seconds for short answers
 * ("~18–44s") and rounded minutes once the band crosses ~1.5 min
 * ("~2–4 min"), so a multi-minute deep run never reads as tens of seconds.
 */
export function formatBand(low: number, high: number): string {
  if (high >= 90) {
    const lo = Math.max(1, Math.round(low / 60));
    const hi = Math.max(lo + 1, Math.round(high / 60));
    return `~${lo}–${hi} min`;
  }
  return `~${low}–${high}s`;
}

/** Compact human duration: `8s`, `1m 4s`, `2m`. Shared by the answer timer. */
export function formatSeconds(s: number): string {
  const v = Math.max(0, Math.floor(s));
  if (v < 60) return `${v}s`;
  const m = Math.floor(v / 60);
  const sec = v % 60;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}
