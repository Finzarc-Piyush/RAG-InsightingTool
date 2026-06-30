/**
 * Per-chart insight "lane" wire format — defined ONCE here and re-exported by
 * `client/src/shared/chartInsightLanes.ts`, so the generator that EMITS a
 * chart's `keyInsight` (server) and the renderer that PARSES it (client) can
 * never drift. Mirrors the `chartSort` / `dashboardLayout` shared-authority
 * pattern.
 *
 * A chart's `keyInsight` carries up to three manager-grade lanes via inline
 * `WHY:` / `DO:` markers:
 *
 *   <headline>             — the WHAT, in plain words, with the number (REQUIRED)
 *   WHY: <hedged reason>   — one clearly-hedged hypothesis (OPTIONAL; the server
 *                            drops it unless it passes the same hedge + no-number
 *                            rail as the answer envelope's likelyDrivers lane)
 *   DO:  <action>          — one concrete next step (OPTIONAL; only when actionable)
 *
 * Parsing is MARKER-based, not newline-based, on purpose: the server collapses
 * whitespace (`normalizeInsightText`) and reflows sentence breaks
 * (`insertSentenceBreaks`) after generation, so newline positions are not
 * reliable. The markers survive both. A legacy `keyInsight` with no markers
 * parses cleanly as a headline-only lane set (full back-compat).
 */
export interface ChartInsightLanes {
  /** The plain-English headline (the WHAT, with the number). */
  headline: string;
  /** Optional clearly-hedged "why it might be happening" hypothesis. */
  why?: string;
  /** Optional concrete "what we can do" action. */
  do?: string;
}

/** Splits on the `WHY:` / `DO:` markers, keeping them as delimiters so the
 *  lane that follows each can be recovered. `\b` + the colon make a false match
 *  inside ordinary prose unlikely. */
const LANE_SPLIT_RE = /\b(WHY|DO):\s*/i;

/**
 * Parse a `keyInsight` string into its headline / why / do lanes. Pure and
 * tolerant: missing lanes are simply absent; an untagged string is all
 * headline; the first occurrence of each marker wins.
 */
export function splitChartInsightLanes(text: string): ChartInsightLanes {
  const s = (text ?? "").trim();
  if (!s) return { headline: "" };

  // String.split with a capturing group interleaves the captured tags:
  //   "head WHY: why DO: do" → ["head ", "WHY", "why ", "DO", "do"]
  const parts = s.split(LANE_SPLIT_RE);
  const lanes: ChartInsightLanes = { headline: (parts[0] ?? "").trim() };

  for (let i = 1; i < parts.length - 1; i += 2) {
    const tag = (parts[i] ?? "").toUpperCase();
    const content = (parts[i + 1] ?? "").trim();
    if (!content) continue;
    if (tag === "WHY" && lanes.why === undefined) lanes.why = content;
    else if (tag === "DO" && lanes.do === undefined) lanes.do = content;
  }

  return lanes;
}

/**
 * Render lanes back into the canonical one-lane-per-line `keyInsight` string.
 * Empty / whitespace-only lanes are dropped, so callers can pass through a
 * partial set (e.g. headline + do after the why lane was hedge-gated away).
 */
export function joinChartInsightLanes(lanes: ChartInsightLanes): string {
  const out: string[] = [];
  const headline = (lanes.headline ?? "").trim();
  if (headline) out.push(headline);
  if (lanes.why && lanes.why.trim()) out.push(`WHY: ${lanes.why.trim()}`);
  if (lanes.do && lanes.do.trim()) out.push(`DO: ${lanes.do.trim()}`);
  return out.join("\n");
}

/**
 * Meta-tool advice a DO lane must NEVER carry: telling the reader to BUILD an
 * analytics artifact ("build a dashboard / scorecard / tracker / monitoring view
 * / report to track this") instead of taking a real business action. A manager
 * reading a tile wants a DECISION, not an instruction to construct the very
 * surface they are already looking at.
 *
 * Two shapes are caught:
 *   1. a build/create verb adjacent (bounded ≤40-char gap) to an artifact noun
 *      — "Build a dashboard to track regional sell-through";
 *   2. a prepositional "... in / into / to a dashboard|scorecard|tracker" tail
 *      — "Track sell-through in a dashboard".
 *
 * This is a CONTENT vocabulary (it polices generated prose), deliberately NOT an
 * intent vocabulary — it does NOT live in `queryIntentAuthority` (invariant #12)
 * and is an independent sibling of `dashboardIntent.EXPLICIT_RX` (which detects a
 * USER asking to build a dashboard) so the two evolve separately. Verb-adjacency
 * + the bounded gap mean a legitimate action that merely contains "track" or
 * "report" as a business verb — "track promo compliance with the field team",
 * "report stockouts to the regional lead" — is NOT matched.
 */
export const DASHBOARD_META_ADVICE_RE =
  /\b(?:build|create|set ?up|make|design|stand ?up|put together|spin up|develop|implement)\b[\s\S]{0,40}\b(?:dashboards?|scorecards?|trackers?|tracking views?|monitoring views?|reports?)\b|\b(?:in|into|on|onto|to|via|using|within|through)\s+(?:a|an|the|your|our|this)\s+(?:dashboards?|scorecards?|trackers?|monitoring views?)\b/i;

/**
 * Drop the DO lane when it is meta-tool advice (above) rather than a managerial
 * action — re-joining {headline, why}. Pure; a no-op when there is no DO lane,
 * when the DO lane is a real action, and on legacy untagged strings. Applied at
 * GENERATION (server post-LLM gate) AND at CONSUMPTION (client render + deck
 * export) off this single shared vocabulary, so already-persisted meta-advice is
 * suppressed without a regeneration and the two tiers can never drift
 * (L-018 "fix both ends", L-022 "the code gate is the guarantee").
 */
export function stripDashboardMetaAdviceDoLane(keyInsight: string): string {
  const lanes = splitChartInsightLanes(keyInsight);
  if (!lanes.do || !DASHBOARD_META_ADVICE_RE.test(lanes.do)) return keyInsight;
  return joinChartInsightLanes({ headline: lanes.headline, why: lanes.why });
}
