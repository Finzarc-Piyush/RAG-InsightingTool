/**
 * ============================================================================
 * narratorAgent.ts — turn the agent's findings into the written, business-ready
 *                   answer the user reads
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This is the "writer" step at the end of an investigation. It reads the
 *   analytical blackboard (the structured record of which hypotheses were tested,
 *   their outcomes, and the findings that emerged) and asks an LLM to compose a
 *   clear, decision-grade narrative. The output is a JSON object that maps to the
 *   app's "answer envelope": a one-line TL;DR, headline findings with evidence,
 *   the so-what implications, recommended next steps, methodology, caveats, and
 *   key magnitudes (the important numbers). Most of this file is a very detailed
 *   system prompt that enforces a manager-friendly voice (plain English, no
 *   jargon, compact numbers, no padding, only numbers that actually appear in the
 *   evidence) and many domain-specific rules (growth, seasonality, share-of-
 *   category, confidence tiers, time-trend caveats).
 *
 * WHY IT MATTERS
 *   This is what makes answers read like a senior analyst wrote them rather than
 *   a raw data dump. It is the final synthesis stage of the plan/act loop: the
 *   agent gathers evidence, then the narrator explains it. It also supports a
 *   "repair" mode where the verifier flags problems and the narrator rewrites,
 *   and a streaming mode so the user sees the answer appear progressively.
 *
 * KEY PIECES
 *   - runNarrator(...) — the main function. Builds the system + user prompts,
 *     calls the LLM (streaming or not), validates the JSON, logs, returns the
 *     parsed answer or null on failure (caller then falls back to the synthesizer).
 *   - narratorOutputSchema / NarratorOutput — the zod schema + type for the JSON
 *     the narrator must emit (body, tldr, findings, implications, etc.).
 *   - NarratorRepairContext — extra input when re-running after a verifier asks
 *     for a rewrite (the flagged issues + the prior draft to improve, not repeat).
 *   - NarratorStreamingHook — optional callback that receives partial output so
 *     the UI can stream the answer as it's generated.
 *   - shouldUseNarrator — re-exported gate deciding when the narrator path is used.
 *
 * HOW IT CONNECTS
 *   Reads the blackboard via formatForNarrator (./analyticalBlackboard.js),
 *   builds extra context via buildSynthesisContext / formatSynthesisContextBundle
 *   (./buildSynthesisContext.js), confidence hints via ./narratorHintsBlock.js,
 *   and dimension hierarchies via ./context.js. It calls the LLM through
 *   completeJson / completeJsonStreaming (./llmJson.js) under the NARRATOR
 *   purpose. When the blackboard has no findings (dataOps turns, or the
 *   hypothesis planner was skipped), the caller instead falls back to
 *   synthesizeFinalAnswerEnvelope.
 */

import { z } from "zod";
// W-SR1 · single shared definition of the hedged "Why this might be happening"
// causal lane (imported from the schema module directly to avoid a barrel cycle).
import { likelyDriversSchema } from "../../../shared/schema/charts.js";
import { completeJson, completeJsonStreaming, isStreamingNarratorEnabled } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE, ANSWER_ENVELOPE_CONTRACT } from "./sharedPrompts.js";
import { UNTRUSTED_CONTENT_RULE } from "./untrustedContent.js";
import { agentLog } from "./agentLogger.js";
import {
  formatForNarrator,
  type AnalyticalBlackboard,
} from "./analyticalBlackboard.js";
import {
  buildNarratorConfidenceBlock,
  buildNarratorCalendarBlock,
  summarizeNarratorConfidence,
} from "./narratorHintsBlock.js";
import {
  buildSynthesisContext,
  formatSynthesisContextBundle,
} from "./buildSynthesisContext.js";
import { formatDimensionHierarchiesBlock } from "./context.js";
import type { AgentExecutionContext } from "./types.js";

export { shouldUseNarrator } from "./analyticalBlackboard.js";

