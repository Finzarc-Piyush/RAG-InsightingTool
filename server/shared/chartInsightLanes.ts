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
