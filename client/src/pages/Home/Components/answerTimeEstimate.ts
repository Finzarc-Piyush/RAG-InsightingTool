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
  /** True once the long post-answer dashboard build has begun. */
  dashboardActive: boolean;
  /** Distinct thinking-step categories surfaced so far. */
  stepCount: number;
}

/** A coarse, clamped "usually about low–high seconds" band for an answer. */
export function estimateAnswerBand({ dashboardActive, stepCount }: AnswerBandInput): {
  low: number;
  high: number;
} {
  const steps = Math.max(0, stepCount);
  // Each emitted step proxies a bit of work done; nudge the band up with depth.
  let low = 8 + Math.min(12, steps * 1.2);
  let high = low + 18 + Math.min(14, steps);
  if (dashboardActive) {
    // The dashboard build adds a long (~1 min), previously-silent phase.
    low = Math.max(low, 38);
    high = Math.max(high, 85);
  }
  low = Math.round(Math.max(6, Math.min(low, 70)));
  high = Math.round(Math.max(low + 8, Math.min(high, 120)));
  return { low, high };
}

/** Compact human duration: `8s`, `1m 4s`, `2m`. Shared by the answer timer. */
export function formatSeconds(s: number): string {
  const v = Math.max(0, Math.floor(s));
  if (v < 60) return `${v}s`;
  const m = Math.floor(v / 60);
  const sec = v % 60;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}