// Exported so the W-SR1 forward-parity test can pin that a likelyDrivers array
// which parses on the persisted/dashboard/synthesis schemas also parses here.
export const narratorOutputSchema = z.object({
  body: z.string(),
  keyInsight: z.string().nullable().optional(),
  // `.optional()` (rather than `.default([])`) avoids a TS input/output type
  // mismatch when read via `z.infer`. Runtime behaviour is unchanged — callers
  // already coerce `undefined → []` — and the inferred return type stays
  // compatible with `runNarrator`'s signature.
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
  // AnswerEnvelope — optional structured rendering hints. Narrator may emit any
  // subset; the UI's AnswerCard renders whichever fields are present and falls
  // back to `body` markdown for the rest. Caps are kept in lockstep with
  // shared/schema.ts answerEnvelope so output that passes the local validator
  // also passes the persistence schema.
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
  // "So what" reading of the headline findings.
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
  // IUX3 · Concrete recommended business moves, grouped by horizon. Each carries
  // an optional `expectedImpact` (the manager-facing "what changes if we do this").
  recommendations: z
    .array(
      z.object({
        action: z.string().max(400),
        rationale: z.string().max(800),
        expectedImpact: z.string().max(240).optional(),
        horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
      })
    )
    .max(12)
    .optional(),
  // One-paragraph framing of the findings against FMCG/Marico priors.
  domainLens: z.string().max(2000).optional(),
  // W-SR1 · the hedged "Why this might be happening" causal lane. The narrator
  // is the primary producer; this is the field the AnswerCard's "Why" section
  // reads. Empty/omitted when the answer has no plausible mechanism to offer.
  likelyDrivers: likelyDriversSchema,
});

export type NarratorOutput = z.infer<typeof narratorOutputSchema>;

/**
 * RNK-f6 · Remove internal blackboard finding-reference tokens (`[f1]`, `[f6]`,
 * …) that the narrator occasionally echoes into user-facing prose. Those
 * bracketed IDs exist only inside `formatForNarrator`'s blackboard block for the
 * model's own reference and must never reach the rendered answer. Backtick-
 * wrapped domain-pack citations and ordinary bracketed text are left untouched —
 * the pattern matches only `[f<digits>]`.
 */
export function stripFindingReferenceTokens(s: string): string {
  return s.replace(/\s?\[f\d+\]/gi, "");
}

function stripRef<T extends string | null | undefined>(s: T): T {
  return (typeof s === "string" ? stripFindingReferenceTokens(s) : s) as T;
}

/** Map `stripFindingReferenceTokens` over every prose field of a NarratorOutput. */
function stripFindingRefs(out: NarratorOutput): NarratorOutput {
  return {
    ...out,
    body: stripRef(out.body),
    keyInsight: stripRef(out.keyInsight),
    tldr: stripRef(out.tldr),
    methodology: stripRef(out.methodology),
    domainLens: stripRef(out.domainLens),
    unexplained: stripRef(out.unexplained),
    caveats: out.caveats?.map(stripRef),
    findings: out.findings?.map((f) => ({
      ...f,
      headline: stripRef(f.headline),
      evidence: stripRef(f.evidence),
      magnitude: stripRef(f.magnitude),
    })),
    implications: out.implications?.map((i) => ({
      ...i,
      statement: stripRef(i.statement),
      soWhat: stripRef(i.soWhat),
    })),
    recommendations: out.recommendations?.map((r) => ({
      ...r,
      action: stripRef(r.action),
      rationale: stripRef(r.rationale),
      expectedImpact: stripRef(r.expectedImpact),
    })),
    magnitudes: out.magnitudes?.map((m) => ({ ...m, label: stripRef(m.label) })),
    ctas: out.ctas?.map(stripRef),
    // W-SR1 · scrub internal [fN] refs from the causal lane's prose too.
    likelyDrivers: out.likelyDrivers?.map((d) => ({
      ...d,
      explanation: stripRef(d.explanation),
    })),
  };
}

/**
 * Narrator-repair branch.
 *
 * When the deep verifier returns `revise_narrative`, the agent loop hands the
 * issues + the prior draft back into runNarrator (rather than a plain rewrite
 * path that would lose blackboard context). Both fields are optional —
 * `priorDraft` lets the model see what it said last time so it can preserve
 * good content while fixing the flagged issues.
 */
export interface NarratorRepairContext {
  issues: string;
  priorDraft?: string;
  courseCorrection?: string;
}

/**
 * Streaming-mode hook. When provided, the narrator uses
 * `completeJsonStreaming` and forwards each chunk's accumulated raw text to
 * `onPartial`. Repair calls ignore this and stay non-streaming — the user
 * already saw the initial draft, so re-streaming a rewrite would visually thrash.
 */
