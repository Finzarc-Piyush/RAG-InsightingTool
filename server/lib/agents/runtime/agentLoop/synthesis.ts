/**
 * agentLoop/synthesis.ts — the fallback final-answer synthesizer for the agent loop.
 *
 * WHY IT LIVES HERE (and not in agentLoop.service.ts)
 *   `synthesizeFinalAnswerEnvelope` + its retry helpers (`runNarrativeRetry`,
 *   `runPlainTextRetry`) + the zod shapes they emit (`magnitudeSchema`,
 *   `finalAnswerEnvelopeSchema`) + the `SynthesisSource` tag union form a
 *   cohesive, LOW-COUPLING cluster: every input arrives as an explicit argument
 *   (ctx, observations, turnId, the `onLlmCall` budget tick, the optional RAG
 *   block) and the helpers depend only on EXTERNAL modules (`buildSynthesisContext`,
 *   `sharedPrompts`, `llmJson`, `insightModelConfig`, `synthesisFallback`,
 *   `agentLoopFormatters`, `callLlm`) — never on any mutable closure state inside
 *   `runAgentTurn`. Pulling them into a sibling module shrinks the god-file
 *   (ARCH-1 / CQ-1); they were previously left inline ONLY because source-grep
 *   tests (`tests/synthesisRetry.test.ts`) pinned their literals to the service
 *   path. Those tests now point here (the L-017 pattern: move + re-point + back
 *   it with a behavioural characterization test).
 *
 *   `agentLoop.service.ts` imports them back for internal use AND re-exports the
 *   public symbols so any file importing them from the agent-loop path keeps
 *   resolving unchanged.
 *
 * WHAT IT DOES
 *   `synthesizeFinalAnswerEnvelope` is the FALLBACK writer (used when the narrator
 *   is skipped or returns null): it asks the LLM for a structured JSON answer
 *   envelope and, if JSON synthesis fails or returns an empty body, walks a
 *   retry chain — JSON envelope → narrative_retry → plain_text_retry →
 *   fallback_dump — tagging every return with a `SynthesisSource` so downstream
 *   (answerSource tracking, verifier skip) knows what produced the answer.
 */
import { z } from "zod";
// W-SR1 · single shared definition of the hedged causal lane, imported directly
// from the schema module (not the barrel) to stay clear of import cycles.
import { likelyDriversSchema } from "../../../../shared/schema/charts.js";
import type { AgentExecutionContext } from "../types.js";
import {
  buildSynthesisContext,
  formatSynthesisContextBundle,
} from "../buildSynthesisContext.js";
import { ANALYST_PREAMBLE, ANSWER_ENVELOPE_CONTRACT } from "../sharedPrompts.js";
import { completeJson } from "../llmJson.js";
import {
  getInsightModel,
  getInsightTemperatureConservative,
} from "../../../insightSynthesis/insightModelConfig.js";
import { LLM_PURPOSE } from "../llmCallPurpose.js";
import { renderFallbackAnswer } from "../synthesisFallback.js";
import { formatAnswerFromEnvelope } from "../agentLoopFormatters.js";
import { callLlm } from "../callLlm.js";

/** PR 1.G — rich envelope for Phase-1 shapes. All new fields optional. */
export const magnitudeSchema = z.object({
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(120),
  confidence: z.enum(["low", "medium", "high"]).optional(),
});

// `body` MUST be non-empty (`.min(1)`): an empty body would validate silently
// and cascade through every downstream check until the final answer degraded to
// the deterministic observation dump. Caps mirror the narrator /
// messageAnswerEnvelope schemas so this fallback path produces the same shape.
export const finalAnswerEnvelopeSchema = z.object({
  body: z.string().min(1),
  keyInsight: z.string().nullable().optional(),
  ctas: z.array(z.string()).max(3),
  magnitudes: z.array(magnitudeSchema).optional(),
  unexplained: z.string().max(1200).optional(),
  // Decision-grade extensions, mirrored from the narrator schema so the
  // synthesizer fallback path produces the same envelope shape and the
  // AnswerCard renders identical sections regardless of which writer ran.
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
  domainLens: z.string().max(2000).optional(),
  // W-SR1 · the synthesizer fallback emits the same hedged causal lane as the
  // narrator, so the AnswerCard renders an identical "Why" section either way.
  likelyDrivers: likelyDriversSchema,
});

