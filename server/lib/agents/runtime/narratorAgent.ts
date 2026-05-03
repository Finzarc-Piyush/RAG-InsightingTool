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
  // and falls back to `body` markdown for the rest. WTL3 · caps loosened in
  // lockstep with shared/schema.ts answerEnvelope.
  tldr: z.string().max(400).optional(),
  findings: z
    .array(
      z.object({
        headline: z.string().max(280),
        evidence: z.string().max(1200),
        magnitude: z.string().max(120).optional(),
      })
    )
    .max(7)
    .optional(),
  methodology: z.string().max(1400).optional(),
  caveats: z.array(z.string().max(280)).max(5).optional(),
  // W8 · "So what" reading of the headline findings.
  implications: z
    .array(
      z.object({
        statement: z.string().max(400),
        soWhat: z.string().max(400),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(6)
    .optional(),
  // W8 · concrete next actions, grouped by horizon.
  recommendations: z
    .array(
      z.object({
        action: z.string().max(280),
        rationale: z.string().max(400),
        horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
      })
    )
    .max(6)
    .optional(),
  // W8 · one-paragraph framing of the findings against FMCG/Marico priors.
  domainLens: z.string().max(900).optional(),
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
  LENGTH: aim for 600–1200 words for analytical questions, 80–150 words for simple/
  conversational questions. Do not pad with filler — every paragraph must add either a
  finding, a numeric claim, an interpretation grounded in the domain context, or a
  recommendation. Prefer 4–7 paragraphs of grounded prose over bullet-spam.
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

W3 · AnswerEnvelope — REQUIRED for analytical questions, omit each field independently
when not applicable:
- "tldr": ≤280 chars, ONE sentence that states the headline answer up-front. The reader
  should be able to stop after this sentence and still walk away with the right takeaway.
- "findings": 2–5 ordered entries, each {headline (≤200 chars), evidence (≤600 chars),
  magnitude?}. The headline is the claim; the evidence is the data that backs it
  (cite numbers from the blackboard verbatim); the magnitude is the single most
  important number in human-readable form (e.g. "+12.4% YoY", "$3.2M shortfall").
- "methodology": ≤500 chars on what tools / data / time-window were used. Plain prose,
  no JSON. Helps the reader judge the answer's reliability.
- "caveats": 0–3 short bullets on what limits the conclusion (sample-size,
  missing-data, ambiguous definitions, etc.). Omit when nothing material is missing.

W8 · Decision-grade extensions — REQUIRED for analytical questions:
- "implications": 2–4 entries, each {statement, soWhat, confidence?}. \`statement\` is the
  observed fact (one sentence, grounded in findings); \`soWhat\` is the business meaning
  for an FMCG operator — a buyer, brand manager, channel head — framed using DOMAIN
  KNOWLEDGE when relevant. Confidence is "low" / "medium" / "high".
- "recommendations": 2–4 entries, each {action, rationale, horizon?}. \`action\` is a
  concrete next step the team can take; \`rationale\` ties it to a specific finding and
  the domain context. \`horizon\` is "now" (this week), "this_quarter", or "strategic".
- "domainLens": ≤500 chars, one paragraph framing the findings against the relevant
  FMCG/Marico domain context. Cite the pack id verbatim when you reference it (e.g.
  "Per \`marico-haircare-portfolio\`, …"). Omit when no domain pack is relevant.
  Treat domain packs as orientation only — never invent domain facts.

Phase-1 rich envelope — REQUIRED whenever the user message declares a non-empty questionShape:
- "magnitudes": 2–4 entries that back your main claim. Each: {label, value, confidence?}. MUST come from findings — never invent.
- "unexplained": one sentence (≤180 chars) on what could NOT be determined. Omit if nothing material is missing.
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
        // WTL2 · 6_000 → 10_000. Narrator output IS the user-visible answer.
        // Rich envelopes (findings + implications + recommendations + caveats
        // + methodology + domainLens) plus the WGR5 growth-prominence rule
        // routinely brushed against 6k. Claude Opus 4.7 has plenty of output
        // headroom; this gives the answer room to be substantive.
        maxTokens: 10_000,
        temperature: 0.25,
        onLlmCall,
        purpose: LLM_PURPOSE.NARRATOR,
        onPartial: streaming!.onPartial,
      })
    : await completeJson(system, user, narratorOutputSchema, {
        turnId: `${turnId}_narrator${repair ? "_repair" : ""}`,
        // W8 · 4000 → 6000. The W8 prompt now requires implications,
        // recommendations, and a domainLens paragraph on top of the existing
        // envelope — earlier we sometimes hit the 4k cap and silently truncated
        // late findings. 6k still leaves ~2k headroom for prose.
        // WTL2 · 6_000 → 10_000. Narrator output IS the user-visible answer.
        // Rich envelopes (findings + implications + recommendations + caveats
        // + methodology + domainLens) plus the WGR5 growth-prominence rule
        // routinely brushed against 6k. Claude Opus 4.7 has plenty of output
        // headroom; this gives the answer room to be substantive.
        maxTokens: 10_000,
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