export interface NarratorStreamingHook {
  onPartial: (chunk: { rawSoFar: string; delta: string }) => void;
}

/**
 * Run the narrator to produce an investigation narrative from the blackboard.
 * Returns null if the LLM call fails (caller uses the synthesizer fallback).
 */
export async function runNarrator(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string,
  onLlmCall: () => void,
  repair?: NarratorRepairContext,
  streaming?: NarratorStreamingHook,
  /**
   * Structured tool I/O captured by the agent loop. When provided, the
   * narrator's data-understanding block lists each step's tool, args, and row
   * count — so it can distinguish "this step queried the whole dataset" from
   * "this step filtered to Central only".
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
    /** Full ToolResult — forwarded so the synthesis context can surface the
     *  complete rows of small aggregated steps (e.g. a 24-row ASM ranking). */
    result?: unknown;
  }>
): Promise<NarratorOutput | null> {
  const blackboardBlock = formatForNarrator(blackboard);
  if (!blackboardBlock.trim()) return null;

  // The synthesis-context bundle carries data understanding, user identity,
  // RAG hits (including blackboard round-2 entries), and FMCG/Marico domain
  // packs in stable byte-order so the prefix cache holds across calls.
  const synthBundleBlock = formatSynthesisContextBundle(
    buildSynthesisContext(ctx, { blackboard, structuredObservations })
  );
  const phase1Shape = ctx.analysisBrief?.questionShape;

  // The system prompt is byte-stable across calls — the phase-1 envelope
  // template is unconditionally present, and per-call questionShape is moved
  // to the user message. Combined with ANALYST_PREAMBLE this clears Azure's
  // 1024-token prefix-cache threshold so the prompt prefix can be cached.
  const system = `${ANALYST_PREAMBLE}You are a senior data analyst presenting the results of a completed investigation.
You have access to a structured blackboard: the hypotheses that were tested, their outcomes
(confirmed / refuted / partial / open), and the findings that emerged. The user message also
carries a CONTEXT BUNDLE with four labelled sections — DATA UNDERSTANDING, USER CONTEXT,
RELATED CONTEXT (RAG / web), and DOMAIN KNOWLEDGE (FMCG/Marico). Use them to make the answer
substantive and decision-grade. The RELATED CONTEXT block may include open-web hits (tagged
\`[web:tavily:N]\`) — treat them identically to RAG hits: background grounding for
interpretation and inline citation, never numeric evidence. Figures still come only from
the blackboard / observations.
${UNTRUSTED_CONTENT_RULE}

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
  • NEVER emit blackboard finding-reference tokens like [f1], [f2], [f6] in ANY field
    (body, tldr, keyInsight, findings, implications, recommendations, methodology,
    caveats, magnitudes). Those bracketed IDs are for your internal reference only —
    weave the underlying fact into prose instead of citing the bracket.
- "keyInsight": 1–3 sentences on what the findings imply for decisions (the "so what").
  Use null if nothing beyond the body adds value.
- "ctas": 0 to 3 actionable follow-up prompts (empty array if none fit). Each MUST ask
  exactly ONE thing and be answerable in a single query. NEVER combine clauses with
  "and" / "or" or list multiple dimensions. Split any compound ask into separate single
  questions. Keep each short.
  Each cta must lead to a DEEPER dive — not a restatement of a breakdown the user can
  already see. Do NOT suggest a plain "How does <metric> vary by <dimension>?" when that
  breakdown is already covered by a finding or chart; that just re-asks what's answered.
  Prefer the next question the findings provoke: WHY a gap exists ("What explains the gap
  between the top and bottom <dimension> on <metric>?"), a CROSS-CUT the single-dimension
  views can't show ("Within each <dimension A>, how does <metric> vary by <dimension B>?"),
  an OUTLIER drill-down ("Which <dimension> values are the biggest outliers on <metric>,
  and why?"), a TREND, or a relationship to ANOTHER metric.
  BAD (flat restatement): "How do compliance visits vary by ASM?"
  GOOD (deeper): "What explains why Cluster 2 NORTH's compliance runs 45% below average?"
- Do NOT invent numbers not present in the findings. If a hypothesis has no evidence, say
  it remains open and explain why.

${ANSWER_ENVELOPE_CONTRACT}`;

  const phase1Line = phase1Shape
    ? `questionShape: ${phase1Shape}\n`
    : `questionShape: none\n`;
  // When re-invoked after a verifier `revise_narrative` verdict, append the
  // issues + course correction + prior draft so the model can do a grounded
  // rewrite instead of starting blind. Slices cap each piece to keep the user
  // prompt within the existing budget.
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
  // Extracts statistical evidence (n / p / R² / CI) from each finding's detail
  // text and emits a FINDING_CONFIDENCE block pinning per-finding tiers +
  // canonical hedge phrases. The narrator uses the tier to set
  // magnitudes[].confidence and implications[].confidence, and weaves the
  // hedge into prose for medium / low findings.
  const confidenceBlock = buildNarratorConfidenceBlock(blackboard);
  const confidenceSection = confidenceBlock ? `\n\n${confidenceBlock}` : "";
  // Deterministic day-of-week grounding for the MAIN narrative: if the turn's
  // daily series has a recurring weekly off-day (e.g. Sundays at ~0), explain
  // the trend's ups-and-downs by the calendar instead of speculating. Mirrors
  // the per-chart Key-Insight grounding (insightGenerator.ts).
  const calendarBlock = buildNarratorCalendarBlock(ctx);
  const calendarSection = calendarBlock ? `\n\n${calendarBlock}` : "";
  // W-CP1 · thread the analysis brief's epistemic notes (e.g. "avoid claiming
  // causation from observational data alone") into the USER message so the
  // narrator calibrates its likelyDrivers hedging. Kept in the user block (not
  // the system prompt) so the cacheable system prefix stays byte-stable.
  const epistemicNotes = ctx.analysisBrief?.epistemicNotes ?? [];
  const epistemicSection = epistemicNotes.length
    ? `\n\nEPISTEMIC NOTES (calibrate hedging; the measured layer must stay causation-free, the "why" goes only in likelyDrivers):\n${epistemicNotes
        .map((n) => `- ${n}`)
        .join("\n")}`
    : "";
  const user = `${phase1Line}Question: ${ctx.question}\n\n${blackboardBlock}${confidenceSection}${calendarSection}${bundleSection}${hierarchySection}${epistemicSection}${repairBlock}`;

  // Use the streaming variant when (1) the env flag is on, (2) the caller
  // supplied a streaming hook, AND (3) this is the initial call (not a repair).
  // Repairs stay non-streaming because the user already saw the initial draft;
  // streaming a repair would visually thrash.
  const useStreaming = !repair && Boolean(streaming) && isStreamingNarratorEnabled();
  const result = useStreaming
    ? await completeJsonStreaming(system, user, narratorOutputSchema, {
        turnId: `${turnId}_narrator_stream`,
        // Generous cap: with rigid length bands removed and per-field schema
        // caps relaxed, deep analytical dives can legitimately produce 15
        // findings + 12 implications + 12 recommendations + extended
        // methodology and domainLens. The cap exists only as runaway protection.
        maxTokens: 24_000,
        temperature: 0.25,
        onLlmCall,
        purpose: LLM_PURPOSE.NARRATOR,
        onPartial: streaming!.onPartial,
      })
    : await completeJson(system, user, narratorOutputSchema, {
        turnId: `${turnId}_narrator${repair ? "_repair" : ""}`,
        // Generous cap — see streaming branch above for rationale.
        maxTokens: 24_000,
        temperature: 0.25,
        onLlmCall,
        purpose: LLM_PURPOSE.NARRATOR,
      });

  if (!result.ok) {
    agentLog("narratorAgent.failed", { turnId, error: result.error, repair: !!repair });
    return null;
  }

  const confidenceSummary = summarizeNarratorConfidence(blackboard);
  agentLog(repair ? "narratorAgent.repair" : "narratorAgent.done", {
    turnId,
    hypotheses: blackboard.hypotheses.length,
    findings: blackboard.findings.length,
    repair: !!repair,
    confidence_high: confidenceSummary.high,
    confidence_medium: confidenceSummary.medium,
    confidence_low: confidenceSummary.low,
  });

  // RNK-f6 · defensive strip of internal `[fN]` finding refs before the draft
  // leaves the narrator — keeps stray blackboard tokens out of the rendered answer.
  return stripFindingRefs(result.data);
}
