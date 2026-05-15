/**
 * Wave W5 · narratorAgent
 *
 * Evidence-based synthesis from the analytical blackboard. Replaces the raw
 * observations dump when the blackboard has findings. The narrator reads the
 * structured hypothesis outcomes and findings and writes an investigation
 * narrative: what was tested, what was found, what it means for the business.
 *
 * When the blackboard is empty (dataOps turns, or hypothesis planner was
 * skipped), the caller falls back to the existing synthesizeFinalAnswerEnvelope.
 */

import { z } from "zod";
import { completeJson, completeJsonStreaming, isStreamingNarratorEnabled } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import { agentLog } from "./agentLogger.js";
import {
  formatForNarrator,
  type AnalyticalBlackboard,
} from "./analyticalBlackboard.js";
import {
  buildSynthesisContext,
  formatSynthesisContextBundle,
} from "./buildSynthesisContext.js";
import { formatDimensionHierarchiesBlock } from "./context.js";
import type { AgentExecutionContext } from "./types.js";

export { shouldUseNarrator } from "./analyticalBlackboard.js";

const narratorOutputSchema = z.object({
  body: z.string(),
  keyInsight: z.string().nullable().optional(),
  // W8 · `.default([])` produced a TS input/output type mismatch when read via
  // `z.infer` after the W8 schema additions. Switching to `.optional()` keeps
  // the same runtime behaviour (callers already coerce `undefined → []`) and
  // makes the inferred return type compatible with `runNarrator`'s signature.
  ctas: z.array(z.string()).optional(),
  /** 2–4 entries backing the main claim: {label, value, confidence?} */
  magnitudes: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .optional(),
  unexplained: z.string().optional(),
  // W3 · AnswerEnvelope — optional structured rendering hints. Narrator may
  // emit any subset; the UI's AnswerCard renders whichever fields are present
  // and falls back to `body` markdown for the rest. Caps loosened in lockstep
  // with shared/schema.ts answerEnvelope so output that passes the local
  // validator also passes the persistence schema.
  tldr: z.string().max(600).optional(),
  findings: z
    .array(
      z.object({
        headline: z.string().max(400),
        evidence: z.string().max(3000),
        magnitude: z.string().max(160).optional(),
      })
    )
    .max(15)
    .optional(),
  methodology: z.string().max(3500).optional(),
  caveats: z.array(z.string().max(400)).max(10).optional(),
  // W8 · "So what" reading of the headline findings.
  implications: z
    .array(
      z.object({
        statement: z.string().max(600),
        soWhat: z.string().max(800),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(12)
    .optional(),
  // W8 · concrete next actions, grouped by horizon.
  recommendations: z
    .array(
      z.object({
        action: z.string().max(400),
        rationale: z.string().max(800),
        horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
      })
    )
    .max(12)
    .optional(),
  // W8 · one-paragraph framing of the findings against FMCG/Marico priors.
  domainLens: z.string().max(2000).optional(),
});

export type NarratorOutput = z.infer<typeof narratorOutputSchema>;

/**
 * W4 · narrator-repair branch.
 *
 * When the deep verifier returns `revise_narrative`, the agent loop hands
 * the issues + the prior draft back into runNarrator (rather than the legacy
 * rewriteNarrative path, which loses blackboard context). Both fields are
 * optional — `priorDraft` lets the model see what it said last time so it
 * can preserve good content while fixing the flagged issues.
 */
export interface NarratorRepairContext {
  issues: string;
  priorDraft?: string;
  courseCorrection?: string;
}

/**
 * Run the narrator to produce an investigation narrative from the blackboard.
 * Returns null if the LLM call fails (caller uses synthesizer fallback).
 */
/**
 * W38 · streaming-mode hook. When provided, the narrator uses
 * `completeJsonStreaming` and forwards each chunk's accumulated raw
 * text to `onPartial`. Repair calls (W17/W22 retries) ignore this and
 * stay non-streaming — the user already saw the initial draft.
 */
export interface NarratorStreamingHook {
  onPartial: (chunk: { rawSoFar: string; delta: string }) => void;
}

export async function runNarrator(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string,
  onLlmCall: () => void,
  repair?: NarratorRepairContext,
  streaming?: NarratorStreamingHook,
  /**
   * G4-P5 · structured tool I/O captured by the agent loop. When provided,
   * the narrator's data-understanding block lists each step's tool, args,
   * and row count — so it can distinguish "this step queried the whole
   * dataset" from "this step filtered to Central only".
   */
  structuredObservations?: ReadonlyArray<{
    stepId: string;
    tool: string;
    args: Record<string, unknown>;
    metrics: {
      inputRowCount?: number;
      outputRowCount?: number;
      appliedAggregation?: boolean;
      durationMs?: number;
    };
  }>
): Promise<NarratorOutput | null> {
  const blackboardBlock = formatForNarrator(blackboard);
  if (!blackboardBlock.trim()) return null;

  // W8 · the W7 bundle replaces the old raw-JSON sessionContext + truncated
  // user-notes blocks. It carries data understanding, user identity, RAG
  // hits (including blackboard round-2 entries), and FMCG/Marico domain
  // packs in stable byte-order so the prefix cache holds across calls.
  const synthBundleBlock = formatSynthesisContextBundle(
    buildSynthesisContext(ctx, { blackboard, structuredObservations })
  );
  const phase1Shape = ctx.analysisBrief?.questionShape;

  // W4.2 · system is now byte-stable across calls — the phase-1 envelope
  // template is unconditionally present, and per-call questionShape is moved
  // to the user message. Combined with ANALYST_PREAMBLE this clears Azure's
  // 1024-token prefix-cache threshold.
  const system = `${ANALYST_PREAMBLE}You are a senior data analyst presenting the results of a completed investigation.
You have access to a structured blackboard: the hypotheses that were tested, their outcomes
(confirmed / refuted / partial / open), and the findings that emerged. The user message also
carries a CONTEXT BUNDLE with four labelled sections — DATA UNDERSTANDING, USER CONTEXT,
RELATED CONTEXT (RAG / web), and DOMAIN KNOWLEDGE (FMCG/Marico). Use them to make the answer
substantive and decision-grade. The RELATED CONTEXT block may include open-web hits (tagged
\`[web:tavily:N]\`) — treat them identically to RAG hits: background grounding for
interpretation and inline citation, never numeric evidence. Figures still come only from
the blackboard / observations.

Your job: narrate the investigation clearly in the following JSON format:
- "body": main markdown answer. Lead with the most important finding. For each confirmed
  hypothesis, cite the supporting evidence. For refuted hypotheses, say what was ruled out.
  Do not repeat the user question verbatim.
  LENGTH — calibrate to the question, not to a fixed band. A "descriptive" lookup
  ("what's the total revenue?") is one or two sentences with the number, no surrounding
  paragraphs. A "comparison" between two segments is a few short paragraphs. A
  "driver_discovery" or "variance_diagnostic" or open "exploration" may warrant a
  multi-paragraph dive with several findings, implications, and recommendations.
  Never pad with filler — every paragraph must add either a finding, a numeric claim,
  an interpretation grounded in the domain context, or a recommendation. Brevity is a
  feature; an answer that says less than the question deserves is wrong, but so is an
  answer that says more. Match length and structure to what the user actually asked.
  HARD CONSTRAINTS on body content:
  • Do NOT open with a methodology recap — phrases like "X has been calculated by
    grouping…", "the analysis was performed by summing…", "we computed X by aggregating…"
    are banned. The first sentence must state the headline finding with its number.
  • Do NOT include a paragraph describing the dataset shape (row count × column count),
    data-quality assessments ("the dataset is clean", "well-structured for this purpose",
    "appears suitable"), or hypothesis-confirmation language ("the findings align with
    the hypothesis", "this confirms our assumption that…"). The reader assumes the data
    was usable. If a data limitation is genuinely material, surface it inside \`caveats\`,
    not inside body prose.
- "keyInsight": 1–3 sentences on what the findings imply for decisions (the "so what").
  Use null if nothing beyond the body adds value.
- "ctas": 0 to 3 actionable follow-up prompts (empty array if none fit).
- Do NOT invent numbers not present in the findings. If a hypothesis has no evidence, say
  it remains open and explain why.

W3 · AnswerEnvelope — emit each field only when it adds value. Calibrate volume to
the question; do not pad sections to hit a target count. For a "descriptive" lookup
many of these fields will be omitted entirely; for an open analytical dive several
fields will carry multiple entries.
- "tldr": ONE sentence stating the headline answer up-front. The reader should be able
  to stop after this sentence and still walk away with the right takeaway.
- "findings": as many ordered entries as the answer warrants — could be one for a
  lookup, several for a deep analytical dive. Each {headline, evidence, magnitude?}.
  The headline is the claim; the evidence cites numbers from the blackboard verbatim
  and explains them; the magnitude is the single most important number in
  human-readable form (e.g. "+12.4% YoY", "$3.2M shortfall").
- "methodology": plain prose on what tools / data / time-window were used. Length
  should match how complex the methodology actually was — one sentence for a single
  aggregation, a paragraph for a multi-step analysis. No JSON.
- "caveats": short bullets on what materially limits the conclusion (sample-size,
  missing-data, ambiguous definitions, etc.). Often zero. Empty array is fine.
  Wave T4 · MANDATORY when the user asked for a temporal trend (verbs/phrases like
  "over time", "trend", "evolution", "trajectory", "how X changed", "temporal pattern")
  AND the executed query's grouped temporal axis (a "Day · …", "Week · …", "Month · …",
  "Quarter · …", "Half-year · …" or "Year · …" column) returned only ONE distinct
  bucket. The caveat must (a) name the dataset's actual temporal scope verbatim from
  the methodology / observations (e.g. "Dataset spans only April 2026") and (b) state
  that a multi-period trend cannot be plotted from this slice. Reframe the answer as
  cross-sectional variation across the non-temporal dimension within that scope. NEVER
  invent additional periods to fake a trend.

W8 · Decision-grade extensions — emit only those grounded in the findings:
- "implications": each {statement, soWhat, confidence?}. \`statement\` is the observed
  fact (one sentence, grounded in findings); \`soWhat\` is the business meaning for an
  FMCG operator — a buyer, brand manager, channel head — framed using DOMAIN KNOWLEDGE
  when relevant. Confidence is "low" / "medium" / "high". For a simple lookup this
  array may be empty or contain a single entry; for a deep analytical dive it may
  carry several. Never invent implications to hit a count.
- "recommendations": each {action, rationale, horizon?}. \`action\` is a concrete next
  step the team can take; \`rationale\` ties it to a specific finding and the domain
  context. \`horizon\` is "now" (this week), "this_quarter", or "strategic". Same
  calibration as implications — only emit recommendations the data actually supports.
- "domainLens": one paragraph framing the findings against the relevant FMCG/Marico
  domain context. Cite the pack id verbatim when you reference it (e.g.
  "Per \`marico-haircare-portfolio\`, …"). Omit when no domain pack is materially
  relevant. Treat domain packs as orientation only — never invent domain facts.

Phase-1 rich envelope — REQUIRED whenever the user message declares a non-empty questionShape:
- "magnitudes": entries that back your main claim. Each: {label, value, confidence?}. MUST come from findings — never invent. Emit zero when the answer carries no numeric backbone.
- "unexplained": one sentence on what could NOT be determined. Omit if nothing material is missing.
When the user message says "questionShape: none" you may omit magnitudes and unexplained.

VOICE — your reader is a manager / CXO, NOT a statistician. HARD RULES:
- Plain English ONLY. Never use these terms anywhere in body, keyInsight, findings,
  implications, or recommendations: HHI, CV, IQR, P25, P50, P75, "long tail",
  "Pearson r", "percentile", "coefficient of variation". Use plain language instead:
  "concentrated / spread out", "varies a lot / fairly stable", "in the top/bottom
  quartile", "moves in the same direction", "smaller segments combined".
- Numbers ≥1000 MUST be rendered compactly (710K, 1.95M, 2.3B). Never raw decimals
  like "710,212.40" or "$1,950,000.50". Currency stays prefixed where appropriate
  ("$710K"). Percentages and ratios stay precise ("31%", "1.8×").
- Tone is neutral and observational. Never accusatory. Avoid framings like
  "underperforms", "lagging", "weak performance" unless the data clearly establishes
  a benchmark; "South contributed 17% of the total" is preferred to "South is
  underperforming the rest of the country".
- Recommendations are ANALYTICAL next steps, not executive decisions. The reader
  is an analyst running a report, not a CEO. Do NOT propose launching new products,
  entering new categories, changing channels, premiumising a brand, restructuring
  distribution, or any other strategic move that requires authority the reader
  does not have. Do propose splitting by an existing dimension, comparing two
  cohorts the data has, or looking at the metric over time.
- Never speculate about causes the data does not show. The data has the columns
  listed in DATA UNDERSTANDING — do not invent channel, distribution, brand,
  competition, customer demographics, supply-chain, or pricing mechanisms unless
  those columns are in the data.
- DIMENSION HIERARCHIES: when the user message includes a DIMENSION HIERARCHIES
  block, treat the listed rollup values as category totals — never as competing
  items. Phrase findings as "the <rollupValue> category" (or "overall <column>"
  if more natural), and frame member values as a share of that category, not of
  the dataset total. Example: prefer "within the FEMALE SHOWER GEL category,
  MARICO leads at 31%" over "FEMALE SHOWER GEL leads with 88% of total sales".
  When the same block also surfaces a "DETECTED INTENT — share-of-category"
  hint, the user is explicitly asking for share / contribution / % computed
  AGAINST the rollup as the denominator — divide the member's value by the
  rollup's value (e.g. MARICO 6000 / FSG 68751 = ~9 %), NOT by the sum of the
  remaining members.
- PCT1 — RATE / SHARE / PERCENT framing: when a step result row contains both
  a \`countIf\`/\`sumIf\` aggregation alias (e.g. "matching", "<col>_sumIf") AND
  a paired \`count\`/\`sum\` total (e.g. "total", "<col>_sum"), surface the ratio
  as a percentage in the lede + magnitudes. Magnitude format: "x.x% (n of N)"
  for countIf/count pairs; "x.x% of <metric>" for sumIf/sum pairs. Findings
  should call out both the rate AND the absolute counts (matching, total) so
  the reader sees the denominator. Never report a bare countIf number ("matching:
  482") without the total or the percentage — that's the failure mode this rule
  exists to prevent.
- WGR5 — GROWTH PROMINENCE: when the blackboard or tool observations contain
  growth output (the compute_growth tool emits memorySlots like growth_grain,
  growth_top_dimension, growth_top_pct and rows with prior_value/growth_pct),
  surface the period-over-period growth rates explicitly in the answer. Put
  the percentage delta into findings[].magnitude (e.g. "+33.0% YoY"),
  spell out which segment grew fastest and which declined fastest by name in
  implications[]. Cover ALL year-pairs the data supports, not just the first
  pair (a 3-year dataset has TWO YoY pairs per segment, not one). For
  "fastest growing" questions, the lede in tldr should name the top segment
  and its growth rate. Never bury growth rates inside methodology or caveats.
- WSE5 — SEASONALITY PROMINENCE: when the blackboard or tool observations
  contain seasonality output (detect_seasonality emits memorySlots
  seasonality_strength, seasonality_peak_positions, seasonality_consistency_max,
  seasonality_grain, seasonality_years_observed; its summary text reads
  e.g. "Strong month-of-year seasonality across 5 years: Nov consistently
  peaks (5 of 5 years), with Nov averaging +38% vs the typical month"),
  frame any peak claim as a RECURRING pattern, not a single-period max. Cite
  the consistency fraction (e.g. "5 of 5 years"), the named months/quarters
  (e.g. "Oct/Nov/Dec"), AND the magnitude (e.g. "~30% above the annual mean").
  NEVER report a single-month peak ("Nov 2018 was the peak") as the headline
  finding when seasonality output shows it's part of a recurring Q4 spike —
  that buries the actual story. Place a SEPARATE Seasonality finding in
  findings[] alongside the Trend / Growth finding (they answer different
  questions: trend = "are values rising over years?"; seasonality = "do
  values peak at the same time within each year?"). Cross-cite the
  seasonality-and-festivals domain pack in domainLens when the detected
  pattern matches Marico expectations (Q1 summer, Q3 Diwali festive,
  monsoon-driven rural). When seasonality_strength is "weak" or "none",
  still acknowledge the result briefly ("no clear within-year recurring
  pattern") so the reader knows the cut was checked.`;

  const phase1Line = phase1Shape
    ? `questionShape: ${phase1Shape}\n`
    : `questionShape: none\n`;
  // W4 · when re-invoked after a verifier `revise_narrative` verdict, append
  // the issues + course correction + prior draft so the model can do a
  // grounded rewrite instead of starting blind. Cap at 4000 chars to keep
  // the user prompt within the existing budget.
  const repairBlock = repair
    ? `\n\nVerifier flagged issues with the previous draft. Address them:\nIssues: ${repair.issues.slice(0, 1500)}${
        repair.courseCorrection ? `\nCourse correction: ${repair.courseCorrection.slice(0, 500)}` : ""
      }${
        repair.priorDraft ? `\n\nPrior draft (rewrite, do not repeat verbatim):\n${repair.priorDraft.slice(0, 2000)}` : ""
      }`
    : "";
  const bundleSection = synthBundleBlock ? `\n\n${synthBundleBlock}` : "";
  const hierarchyBlock = formatDimensionHierarchiesBlock(ctx);
  const hierarchySection = hierarchyBlock ? `\n${hierarchyBlock}` : "";
  const user = `${phase1Line}Question: ${ctx.question}\n\n${blackboardBlock}${bundleSection}${hierarchySection}${repairBlock}`;

  // W38 · use the streaming variant when (1) env flag is on, (2) caller
  // supplied a streaming hook, AND (3) this is the initial call (not a
  // W17/W22 repair). Repairs stay non-streaming because the user already
  // saw the initial draft; streaming a repair would visually thrash.
  const useStreaming = !repair && Boolean(streaming) && isStreamingNarratorEnabled();
  const result = useStreaming
    ? await completeJsonStreaming(system, user, narratorOutputSchema, {
        turnId: `${turnId}_narrator_stream`,
        // 10_000 → 24_000. With rigid length bands removed and per-field
        // schema caps relaxed, deep analytical dives can legitimately produce
        // 15 findings + 12 implications + 12 recommendations + extended
        // methodology and domainLens. Claude Opus 4.7 has plenty of output
        // headroom; the cap exists only as runaway protection.
        maxTokens: 24_000,
        temperature: 0.25,
        onLlmCall,
        purpose: LLM_PURPOSE.NARRATOR,
        onPartial: streaming!.onPartial,
      })
    : await completeJson(system, user, narratorOutputSchema, {
        turnId: `${turnId}_narrator${repair ? "_repair" : ""}`,
        // 10_000 → 24_000. See streaming branch above for rationale.
        maxTokens: 24_000,
        temperature: 0.25,
        onLlmCall,
        purpose: LLM_PURPOSE.NARRATOR,
      });

  if (!result.ok) {
    agentLog("narratorAgent.failed", { turnId, error: result.error, repair: !!repair });
    return null;
  }

  agentLog(repair ? "narratorAgent.repair" : "narratorAgent.done", {
    turnId,
    hypotheses: blackboard.hypotheses.length,
    findings: blackboard.findings.length,
    repair: !!repair,
  });

  return result.data;
}