/**
 * W2 · `source` tags which path produced `answer`. Downstream (W3/W4) uses
 * this to decide whether the answer is a real LLM-authored narrative or a
 * deterministic placeholder — the verifier is skipped for `fallback_dump`.
 */
export type SynthesisSource =
  | "json_envelope"
  | "narrative_retry"
  | "plain_text_retry"
  | "fallback_dump";

export async function synthesizeFinalAnswerEnvelope(
  ctx: AgentExecutionContext,
  observations: string[],
  turnId: string,
  onLlmCall: () => void,
  upfrontRagHitsBlock?: string
): Promise<{
  answer: string;
  keyInsight?: string;
  ctas: string[];
  suggestionHints: string[];
  magnitudes?: z.infer<typeof magnitudeSchema>[];
  unexplained?: string;
  implications?: z.infer<typeof finalAnswerEnvelopeSchema>["implications"];
  recommendations?: z.infer<typeof finalAnswerEnvelopeSchema>["recommendations"];
  likelyDrivers?: z.infer<typeof finalAnswerEnvelopeSchema>["likelyDrivers"];
  source: SynthesisSource;
}> {
  // W8 · the W7 bundle replaces the previous raw SessionAnalysisContext JSON
  // dump and per-call user-notes block. It carries data understanding, user
  // identity, RAG hits (round 1 + round 2), and FMCG/Marico domain packs.
  const synthBundleBlock = formatSynthesisContextBundle(
    buildSynthesisContext(ctx, {
      upfrontRagHitsBlock,
      blackboard: ctx.blackboard,
      // Wave W-UD8 · forward the per-turn trim sink so the chatStream
      // service can emit a `context_trimmed` SSE row.
      contextTrimmedSink: ctx.contextTrimmedSink,
    })
  );
  const phase1Shape = ctx.analysisBrief?.questionShape;
  const phase1Line = phase1Shape
    ? `questionShape: ${phase1Shape}\n`
    : `questionShape: none\n`;
  const bundleSection = synthBundleBlock ? `\n\n${synthBundleBlock}` : "";
  const user = `${phase1Line}Question: ${ctx.question}${bundleSection}\n\nObservations:\n${observations.join("\n\n---\n\n").slice(0, 20_000)}`;

  // W4.2 · system is byte-stable across calls: the phase-1 envelope template
  // is unconditionally present, the per-call questionShape is in the user
  // message above. ANALYST_PREAMBLE pushes the prefix over Azure's 1024-token
  // cache threshold for the 50% input discount.
  const system = `${ANALYST_PREAMBLE}You are a senior data analyst. Using ONLY the observations from tools (figures and quoted facts), produce JSON. The user message also carries a CONTEXT BUNDLE with four labelled sections — DATA UNDERSTANDING, USER CONTEXT, RELATED CONTEXT (RAG / web), and DOMAIN KNOWLEDGE (FMCG/Marico). Use them to enrich interpretation, but figures still come only from observations. RELATED CONTEXT may include open-web hits (tagged \`[web:tavily:N]\`) — cite them inline when material; never use them as numeric evidence.

Required:
- "body": main markdown answer. Lead with the direct answer. LENGTH — calibrate to the question, not to a fixed band. A "descriptive" lookup is one or two sentences with the number. A "comparison" between segments is a few short paragraphs. A "driver_discovery" / "variance_diagnostic" / open "exploration" may warrant a multi-paragraph dive. Every paragraph must add a finding, a number, an interpretation grounded in the domain context, or a recommendation — no padding. Brevity is a feature; match length to what the user actually asked. Do not duplicate the full keyInsight inside body.
  HARD CONSTRAINTS on body content: (1) Do NOT open with a methodology recap — phrases like "X has been calculated by grouping…", "the analysis was performed by summing…", "we computed X by aggregating…" are banned. The first sentence must state the headline finding with its number. (2) Do NOT include a paragraph describing dataset shape (rows × columns), data-quality assessments ("the dataset is clean", "well-structured for this purpose"), or hypothesis-confirmation language ("the findings align with the hypothesis"). The reader assumes the data was usable; surface genuine limitations only in implications/recommendations, not body prose.
- "keyInsight": optional substantive takeaway (1–4 sentences, or null if nothing beyond the body adds value). Interpret what the numbers imply for decisions — segments, risk, opportunity, or "so what" for the business. Use general knowledge only where it does not contradict the data. Do not repeat the question. If the result is purely descriptive with no extra implication, use null.
- "ctas": 0 to 3 short, actionable follow-up prompts (different angles from body; no numbering in strings). Use empty array if none fit.
Numeric claims, extremes, and trends must match tool output (aggregated tables, formatted results, chart summaries). Do not invent order-level or row-level numbers that do not appear in observations.
If data is insufficient, say what is missing in body and use minimal ctas. Respect the CONTEXT BUNDLE when it does not contradict the data.
If observations mention zero analytical results, "0 rows", or "Diagnostic:" with distinct value samples, explain that concretely in body (likely filter/label mismatch or missing column) using those samples — do NOT ask vague clarification when the user question was already specific.

${ANSWER_ENVELOPE_CONTRACT}`;

  const out = await completeJson(system, user, finalAnswerEnvelopeSchema, {
    turnId: `${turnId}_synth`,
    // Headroom for richer answers when the question warrants it (length bands are
    // not enforced; the model calibrates to the question).
    maxTokens: 8000,
    temperature: getInsightTemperatureConservative(),
    model: getInsightModel(),
    onLlmCall,
    purpose: LLM_PURPOSE.FINAL_ANSWER,
  });

  // W2 · when JSON-mode synthesis fails (or returns empty body — now caught
  // by `body: z.string().min(1)` so this path also fires for the previously-
  // silent empty-body case), run a stricter plain-text retry that is
  // structurally hard to short-circuit. Only after this also fails do we
  // fall to the deterministic dump.
  if (!out.ok) {
    const narrativeRetry = await runNarrativeRetry(user, onLlmCall);
    if (narrativeRetry) {
      return {
        answer: narrativeRetry,
        ctas: [],
        suggestionHints: [],
        source: "narrative_retry",
      };
    }
    const softRetry = await runPlainTextRetry(user, onLlmCall);
    if (softRetry) {
      return {
        answer: softRetry,
        ctas: [],
        suggestionHints: [],
        source: "plain_text_retry",
      };
    }
    // W3 · Replace the legacy `Summary from tool output:` dump with a clean
    // markdown render of the latest tool's Sample[] block, or a one-line
    // apology if no parseable Sample exists. The literal observation
    // prefixes (`[execute_query_plan]`, etc.) must never reach the user.
    const fallback = renderFallbackAnswer(observations);
    return {
      answer: fallback.content,
      ctas: [],
      suggestionHints: [],
      source: "fallback_dump",
    };
  }

  const { body, keyInsight, ctas, magnitudes, unexplained, implications, recommendations, likelyDrivers } = out.data;
  const ki = keyInsight?.trim() || undefined;
  const ctaList = (ctas ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
  const cleanedMagnitudes =
    Array.isArray(magnitudes) && magnitudes.length > 0
      ? magnitudes
          .filter((m) => m && m.label && m.value)
          .slice(0, 6)
      : undefined;
  const cleanedUnexplained = unexplained?.trim()?.slice(0, 800) || undefined;
  // W8 · scrub empty/blank entries the model occasionally returns so the UI
  // doesn't render half-empty rows. The schema caps but never enforces non-
  // empty fields (other than body), so we filter here.
  const cleanedImplications =
    Array.isArray(implications) && implications.length > 0
      ? implications
          .filter((i) => i && i.statement?.trim() && i.soWhat?.trim())
          .slice(0, 4)
      : undefined;
  const cleanedRecommendations =
    Array.isArray(recommendations) && recommendations.length > 0
      ? recommendations
          .filter((r) => r && r.action?.trim() && r.rationale?.trim())
          .slice(0, 4)
      : undefined;
  // W-CP1 · pass the hedged causal lane through (non-empty only); the agent loop
  // applies the deterministic sanitize uniformly across narrator + synth paths.
  const cleanedLikelyDrivers =
    Array.isArray(likelyDrivers) && likelyDrivers.length > 0
      ? likelyDrivers.filter((d) => d && d.explanation?.trim()).slice(0, 5)
      : undefined;
  // `body.min(1)` in the schema means `body` is guaranteed non-empty here,
  // but `formatAnswerFromEnvelope` is the same fn used by the narrator
  // elsewhere — keeping the empty-trim guard as a defence costs us nothing
  // and protects against future schema relaxations.
  const answer = formatAnswerFromEnvelope(body ?? "", ki ?? null);
  const suggestionHints = [...ctaList, ...(ki ? [ki] : [])];

  if (!answer.trim()) {
    const narrativeRetry = await runNarrativeRetry(user, onLlmCall);
    if (narrativeRetry) {
      return {
        answer: narrativeRetry,
        ctas: ctaList,
        suggestionHints,
        ...(cleanedMagnitudes ? { magnitudes: cleanedMagnitudes } : {}),
        ...(cleanedUnexplained ? { unexplained: cleanedUnexplained } : {}),
        ...(cleanedImplications ? { implications: cleanedImplications } : {}),
        ...(cleanedRecommendations ? { recommendations: cleanedRecommendations } : {}),
        ...(cleanedLikelyDrivers ? { likelyDrivers: cleanedLikelyDrivers } : {}),
        source: "narrative_retry",
      };
    }
    // W3 · Replace the legacy `Summary from tool output:` dump with a clean
    // markdown render of the latest tool's Sample[] block, or a one-line
    // apology if no parseable Sample exists. The literal observation
    // prefixes (`[execute_query_plan]`, etc.) must never reach the user.
    const fallback = renderFallbackAnswer(observations);
    return {
      answer: fallback.content,
      ctas: [],
      suggestionHints: [],
      source: "fallback_dump",
    };
  }

  return {
    answer,
    keyInsight: ki,
    ctas: ctaList,
    suggestionHints,
    ...(cleanedMagnitudes ? { magnitudes: cleanedMagnitudes } : {}),
    ...(cleanedUnexplained ? { unexplained: cleanedUnexplained } : {}),
    ...(cleanedImplications ? { implications: cleanedImplications } : {}),
    ...(cleanedRecommendations ? { recommendations: cleanedRecommendations } : {}),
    ...(cleanedLikelyDrivers ? { likelyDrivers: cleanedLikelyDrivers } : {}),
    source: "json_envelope",
  };
}

/**
 * W2 · "guaranteed narrative" retry — a stricter prompt than the legacy chat
 * retry. Designed to be structurally incapable of returning an empty answer
 * or echoing the deterministic-fallback prefix. Returns the trimmed prose
 * on success, or `null` if the model still produces nothing usable.
 */
export async function runNarrativeRetry(
  user: string,
  onLlmCall: () => void
): Promise<string | null> {
  onLlmCall();
  const { MODEL } = await import("../../../openai.js");
  const res = await callLlm(
    {
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a data analyst. The previous attempt returned an empty answer. " +
            "Write 2–4 sentences of plain prose that directly answer the user's question " +
            "using the observations below. You MUST cite at least two specific numbers from " +
            "the observations. Do NOT output JSON. Do NOT use code fences. Do NOT begin with " +
            "'Summary from' or echo the observations verbatim. Begin with the direct answer.",
        },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      // The narrative retry is "2-4 sentences" but for big analytical questions
      // those sentences carry compact prose with several numeric citations.
      // Headroom prevents mid-sentence clipping.
      max_tokens: 4000,
    },
    { purpose: LLM_PURPOSE.FINAL_ANSWER }
  );
  const text = res.choices[0]?.message?.content?.trim() ?? "";
  if (!text) return null;
  // Hard guard against the model parroting the deterministic-fallback prefix.
  if (text.toLowerCase().startsWith("summary from")) return null;
  return text;
}

/**
 * W2 · the original chat-mode retry kept as a softer second attempt. Less
 * strict than `runNarrativeRetry` so a model that refuses the strict prompt
 * still has a chance to produce something usable before we fall to the dump.
 */
export async function runPlainTextRetry(
  user: string,
  onLlmCall: () => void
): Promise<string | null> {
  onLlmCall();
  const { MODEL } = await import("../../../openai.js");
  const res = await callLlm(
    {
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a data analyst. Answer using ONLY tool observations. If results are empty, cite diagnostics and distinct samples from observations; do not give vague clarifying questions when the user was specific.",
        },
        { role: "user", content: user },
      ],
      temperature: 0.35,
      // Plain-text retry is the softer fallback path that can legitimately
      // produce a long answer for a deep analytical question.
      max_tokens: 8000,
    },
    { purpose: LLM_PURPOSE.FINAL_ANSWER }
  );
  const text = res.choices[0]?.message?.content?.trim() ?? "";
  if (!text) return null;
  if (text.toLowerCase().startsWith("summary from")) return null;
  return text;
}
