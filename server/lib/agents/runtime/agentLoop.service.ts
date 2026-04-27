import { randomUUID } from "crypto";
import { z } from "zod";
import type {
  AgentConfig,
  AgentExecutionContext,
  AgentLoopResult,
  AgentMidTurnSessionPayload,
  AgentTrace,
  PlanStep,
  ToolCallRecord,
  WorkingMemoryEntry,
} from "./types.js";
import { AGENT_TRACE_MAX_BYTES, isInterAgentPromptFeedbackEnabled } from "./types.js";
import { ToolRegistry, type ToolResult } from "./toolRegistry.js";
import { registerDefaultTools } from "./tools/registerTools.js";
import { runPlanner, type PlannerRejectReason } from "./planner.js";
import { maybeRunAnalysisBrief } from "./analysisBrief.js";
import { generateHypotheses } from "./hypothesisPlanner.js";
import { createBlackboard, addFinding, addOpenQuestion, resolveHypothesis, formatForNarrator } from "./analyticalBlackboard.js";
import type { Finding } from "./analyticalBlackboard.js";
import { runContextAgentRound2 } from "./contextAgent.js";
import { runNarrator, shouldUseNarrator } from "./narratorAgent.js";
import {
  buildSynthesisContext,
  formatSynthesisContextBundle,
} from "./buildSynthesisContext.js";
import { buildInvestigationSummary } from "./buildInvestigationSummary.js";
import { formatWorkingMemoryBlock, groupSortedStepsForExecution } from "./workingMemory.js";
import { runReflector } from "./reflector.js";
import { runVerifier, rewriteNarrative } from "./verifier.js";
import { buildFinalEvidence } from "./verifierHelpers.js";
import { VERIFIER_VERDICT } from "./schemas.js";
import { agentLog } from "./agentLogger.js";
import { renderFallbackAnswer } from "./synthesisFallback.js";
import {
  appendInterAgentMessage,
  formatInterAgentHandoffsForPrompt,
} from "./interAgentMessages.js";
import { MODEL } from "../../openai.js";
import { callLlm } from "./callLlm.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import { getInsightModel, getInsightTemperatureConservative } from "../../insightSynthesis/insightModelConfig.js";
import { completeJson } from "./llmJson.js";
import { proposeAndBuildExtraCharts } from "./visualPlanner.js";
import { chartSpecSchema, type ChartSpec, type Insight } from "../../../shared/schema.js";
import { lintAfterAnalyticalTool } from "../../agentToolObservationLint.js";
import { registerDerivedColumnOnSummary } from "../../deriveDimensionBucket.js";
import {
  addComputedColumnsArgsSchema,
  registerComputedColumnsOnSummary,
} from "../../computedColumns.js";
import {
  validateChartProposal,
  chartRowsForProposal,
} from "./chartProposalValidation.js";
import { processChartData } from "../../chartGenerator.js";
import { buildIntermediateInsight } from "./buildIntermediateInsight.js";
import { derivePivotDefaultsFromPreviewRows } from "../../pivotDefaultsFromPreview.js";
import { sanitizeIntermediatePreviewRows } from "../../agentIntermediatePreviewSanitize.js";

function detectSignificance(summary: string): Finding["significance"] {
  if (/spike|anomal|outlier|unusual|unexpected/i.test(summary)) return "anomalous";
  if (/\b\d{1,3}\.?\d*%|\bhighest\b|\blowest\b|\btop\b|\bbottom\b|\bdeclin|\bsurg|\bjump|\bdrop/i.test(summary)) return "notable";
  return "routine";
}

const INTERMEDIATE_TABLE_TOOLS = new Set([
  "run_analytical_query",
  "execute_query_plan",
  "run_readonly_sql",
  "derive_dimension_bucket",
  "add_computed_columns",
  "run_segment_driver_analysis",
]);

function toolTableRowsForIntermediate(tr: ToolResult): Record<string, unknown>[] {
  const t = tr.table;
  if (!t) return [];
  if (Array.isArray(t)) return t as Record<string, unknown>[];
  if (typeof t === "object" && t !== null && Array.isArray((t as { rows?: unknown }).rows)) {
    return (t as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

function toolTableColumnOrderForIntermediate(tr: ToolResult): string[] | null {
  const t = tr.table;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const cols = (t as { columns?: unknown }).columns;
  if (!Array.isArray(cols)) return null;
  const out = cols.filter((v): v is string => typeof v === "string");
  return out.length ? out : null;
}
import {
  calculateSmartDomainsForChart,
  multiSeriesYDomainKind,
  yDomainForMultiSeriesRows,
} from "../../axisScaling.js";

export type AgentSseEmitter = (event: string, data: unknown) => void;

function lastAnalyticalRowsSnapshot(
  ctx: AgentExecutionContext
): Record<string, unknown>[] | undefined {
  const rows = ctx.lastAnalyticalTable?.rows;
  return rows?.length ? rows : undefined;
}

function rowKeysFromFirstRow(rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return [];
  return Object.keys(rows[0] as object);
}

/** Shape needed to rebuild a plan-time build_chart after synthesis (same frame as narrative). */
type DeferredBuildChartTemplate = Pick<ChartSpec, "type" | "title" | "x" | "y" | "aggregate"> & {
  y2?: string;
  y2Series?: string[];
  z?: string;
  seriesColumn?: string;
  barLayout?: "stacked" | "grouped";
  _agentEvidenceRef?: string;
  _agentTurnId?: string;
};

function deferredTemplateFromBuiltChart(c: ChartSpec): DeferredBuildChartTemplate {
  return {
    type: c.type,
    title: c.title,
    x: c.x,
    y: c.y,
    ...(c.y2 ? { y2: c.y2 } : {}),
    ...(c.y2Series?.length ? { y2Series: [...c.y2Series] } : {}),
    ...(c.z ? { z: c.z } : {}),
    ...(c.seriesColumn ? { seriesColumn: c.seriesColumn } : {}),
    ...(c.barLayout ? { barLayout: c.barLayout } : {}),
    ...(c.aggregate != null ? { aggregate: c.aggregate } : {}),
    ...(c._agentEvidenceRef ? { _agentEvidenceRef: c._agentEvidenceRef } : {}),
    ...(c._agentTurnId ? { _agentTurnId: c._agentTurnId } : {}),
  };
}

function rowFrameSupportsDeferredTemplate(
  first: Record<string, unknown> | undefined,
  t: DeferredBuildChartTemplate
): boolean {
  if (!first) return false;
  const keys = [
    t.x,
    t.y,
    ...(t.y2 ? [t.y2] : []),
    ...(t.y2Series ?? []),
    ...(t.z ? [t.z] : []),
    ...(t.seriesColumn ? [t.seriesColumn] : []),
  ];
  return keys.every((k) => Object.prototype.hasOwnProperty.call(first, k));
}

/**
 * Plan-time build_chart specs are deferred until after synthesis so series are built from the
 * same analytical frame the answer used (last execute_query_plan / ctx.data), not mid-plan snapshots.
 */
function materializeDeferredBuildCharts(
  ctx: AgentExecutionContext,
  deferred: DeferredBuildChartTemplate[],
  mergedCharts: ChartSpec[]
): void {
  if (!deferred.length) return;
  for (const tmpl of deferred) {
    try {
      const p = {
        type: tmpl.type,
        x: tmpl.x,
        y: tmpl.y,
        ...(tmpl.z ? { z: tmpl.z } : {}),
        ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
        ...(tmpl.barLayout ? { barLayout: tmpl.barLayout } : {}),
      };
      if (!validateChartProposal(ctx, p)) {
        // P-A5: don't silently drop; leave a breadcrumb so operators can trace
        // charts that never rendered.
        agentLog("deferredChart.dropped", {
          reason: "validateChartProposal",
          title: tmpl.title,
          x: tmpl.x,
          y: tmpl.y,
        });
        continue;
      }
      const { rows, useAnalyticalOnly } = chartRowsForProposal(ctx, p);
      const first = rows[0] as Record<string, unknown> | undefined;
      if (!rowFrameSupportsDeferredTemplate(first, tmpl)) {
        agentLog("deferredChart.dropped", {
          reason: "frameMissingColumns",
          title: tmpl.title,
          x: tmpl.x,
          y: tmpl.y,
          ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
          availableKeys: Object.keys(first ?? {}).slice(0, 12).join(", "),
        });
        continue;
      }
      const spec = chartSpecSchema.parse({
        type: tmpl.type,
        title: tmpl.title,
        x: tmpl.x,
        y: tmpl.y,
        ...(tmpl.z ? { z: tmpl.z } : {}),
        ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
        ...(tmpl.barLayout ? { barLayout: tmpl.barLayout } : {}),
        ...(tmpl.y2 ? { y2: tmpl.y2 } : {}),
        ...(tmpl.y2Series?.length ? { y2Series: tmpl.y2Series } : {}),
        aggregate: tmpl.aggregate ?? "none",
        ...(useAnalyticalOnly ? { _useAnalyticalDataOnly: true as const } : {}),
      });
      const processed = processChartData(
        rows as Record<string, any>[],
        spec,
        ctx.summary.dateColumns,
        { chartQuestion: ctx.question }
      );
      let smartDomains: Record<string, unknown> = {};
      if (spec.type === "heatmap") {
        smartDomains = {};
      } else if (spec.seriesKeys?.length) {
        const sk = spec.seriesKeys;
        smartDomains = yDomainForMultiSeriesRows(
          processed,
          sk,
          multiSeriesYDomainKind(spec.type, spec.barLayout)
        );
      } else {
        smartDomains = calculateSmartDomainsForChart(
          processed,
          spec.x,
          spec.y,
          spec.y2 || undefined,
          {
            yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
            y2Options: spec.y2 ? { useIQR: true, paddingPercent: 5, includeOutliers: true } : undefined,
          }
        );
      }
      mergedCharts.push({
        ...spec,
        xLabel: spec.x,
        yLabel: spec.y,
        data: processed,
        ...smartDomains,
        ...(tmpl._agentEvidenceRef ?
          { _agentEvidenceRef: tmpl._agentEvidenceRef }
        : {}),
        ...(tmpl._agentTurnId ? { _agentTurnId: tmpl._agentTurnId } : {}),
      });
    } catch {
      /* skip invalid */
    }
  }
  deferred.length = 0;
}

function capAgentTrace(trace: AgentTrace): AgentTrace {
  const clone: AgentTrace = {
    ...trace,
    interAgentMessages: trace.interAgentMessages?.length
      ? trace.interAgentMessages.map((m) => ({
          ...m,
          intent: m.intent.slice(0, 400),
          artifacts: m.artifacts?.slice(0, 12).map((a) => a.slice(0, 120)),
          evidenceRefs: m.evidenceRefs?.slice(0, 12).map((r) => r.slice(0, 120)),
          blockingQuestions: m.blockingQuestions
            ?.slice(0, 2)
            .map((q) => q.slice(0, 200)),
          meta: m.meta
            ? Object.fromEntries(
                Object.entries(m.meta)
                  .slice(0, 8)
                  .map(([k, v]) => [k.slice(0, 48), v.slice(0, 160)])
              )
            : undefined,
        }))
      : undefined,
    toolCalls: trace.toolCalls.map((t) => ({
      ...t,
      resultSummary: t.resultSummary
        ? t.resultSummary.slice(0, 500)
        : undefined,
    })),
    criticRounds: trace.criticRounds.slice(-20),
  };
  let encoded = JSON.stringify(clone);
  while (
    encoded.length > AGENT_TRACE_MAX_BYTES &&
    clone.interAgentMessages &&
    clone.interAgentMessages.length > 4
  ) {
    clone.interAgentMessages = clone.interAgentMessages.slice(
      -Math.max(4, Math.floor(clone.interAgentMessages.length * 0.55))
    );
    encoded = JSON.stringify(clone);
  }
  if (encoded.length <= AGENT_TRACE_MAX_BYTES) {
    return clone;
  }
  return {
    ...clone,
    interAgentMessages: clone.interAgentMessages?.slice(-8),
    toolCalls: clone.toolCalls.map((t) => ({
      ...t,
      resultSummary: t.resultSummary?.slice(0, 120),
    })),
    budgetHits: [...(clone.budgetHits || []), "trace_byte_cap"],
  };
}

/** PR 1.G — rich envelope for Phase-1 shapes. All new fields optional. */
const magnitudeSchema = z.object({
  label: z.string().min(1).max(140),
  value: z.string().min(1).max(80),
  confidence: z.enum(["low", "medium", "high"]).optional(),
});

// W2 · `body` MUST be non-empty. Without `.min(1)` the LLM was free to
// return `{ body: "", ctas: [...], magnitudes: [...] }`, which validated
// silently and cascaded through every downstream check until the final
// answer became the deterministic observation dump.
const finalAnswerEnvelopeSchema = z.object({
  body: z.string().min(1),
  keyInsight: z.string().nullable().optional(),
  ctas: z.array(z.string()).max(3),
  magnitudes: z.array(magnitudeSchema).max(6).optional(),
  unexplained: z.string().max(800).optional(),
  // W8 · decision-grade extensions, mirrored from the narrator schema so the
  // synthesizer fallback path produces the same envelope shape and the
  // AnswerCard renders identical sections regardless of which writer ran.
  implications: z
    .array(
      z.object({
        statement: z.string().max(280),
        soWhat: z.string().max(280),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .max(4)
    .optional(),
  recommendations: z
    .array(
      z.object({
        action: z.string().max(200),
        rationale: z.string().max(280),
        horizon: z.enum(["now", "this_quarter", "strategic"]).optional(),
      })
    )
    .max(4)
    .optional(),
  domainLens: z.string().max(500).optional(),
});

function lastVerdictForStep(trace: AgentTrace, stepId: string): string | undefined {
  for (let i = trace.criticRounds.length - 1; i >= 0; i--) {
    if (trace.criticRounds[i].stepId === stepId) {
      return trace.criticRounds[i].verdict;
    }
  }
  return undefined;
}

/**
 * W8 · word-count helper for `synthesis_result` telemetry. Whitespace-split
 * is good enough for tracking whether the new 600–1200-word body target is
 * being hit; we don't need locale-aware tokenisation here.
 */
function countWords(s: string): number {
  const trimmed = s?.trim() ?? "";
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function formatAnswerFromEnvelope(body: string, keyInsight: string | null | undefined): string {
  const parts: string[] = [body.trim()];
  const ki = keyInsight?.trim();
  if (ki) {
    parts.push("", `**Key insight:** ${ki}`);
  }
  return parts.join("\n").trim();
}

/**
 * W2 · `source` tags which path produced `answer`. Downstream (W3/W4) uses
 * this to decide whether the answer is a real LLM-authored narrative or a
 * deterministic placeholder — the verifier is skipped for `fallback_dump`.
 */
type SynthesisSource =
  | "json_envelope"
  | "narrative_retry"
  | "plain_text_retry"
  | "fallback_dump";

async function synthesizeFinalAnswerEnvelope(
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
  domainLens?: string;
  source: SynthesisSource;
}> {
  // W8 · the W7 bundle replaces the previous raw SessionAnalysisContext JSON
  // dump and per-call user-notes block. It carries data understanding, user
  // identity, RAG hits (round 1 + round 2), and FMCG/Marico domain packs.
  const synthBundleBlock = formatSynthesisContextBundle(
    buildSynthesisContext(ctx, {
      upfrontRagHitsBlock,
      blackboard: ctx.blackboard,
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
  const system = `${ANALYST_PREAMBLE}You are a senior data analyst. Using ONLY the observations from tools (figures and quoted facts), produce JSON. The user message also carries a CONTEXT BUNDLE with four labelled sections — DATA UNDERSTANDING, USER CONTEXT, RELATED CONTEXT (RAG), and DOMAIN KNOWLEDGE (FMCG/Marico). Use them to enrich interpretation, but figures still come only from observations.

Required:
- "body": main markdown answer. Lead with the direct answer; expand into 4–7 paragraphs of grounded prose. LENGTH: 600–1200 words for analytical questions, 80–150 words for purely conversational ones. Every paragraph must add a finding, a number, an interpretation grounded in the domain context, or a recommendation — no padding. Do not duplicate the full keyInsight inside body.
- "keyInsight": optional substantive takeaway (1–4 sentences, or null if nothing beyond the body adds value). Interpret what the numbers imply for decisions — segments, risk, opportunity, or "so what" for the business. Use general knowledge only where it does not contradict the data. Do not repeat the question. If the result is purely descriptive with no extra implication, use null.
- "ctas": 0 to 3 short, actionable follow-up prompts (different angles from body; no numbering in strings). Use empty array if none fit.
Numeric claims, extremes, and trends must match tool output (aggregated tables, formatted results, chart summaries). Do not invent order-level or row-level numbers that do not appear in observations.
If data is insufficient, say what is missing in body and use minimal ctas. Respect the CONTEXT BUNDLE when it does not contradict the data.
If observations mention zero analytical results, "0 rows", or "Diagnostic:" with distinct value samples, explain that concretely in body (likely filter/label mismatch or missing column) using those samples — do NOT ask vague clarification when the user question was already specific.

W8 · Decision-grade extensions — REQUIRED for analytical questions, omit each independently when not applicable:
- "implications": 2–4 entries, each {statement, soWhat, confidence?}. \`statement\` is the observed fact; \`soWhat\` is the business meaning for an FMCG operator (buyer, brand manager, channel head), framed using DOMAIN KNOWLEDGE when relevant.
- "recommendations": 2–4 entries, each {action, rationale, horizon?}. \`action\` is concrete; \`rationale\` ties it to a finding and the domain context; \`horizon\` ∈ {now, this_quarter, strategic}.
- "domainLens": ≤500 chars, one paragraph framing the findings against the relevant FMCG/Marico context. Cite the pack id verbatim when referenced (e.g. "Per \`marico-haircare-portfolio\`, …"). Treat domain packs as orientation only — never invent domain facts.

Phase-1 rich envelope — REQUIRED whenever the user message declares a non-empty questionShape:
- "magnitudes": 2–4 entries that back your main claim. Each entry is {label, value, confidence?}. \`label\` names what the magnitude measures (e.g. "East tech decline Mar→Apr"); \`value\` is human-readable ("-23.4%", "$1.2M"); \`confidence\` is "low" | "medium" | "high" (use "high" only for direct aggregates from tool output). Magnitudes MUST come from observation numbers — never invent.
- "unexplained": one sentence (≤180 chars) on what the tools could NOT determine (e.g. "Composition shift between product sub-categories wasn't isolated because no sub-category column exists in this dataset."). Leave undefined when nothing material is missing.
When the user message says "questionShape: none" you may omit magnitudes and unexplained.`;

  const out = await completeJson(system, user, finalAnswerEnvelopeSchema, {
    turnId: `${turnId}_synth`,
    // W8 · 2600 → 4500. Synthesizer now produces implications, recommendations,
    // domainLens on top of the existing envelope and 600–1200-word body. The
    // previous 2600-token cap was hit on richer turns and silently truncated.
    maxTokens: 4500,
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

  const { body, keyInsight, ctas, magnitudes, unexplained, implications, recommendations, domainLens } = out.data;
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
  const cleanedDomainLens = domainLens?.trim()?.slice(0, 500) || undefined;
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
        ...(cleanedDomainLens ? { domainLens: cleanedDomainLens } : {}),
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
    ...(cleanedDomainLens ? { domainLens: cleanedDomainLens } : {}),
    source: "json_envelope",
  };
}

/**
 * W2 · "guaranteed narrative" retry — a stricter prompt than the legacy chat
 * retry. Designed to be structurally incapable of returning an empty answer
 * or echoing the deterministic-fallback prefix. Returns the trimmed prose
 * on success, or `null` if the model still produces nothing usable.
 */
async function runNarrativeRetry(
  user: string,
  onLlmCall: () => void
): Promise<string | null> {
  onLlmCall();
  const { MODEL } = await import("../../openai.js");
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
      max_tokens: 800,
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
async function runPlainTextRetry(
  user: string,
  onLlmCall: () => void
): Promise<string | null> {
  onLlmCall();
  const { MODEL } = await import("../../openai.js");
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
      max_tokens: 2000,
    },
    { purpose: LLM_PURPOSE.FINAL_ANSWER }
  );
  const text = res.choices[0]?.message?.content?.trim() ?? "";
  if (!text) return null;
  if (text.toLowerCase().startsWith("summary from")) return null;
  return text;
}

function buildPreSynthesisMidTurnSummary(
  ctx: AgentExecutionContext,
  trace: AgentTrace,
  observations: string[],
  mergedCharts: Array<{ title: string; x: string; y: string }>
): string {
  const tools = trace.toolCalls.map((t) => `${t.name}:${t.ok}`).join(", ");
  const obsTail = observations.join("\n\n---\n\n").slice(-5000);
  const charts = mergedCharts.map((c) => `${c.title}(${c.x}/${c.y})`).join("; ");
  return [
    `Question: ${ctx.question.slice(0, 500)}`,
    `planRationale: ${(trace.planRationale || "").slice(0, 1200)}`,
    `tools: ${tools || "(none)"}`,
    `chartsSoFar: ${charts || "(none)"}`,
    `recentObservations:\n${obsTail}`,
  ].join("\n\n");
}

export { appendEnvelopeInsight } from "./insightHelpers.js";

const PLANNER_RETRY_HINTS: Partial<Record<PlannerRejectReason, string>> = {
  llm_json_invalid:
    "IMPORTANT: Fix the previous attempt. Output ONLY valid JSON: an object with \"rationale\" (string) and \"steps\" (non-empty array of objects with id, tool, args, optional dependsOn). Use exact tool names from the Tools list.",
  empty_steps:
    "IMPORTANT: The steps array must not be empty. Include at least one step with a valid tool and args.",
  invalid_tool_args:
    "IMPORTANT: Tool arguments failed schema validation. For `execute_query_plan`, ensure `plan.dimensionFilters` items include required keys `column`, `op` ('in'|'not_in'), and `values` (string[]). If `plan.sort` is present, every item must include `column` and `direction` ('asc'|'desc') — otherwise omit invalid sort entries. For other tools, use only allowed keys and exact column names from the Dataset columns line.",
  unknown_tool:
    "IMPORTANT: Use only tool names exactly as listed in the Tools section (no invented names).",
  column_not_in_schema:
    "IMPORTANT: Every column in the plan must match a name from the Dataset columns line exactly (including parentheses and spacing).",
  invalid_aggregation_alias:
    "IMPORTANT: For execute_query_plan aggregations, alias must differ from source column. Keep schema column in aggregations[].column and use a distinct human-readable aggregations[].alias if needed.",
  ambiguous_column_resolution:
    "IMPORTANT: Use the AUTHORITATIVE columns for this question exactly. Do not invent near-miss names; use only exact schema/canonical names in groupBy/aggregations/filters/sort.",
  bad_depends_on:
    "IMPORTANT: Each dependsOn must reference another step id from the same plan.",
  dependency_cycle:
    "IMPORTANT: Remove circular dependsOn links; order steps as a DAG.",
};

/** One follow-up planner attempt with a corrective hint (reduces empty-plan user-facing failures). */
async function runPlannerWithOneRetry(
  ctx: AgentExecutionContext,
  registry: ToolRegistry,
  turnId: string,
  onLlmCall: () => void,
  priorObservationsText?: string,
  workingMemoryBlock?: string,
  handoffDigest?: string,
  ragHitsBlock?: string
) {
  const first = await runPlanner(
    ctx,
    registry,
    turnId,
    onLlmCall,
    priorObservationsText,
    workingMemoryBlock,
    handoffDigest,
    ragHitsBlock
  );
  if (first.ok) return first;
  const hint = first.reason ? PLANNER_RETRY_HINTS[first.reason] : undefined;
  if (!hint) return first;
  agentLog("planner.retry", { turnId, reason: first.reason });
  const ctxRetry: AgentExecutionContext = {
    ...ctx,
    question: `${ctx.question}\n\n${hint}`,
  };
  return runPlanner(
    ctxRetry,
    registry,
    turnId,
    onLlmCall,
    priorObservationsText,
    workingMemoryBlock,
    handoffDigest,
    ragHitsBlock
  );
}

export async function runAgentTurn(
  ctx: AgentExecutionContext,
  config: AgentConfig,
  emit?: AgentSseEmitter
): Promise<AgentLoopResult> {
  const registry = new ToolRegistry();
  registerDefaultTools(registry);
  const toolCtx = { exec: ctx, config };

  const turnId = randomUUID();
  const trace: AgentTrace = {
    turnId,
    startedAt: Date.now(),
    endedAt: Date.now(),
    steps: [],
    toolCalls: [],
    criticRounds: [],
    reflectorNotes: [],
    budgetHits: [],
    parseFailures: 0,
  };

  let llmCalls = 0;
  const onLlmCall = () => {
    llmCalls++;
    if (llmCalls > config.maxTotalLlmCallsPerTurn) {
      // W6.5 · Cap-hit telemetry. The throw is the existing brake; the log is
      // new so admin dashboards / Sentry sinks can flag turns that pin the
      // budget and need investigation (broken replan loop, runaway tool call).
      agentLog("agent.llm_budget_hit", {
        turnId,
        cap: config.maxTotalLlmCallsPerTurn,
        observed: llmCalls,
      });
      throw new Error("AGENT_LLM_BUDGET");
    }
  };

  const safeEmit = (event: string, data: unknown) => {
    try {
      emit?.(event, data);
    } catch {
      /* ignore client errors */
    }
  };

  let observations: string[] = [];
  let agentSuggestionHints: string[] = [];
  let followUpPrompts: string[] | undefined;
  // W8: accumulated sub-questions from reflector spawning decisions.
  const accumulatedSpawnedQuestions: import("./investigationTree.js").SpawnedQuestion[] = [];
  // PR 1.G — rich envelope surfaces populated only during Phase-1 shapes.
  let envelopeMagnitudes: z.infer<typeof magnitudeSchema>[] | undefined;
  let envelopeUnexplained: string | undefined;
  // W3 · structured AnswerEnvelope emitted by narrator (optional). Threaded
  // through the agent return → chatStream → assistantSave → Cosmos so the
  // client can render an AnswerCard.
  let envelopeAnswerEnvelope:
    | import("../../../shared/schema.js").Message["answerEnvelope"]
    | undefined;
  // PR 2.B — dashboard draft emitted when the brief flags requestsDashboard.
  let dashboardDraft:
    | import("../../../shared/schema.js").DashboardSpec
    | undefined;
  const workingMemory: WorkingMemoryEntry[] = [];
  const mergedCharts: ChartSpec[] = [];
  const mergedInsights: Insight[] = [];
  const deferredPlanCharts: DeferredBuildChartTemplate[] = [];
  let table: any;
  let operationResult: any;
  let lastNumeric = "";
  let delegateAnswer: string | undefined;
  let lastRagHitCount: number | undefined;
  let toolCallsDone = 0;
  let stepsWalked = 0;
  let lastMidTurnPersist = 0;
  const midTurnThrottleMs = Math.max(
    0,
    parseInt(process.env.AGENT_MID_TURN_CONTEXT_THROTTLE_MS || "8000", 10) || 8000
  );

  const deadline = Date.now() + config.maxWallTimeMs;

  if (ctx.mode === "analysis") {
    await maybeRunAnalysisBrief(ctx, turnId, onLlmCall);
    // Phase-1 PR 1.A: publish a compact intent digest so the thinking panel
    // can surface "what the model thinks the user asked for" before any tools
    // run. Purely observational — no branching, no behavior change.
    if (ctx.analysisBrief) {
      const brief = ctx.analysisBrief;
      safeEmit("intent_parsed", {
        questionShape: brief.questionShape,
        outcomeMetricColumn: brief.outcomeMetricColumn,
        segmentationDimensions: brief.segmentationDimensions,
        candidateDriverDimensions: brief.candidateDriverDimensions,
        timeWindow: brief.timeWindow,
        comparisonBaseline: brief.comparisonBaseline,
        filters: brief.filters,
        clarifyingQuestions: brief.clarifyingQuestions,
      });
    }
  }

  const briefOut = () =>
    ctx.analysisBrief ? { analysisBrief: ctx.analysisBrief } : {};

  const appliedFiltersOut = () =>
    ctx.inferredFilters?.length
      ? {
          appliedFilters: ctx.inferredFilters.map((f) => ({
            column: f.column,
            op: f.op,
            values: f.values,
            match: f.match,
          })),
        }
      : {};

  const mergeStepArtifacts = (
    tool: string,
    result: ToolResult,
    evidenceCallId?: string
  ) => {
    if (result.ragHitCount !== undefined) {
      lastRagHitCount = result.ragHitCount;
    }
    if (result.numericPayload) {
      lastNumeric = result.numericPayload;
    }
    if (result.charts?.length) {
      // W7.2 · Provenance: every chart records the tool call that produced it
      // plus row counts when the tool exposes them via `analyticalMeta`. Lets
      // the UI show a "where did this come from" popover for trust.
      const meta = (result as { analyticalMeta?: { inputRowCount?: number; outputRowCount?: number } }).analyticalMeta;
      const provenance = evidenceCallId
        ? {
            toolCalls: [
              {
                id: evidenceCallId,
                tool,
                ...(typeof meta?.inputRowCount === "number" ? { rowsIn: meta.inputRowCount } : {}),
                ...(typeof meta?.outputRowCount === "number" ? { rowsOut: meta.outputRowCount } : {}),
              },
            ],
          }
        : undefined;
      const tag = (c: ChartSpec): ChartSpec => ({
        ...c,
        ...(evidenceCallId ?
          { _agentEvidenceRef: evidenceCallId, _agentTurnId: turnId }
        : {}),
        ...(provenance ? { _agentProvenance: provenance } : {}),
      });
      if (tool === "build_chart") {
        for (const c of result.charts) {
          deferredPlanCharts.push(
            deferredTemplateFromBuiltChart(tag(c as ChartSpec))
          );
        }
      } else {
        mergedCharts.push(...result.charts.map((c) => tag(c as ChartSpec)));
      }
    }
    if (result.insights?.length) {
      mergedInsights.push(...result.insights);
    }
    if (result.table) {
      table = result.table;
    }
    if (result.operationResult) {
      operationResult = result.operationResult;
    }
    if (result.answerFragment) {
      delegateAnswer = result.answerFragment;
    }
  };

  const maybeMidTurn = async (payload: AgentMidTurnSessionPayload) => {
    if (process.env.AGENT_MID_TURN_CONTEXT === "false") return;
    const fn = ctx.onMidTurnSessionContext;
    if (!fn) return;
    const now = Date.now();
    if (!payload.bypassThrottle && now - lastMidTurnPersist < midTurnThrottleMs) return;
    lastMidTurnPersist = Date.now();
    await fn({
      summary: payload.summary,
      phase: payload.phase,
      tool: payload.tool,
      ok: payload.ok,
    }).catch(() => {});
  };

  /** Survives catch if a post-synthesis step throws (e.g. visual planner). */
  let preservedAnswer = "";

  // W3 · clean fallback render — never echoes raw observation prefixes
  // (`[execute_query_plan]`, `Sample: [...]`, etc.) to the user. Returns
  // empty string when there are no observations at all so callers can fall
  // through to whatever upstream emergency-message they prefer.
  function observationsFallbackAnswer(): string {
    if (observations.length === 0) return "";
    return renderFallbackAnswer(observations).content;
  }

  // W2/W3: initialise the shared analytical blackboard for this turn.
  const blackboard = ctx.blackboard ?? createBlackboard();
  ctx.blackboard = blackboard;

  // W3: generate investigation hypotheses before the first planner call.
  // Non-fatal — planner works without hypotheses if LLM call fails.
  if (ctx.mode === "analysis") {
    await generateHypotheses(ctx, blackboard, turnId, onLlmCall);
  }

  // P-A1: upfront RAG retrieval so the planner has semantic grounding on its
  // first call. Retrieval failures are non-fatal — planner still works on the
  // data summary alone; the block simply stays empty.
  let upfrontRagHitsBlock: string | undefined;
  try {
    const { isRagEnabled } = await import("../../rag/config.js");
    if (isRagEnabled()) {
      const { retrieveRagHits, formatHitsForPrompt } = await import(
        "../../rag/retrieve.js"
      );
      const { hits } = await retrieveRagHits({
        sessionId: ctx.sessionId,
        question: ctx.question,
        summary: ctx.summary,
        dataVersion: ctx.dataBlobVersion,
      });
      // Top few hits only; formatter already joins with separators.
      const topHits = hits.slice(0, 3);
      if (topHits.length > 0) {
        upfrontRagHitsBlock = formatHitsForPrompt(topHits);
        if (lastRagHitCount === undefined) {
          lastRagHitCount = topHits.length;
        }
      }
    }
  } catch (err) {
    agentLog("upfrontRag.failed", {
      turnId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Phase-1: when DEEP_ANALYSIS_SKILLS_ENABLED=true and a registered skill
  // matches the brief, the first iteration bypasses the planner and runs
  // the skill's pre-sequenced steps. Subsequent iterations (after reflector
  // replan) fall back to the normal planner so replans still work.
  let skillBypassUsed = false;
  const {
    isDeepAnalysisSkillsEnabled: skillsFlagOn,
    selectSkill,
    expandSkill,
  } = await import("./skills/index.js");
  const { diagnosticMaxParallelBranches } = await import(
    "../../diagnosticPipelineConfig.js"
  );
  const { preResolveParallelSteps } = await import(
    "./skills/parallelResolve.js"
  );
  /**
   * PR 1.E: cache of pre-resolved tool results. Populated when a
   * parallelizable skill dispatches; the step loop consumes from this
   * cache first and only falls back to registry.execute if the step has
   * no entry. Keyed by step.id.
   */
  const preResolvedToolResults = new Map<string, ToolResult>();

  try {
    let replans = 0;
    // P-020: promoted to AgentConfig so operators can tune via AGENT_MAX_REPLANS_PER_STEP.
    while (replans <= config.maxReplansPerStep) {
      if (Date.now() > deadline) {
        trace.budgetHits?.push("wall_time");
        break;
      }

      const priorForPlanner =
        observations.length > 0
          ? observations.join("\n\n---\n\n").slice(0, config.observationMaxChars)
          : undefined;
      const workingMemoryBlock = formatWorkingMemoryBlock(workingMemory);
      const handoffDigest =
        isInterAgentPromptFeedbackEnabled() && trace.interAgentMessages?.length
          ? formatInterAgentHandoffsForPrompt(trace.interAgentMessages, 4000)
          : undefined;

      // Skill dispatch (first iteration only, flag-gated). When the skill
      // expands into zero steps or throws, fall through to the planner.
      let planResult:
        | { ok: true; rationale: string; steps: PlanStep[] }
        | Awaited<ReturnType<typeof runPlannerWithOneRetry>>
        | null = null;
      if (
        !skillBypassUsed &&
        replans === 0 &&
        skillsFlagOn() &&
        ctx.analysisBrief
      ) {
        try {
          const skill = selectSkill(ctx.analysisBrief, ctx);
          if (skill) {
            const invocation = expandSkill(skill, ctx.analysisBrief, ctx);
            if (invocation && invocation.steps.length > 0) {
              skillBypassUsed = true;
              safeEmit("skill_execution", {
                skill: skill.name,
                invocationId: invocation.id,
                label: invocation.label,
                stepCount: invocation.steps.length,
                rationale: invocation.rationale,
              });
              appendInterAgentMessage(
                trace,
                {
                  from: "Coordinator",
                  to: "Planner",
                  intent: `skill_dispatch:${skill.name}`,
                  artifacts: invocation.steps.map((s) => s.id),
                  meta: {
                    skill: skill.name,
                    invocationId: invocation.id,
                  },
                },
                safeEmit
              );
              planResult = {
                ok: true,
                rationale:
                  invocation.rationale ||
                  `Skill ${skill.name} expanded into ${invocation.steps.length} step(s).`,
                steps: invocation.steps,
              } as unknown as Awaited<ReturnType<typeof runPlannerWithOneRetry>>;

              // PR 1.E: when the skill opts into parallelism, pre-run the
              // independent steps (no dependsOn) in parallel up to the
              // diagnostic branch budget. The step loop picks these results
              // out of preResolvedToolResults instead of re-executing; per
              // -step reflector / verifier / state updates still run serial
              // in plan order.
              if (invocation.parallelizable === true) {
                const maxParallel = diagnosticMaxParallelBranches();
                try {
                  const parallelOut = await preResolveParallelSteps(
                    invocation,
                    (step) => registry.execute(step.tool, step.args, toolCtx),
                    maxParallel
                  );
                  if (parallelOut.stepIds.length > 0) {
                    safeEmit("skill_parallel_batch", {
                      invocationId: invocation.id,
                      stepIds: parallelOut.stepIds,
                      budget: maxParallel,
                      elapsedMs: parallelOut.elapsedMs,
                    });
                    for (const [id, result] of parallelOut.resolved) {
                      preResolvedToolResults.set(id, result);
                    }
                    agentLog("skill.parallel.resolved", {
                      turnId,
                      invocationId: invocation.id,
                      count: parallelOut.stepIds.length,
                      elapsedMs: parallelOut.elapsedMs,
                    });
                  }
                } catch (parallelErr) {
                  // Non-fatal: clear the cache and let the step loop
                  // execute tools sequentially via registry.execute.
                  preResolvedToolResults.clear();
                  agentLog("skill.parallel.failed", {
                    turnId,
                    error:
                      parallelErr instanceof Error
                        ? parallelErr.message
                        : String(parallelErr),
                  });
                }
              }
            }
          }
        } catch (skillErr) {
          agentLog("skill.dispatch.failed", {
            turnId,
            error:
              skillErr instanceof Error
                ? skillErr.message
                : String(skillErr),
          });
        }
      }

      if (!planResult) {
        planResult = await runPlannerWithOneRetry(
          ctx,
          registry,
          turnId,
          onLlmCall,
          priorForPlanner,
          workingMemoryBlock || undefined,
          handoffDigest,
          upfrontRagHitsBlock
        );
      }
      if (!planResult.ok) {
        trace.parseFailures = (trace.parseFailures || 0) + 1;
        trace.plannerRejectReason = planResult.reason;
        trace.plannerRejectDetail = [
          planResult.tool,
          planResult.stepId,
          planResult.argKeys,
          planResult.zod_error,
        ]
          .filter(Boolean)
          .join("|")
          .slice(0, 300);
        appendInterAgentMessage(
          trace,
          {
            from: "Planner",
            to: "Coordinator",
            intent: "plan_rejected",
            evidenceRefs: planResult.stepId ? [String(planResult.stepId)] : undefined,
            meta: {
              reason: String(planResult.reason ?? "unknown").slice(0, 80),
            },
          },
          safeEmit
        );
        trace.endedAt = Date.now();
        agentLog("turn.abort", {
          phase: "planner",
          turnId,
          reason: planResult.reason,
          parseFailures: trace.parseFailures ?? 0,
          questionLength: ctx.question.length,
          sessionIdLen: ctx.sessionId.length,
        });
        return {
          answer: "",
          charts: mergedCharts.length ? mergedCharts : undefined,
          insights: mergedInsights.length ? mergedInsights : undefined,
          table,
          operationResult,
          agentTrace: capAgentTrace(trace),
          agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
          lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
          ...briefOut(),
      ...appliedFiltersOut(),
        };
      }

      const plan = planResult;

      trace.planRationale = plan.rationale;
      trace.steps = plan.steps;
      appendInterAgentMessage(
        trace,
        {
          from: "Planner",
          to: "Coordinator",
          intent: "plan_accepted",
          artifacts: plan.steps.map((s) => s.id),
          evidenceRefs: plan.steps.map((s) => s.id).slice(0, 12),
          meta: { stepCount: String(plan.steps.length) },
        },
        safeEmit
      );
      safeEmit("plan", {
        rationale: plan.rationale,
        steps: plan.steps.map((s) => ({
          id: s.id,
          tool: s.tool,
          args_summary: JSON.stringify(s.args).slice(0, 400),
        })),
      });

      if (ctx.mode === "analysis") {
        void maybeMidTurn({
          phase: "plan",
          summary: `Plan rationale:\n${(plan.rationale || "").slice(0, 2000)}\nSteps: ${plan.steps.map((s) => `${s.id}:${s.tool}`).join(" | ")}`,
          ok: true,
        });
      }

      let stopEarly = false;

      // W1: Track which steps should skip their individual reflector call because they
      // are non-terminal members of a parallel group. The last step in the group still
      // runs the reflector with all accumulated observations from the whole group.
      const skipReflectorStepIds = new Set<string>();

      // W1: Clear stale pre-resolved results from a prior replan iteration, then
      // pre-resolve independent steps that share a parallelGroup concurrently.
      // Results land in preResolvedToolResults; the step loop consumes them normally.
      if (replans > 0) preResolvedToolResults.clear();
      {
        const MAX_PARALLEL_TOOLS = 3;
        const groups = groupSortedStepsForExecution(plan.steps);
        for (const group of groups) {
          if (group.length < 2) continue;
          const parallelSteps = group.slice(0, MAX_PARALLEL_TOOLS);
          const t0 = Date.now();
          const settled = await Promise.all(
            parallelSteps.map(async (step) => {
              if (preResolvedToolResults.has(step.id)) return null; // already resolved by skill dispatch
              try {
                const r = await registry.execute(step.tool, step.args, toolCtx);
                return { id: step.id, result: r };
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                  id: step.id,
                  result: { ok: false, summary: `Parallel pre-resolve error: ${msg}` } as ToolResult,
                };
              }
            })
          );
          let addedCount = 0;
          for (const s of settled) {
            if (s) {
              preResolvedToolResults.set(s.id, s.result);
              addedCount++;
            }
          }
          if (addedCount >= 2) {
            for (const step of parallelSteps.slice(0, -1)) {
              skipReflectorStepIds.add(step.id);
            }
            agentLog("parallel.group.resolved", {
              turnId,
              parallelGroup: group[0].parallelGroup,
              count: addedCount,
              elapsedMs: Date.now() - t0,
            });
            safeEmit("parallel_group_resolved", {
              parallelGroup: group[0].parallelGroup,
              stepIds: parallelSteps.map((s) => s.id),
              count: addedCount,
            });
          }
        }
      }

      stepLoop: for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];
        if (Date.now() > deadline) {
          trace.budgetHits?.push("wall_time");
          stopEarly = true;
          break;
        }
        if (stepsWalked >= config.maxSteps) {
          trace.budgetHits?.push("max_steps");
          stopEarly = true;
          break;
        }
        if (toolCallsDone >= config.maxToolCalls) {
          trace.budgetHits?.push("max_tool_calls");
          stopEarly = true;
          break;
        }

        stepsWalked++;

        let stepResult: ToolResult | undefined;
        let finalCallId = "";
        let finalCandidate = "";

        attemptLoop: for (let attempt = 0; attempt < 2; attempt++) {
          const callId = `${step.id}-${toolCallsDone}`;
          const argsSummary = JSON.stringify(step.args).slice(0, 400);
          safeEmit("tool_call", { id: callId, name: step.tool, args_summary: argsSummary });

          const t0 = Date.now();
          // PR 1.E: consume the pre-resolved parallel-batch result if one
          // was computed during skill dispatch. Only first-attempt steps
          // use the cache — retries always hit registry.execute so a
          // transient failure isn't replayed from the cached failure.
          const cachedResult =
            attempt === 0 ? preResolvedToolResults.get(step.id) : undefined;
          if (cachedResult) {
            preResolvedToolResults.delete(step.id);
          }
          const result =
            cachedResult ?? (await registry.execute(step.tool, step.args, toolCtx));
          const t1 = Date.now();
          toolCallsDone++;

          const record: ToolCallRecord = {
            id: callId,
            name: step.tool,
            argsSummary,
            ok: result.ok,
            startedAt: t0,
            endedAt: t1,
            resultSummary: result.summary.slice(0, 2_500),
          };
          trace.toolCalls.push(record);

          safeEmit("tool_result", {
            id: callId,
            ok: result.ok,
            summary: result.summary.slice(0, 2000),
          });

          if (result.workbenchArtifact) {
            safeEmit("workbench", { entry: result.workbenchArtifact });
          }

          void maybeMidTurn({
            phase: "tool",
            tool: step.tool,
            summary: result.summary,
            ok: result.ok,
          });

          stepResult = result;
          finalCallId = callId;

          const invalidArgs =
            !result.ok && result.summary.startsWith("Invalid args for");
          if (invalidArgs) {
            trace.parseFailures = (trace.parseFailures || 0) + 1;
            const help = registry.getArgsHelpForTool(step.tool) ?? "{}";
            observations.push(
              `[SYSTEM_REPAIR] Tool "${step.tool}" args must match the schema. Allowed: ${help}. Error: ${result.summary.slice(0, 400)}`
            );
            workingMemory.push({
              callId,
              tool: step.tool,
              ok: false,
              summaryPreview: result.summary,
              suggestedColumns: undefined,
              slots: undefined,
            });
            replans++;
            break stepLoop;
          }

          if (result.clarify) {
            appendInterAgentMessage(
              trace,
              {
                from: "Executor",
                to: "Coordinator",
                intent: "tool_requests_clarify",
                evidenceRefs: [callId, step.id],
                meta: { tool: step.tool, stepId: step.id },
              },
              safeEmit
            );
            mergeStepArtifacts(step.tool, result, callId);
            materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
            trace.endedAt = Date.now();
            return {
              answer: result.clarify,
              charts: mergedCharts.length ? mergedCharts : undefined,
              insights: mergedInsights.length ? mergedInsights : undefined,
              table,
              operationResult,
              agentTrace: capAgentTrace(trace),
              lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
              ...briefOut(),
      ...appliedFiltersOut(),
            };
          }

          // W1 · The step-level verifier critiques narrative quality. Tool
          // summaries from analytical tools (execute_query_plan,
          // run_analytical_query, etc.) are evidence digests, not narrative
          // drafts — running the verifier on them produced false-positive
          // MISSING_NARRATIVE / MISSING_MAGNITUDES verdicts and noisy
          // verifier-rewrite-step flow_decisions. Gate on whether the tool
          // actually emitted a prose answerFragment.
          const hasNarrativeCandidate = Boolean(result.answerFragment?.trim());

          let candidate =
            result.answerFragment ||
            result.summary ||
            (result.ok ? "(no summary)" : "Tool failed.");
          if (result.suggestedColumns?.length) {
            candidate += `\nSuggested columns: ${result.suggestedColumns.join(", ")}`;
          }

          const evidence = `${result.summary}\n${lastNumeric || ""}`.slice(0, 8000);

          if (hasNarrativeCandidate) {
            let vRound = 0;
            while (vRound < config.maxVerifierRoundsPerStep) {
              const verdict = await runVerifier(
                ctx,
                {
                  candidate,
                  evidenceSummary: evidence,
                  stepId: step.id,
                  turnId,
                  blackboard: ctx.blackboard,
                  planSteps: plan.steps,
                  charts: mergedCharts,
                },
                onLlmCall
              );

              trace.criticRounds.push({
                stepId: step.id,
                verdict: verdict.verdict,
                issueCodes: verdict.issues.map((i) => i.code),
                courseCorrection: verdict.course_correction,
              });

              safeEmit("critic_verdict", {
                stepId: step.id,
                verdict: verdict.verdict,
                issue_codes: verdict.issues.map((i) => i.code),
                course_correction: verdict.course_correction,
              });

              if (verdict.verdict === VERIFIER_VERDICT.pass) {
                break;
              }
              if (
                verdict.verdict === VERIFIER_VERDICT.reviseNarrative ||
                verdict.course_correction === VERIFIER_VERDICT.reviseNarrative
              ) {
                // Single-flow policy: rewriteNarrative is suppressed. Verifier's
                // verdict is still emitted as a critic_verdict SSE event (visible
                // in the workbench) so the user can see what the verifier flagged
                // without having the synthesized narrative silently swapped out.
                const issuesText = verdict.issues.map((i) => i.description).join("; ");
                safeEmit("flow_decision", {
                  layer: "verifier-rewrite-step",
                  chosen: "kept-original",
                  reason: `Rewrite suppressed (single-flow policy); ${issuesText.slice(0, 400)}`.slice(0, 500),
                  candidates: verdict.issues.map((i) => i.code).slice(0, 8),
                });
              }
              break;
            }
          }

          finalCandidate = candidate;

          const lastV = lastVerdictForStep(trace, step.id);
          if (lastV === VERIFIER_VERDICT.retryTool && attempt < 1) {
            trace.reflectorNotes.push(`retry_tool: re-exec ${step.tool}`);
            continue attemptLoop;
          }
          break attemptLoop;
        }

        if (!stepResult) {
          break;
        }

        {
          // W1 · skip the Verifier→Coordinator handoff message when the
          // step-level verifier did not actually run (analytical tools with
          // no narrative candidate). Without this gate the trace shows a
          // fake "step_verdict" inter-agent message with an empty verdict.
          const lv = lastVerdictForStep(trace, step.id);
          if (lv) {
            appendInterAgentMessage(
              trace,
              {
                from: "Verifier",
                to: "Coordinator",
                intent: "step_verdict",
                artifacts: [step.id],
                evidenceRefs: [finalCallId, step.id],
                meta: {
                  tool: step.tool,
                  verdict: lv,
                },
              },
              safeEmit
            );
          }
        }

        mergeStepArtifacts(step.tool, stepResult, finalCallId);

        if (
          stepResult.ok &&
          ctx.onIntermediateArtifact &&
          INTERMEDIATE_TABLE_TOOLS.has(step.tool)
        ) {
          const intermediateRows = sanitizeIntermediatePreviewRows(
            toolTableRowsForIntermediate(stepResult)
          );
          if (intermediateRows.length > 0) {
            const insight = buildIntermediateInsight(step.tool, stepResult);
            const pivotDefaults = derivePivotDefaultsFromPreviewRows(
              intermediateRows,
              ctx.summary,
              toolTableColumnOrderForIntermediate(stepResult)
            );
            const hasPivotHint =
              Boolean(pivotDefaults?.rows?.length) && Boolean(pivotDefaults?.values?.length);
            ctx.onIntermediateArtifact({
              preview: intermediateRows.slice(0, 50),
              insight,
              ...(hasPivotHint
                ? {
                    pivotDefaults: {
                      rows: pivotDefaults!.rows,
                      values: pivotDefaults!.values,
                      ...(pivotDefaults!.columns?.length
                        ? { columns: pivotDefaults!.columns }
                        : {}),
                    },
                  }
                : {}),
            });
          }
        }

        if (
          stepResult.ok &&
          stepResult.table &&
          Array.isArray(stepResult.table.rows) &&
          stepResult.table.rows.length > 0 &&
          (step.tool === "run_analytical_query" ||
            step.tool === "execute_query_plan" ||
            step.tool === "derive_dimension_bucket" ||
            step.tool === "add_computed_columns" ||
            step.tool === "run_readonly_sql")
        ) {
          const analyticalRows = stepResult.table.rows as Record<string, unknown>[];
          ctx.data = analyticalRows;
          ctx.lastAnalyticalTable = {
            rows: analyticalRows,
            columns: rowKeysFromFirstRow(analyticalRows),
            sourceTool: step.tool,
          };
        }

        if (stepResult.ok && step.tool === "derive_dimension_bucket") {
          const neu = step.args.newColumnName;
          if (typeof neu === "string" && neu.trim()) {
            registerDerivedColumnOnSummary(ctx.summary, neu, ctx.data);
          }
        }

        if (stepResult.ok && step.tool === "add_computed_columns") {
          const parsedArgs = addComputedColumnsArgsSchema.safeParse(step.args);
          if (parsedArgs.success) {
            registerComputedColumnsOnSummary(ctx.summary, parsedArgs.data, ctx.data);
          }
        }

        for (const line of lintAfterAnalyticalTool({
          tool: step.tool,
          ok: stepResult.ok,
          question: ctx.question,
          parsed: stepResult.queryPlanParsed,
          outputRowCount:
            stepResult.table?.rowCount ?? stepResult.analyticalMeta?.outputRowCount,
          outputColumns: Array.isArray(stepResult.table?.columns)
            ? (stepResult.table.columns as string[])
            : undefined,
          appliedAggregation: stepResult.analyticalMeta?.appliedAggregation,
        })) {
          observations.push(line);
        }

        const finalTrimmed = finalCandidate.trimStart();
        // If the tool already produced a structured SYSTEM_VALIDATION line, keep it
        // intact so the reflector can reliably detect it.
        if (finalTrimmed.startsWith("[SYSTEM_VALIDATION]")) {
          observations.push(finalTrimmed);
        } else {
          observations.push(`[${step.tool}] ${finalCandidate}`);
        }
        // O5: prevent unbounded growth across replan loops.
        if (observations.length > 80) observations.splice(0, observations.length - 80);

        // O1: wire successful tool results into the shared blackboard so narrator,
        // convergence check, and context-agent Round 2 all have structured evidence.
        if (stepResult.ok && ctx.blackboard) {
          const finding = addFinding(ctx.blackboard, {
            sourceRef: finalCallId,
            label: `${step.tool}: ${String(step.args?.metrics ?? step.args?.groupBy ?? step.args?.columns ?? "").slice(0, 80)}`.trim(),
            detail: (stepResult.summary ?? "").slice(0, 800),
            significance: detectSignificance(stepResult.summary ?? ""),
            relatedColumns: stepResult.suggestedColumns ?? [],
          });
          // O2: if the planner bound this step to a hypothesis, resolve it now.
          if (step.hypothesisId) {
            const sig = finding.significance;
            resolveHypothesis(
              ctx.blackboard,
              step.hypothesisId,
              sig === "anomalous" ? "confirmed" : "partial",
              finding.id
            );
          }
        }

        workingMemory.push({
          callId: finalCallId,
          tool: step.tool,
          ok: stepResult.ok,
          summaryPreview: stepResult.summary,
          suggestedColumns: stepResult.suggestedColumns,
          slots: stepResult.memorySlots,
        });

        // W1: Skip the per-step reflector for non-terminal parallel group members.
        // The last step in the group runs the reflector with all accumulated observations.
        if (!skipReflectorStepIds.has(step.id)) {
          const refDigest =
            isInterAgentPromptFeedbackEnabled() && trace.interAgentMessages?.length
              ? formatInterAgentHandoffsForPrompt(trace.interAgentMessages, 3500)
              : undefined;
          // P-A3: aggregate distinct suggested columns from prior successful
          // tool calls so the reflector can see what's already been explored.
          const workingMemorySuggestedColumns = Array.from(
            new Set(
              workingMemory
                .filter((e) => e.ok && Array.isArray(e.suggestedColumns))
                .flatMap((e) => e.suggestedColumns ?? [])
            )
          );
          const ref = await runReflector(
            ctx,
            {
              observations,
              lastTool: step.tool,
              lastOk: stepResult.ok,
              lastAnalyticalMeta:
                step.tool === "run_analytical_query" ||
                step.tool === "execute_query_plan"
                  ? stepResult.analyticalMeta
                  : undefined,
              workingMemorySuggestedColumns,
            },
            turnId,
            onLlmCall,
            refDigest
          );
          trace.reflectorNotes.push(ref.action + (ref.note ? `: ${ref.note}` : ""));
          // W8: collect sub-questions emitted by the reflector.
          if (ref.spawnedQuestions?.length) {
            for (const sq of ref.spawnedQuestions) {
              accumulatedSpawnedQuestions.push({ ...sq, suggestedColumns: sq.suggestedColumns ?? [] });
              // O1: persist spawned questions to the blackboard so convergence
              // and context-agent Round 2 can see open investigative threads.
              if (ctx.blackboard) {
                addOpenQuestion(ctx.blackboard, sq.question, sq.spawnReason ?? "", { priority: sq.priority ?? "medium" });
              }
            }
            safeEmit("sub_question_spawned", { questions: ref.spawnedQuestions.map((q) => q.question) });
          }
          appendInterAgentMessage(
            trace,
            {
              from: "Reflector",
              to: "Coordinator",
              intent: `reflector_${ref.action}`,
              evidenceRefs: [step.id, finalCallId],
              meta: {
                stepId: step.id,
                tool: step.tool,
                note: (ref.note ?? "").slice(0, 200),
              },
            },
            safeEmit
          );

          if (ref.action === "finish") {
            const remaining = plan.steps.length - si - 1;
            if (remaining > 0) {
              trace.reflectorNotes.push(`finish_overridden: ${remaining} step(s) remain`);
            } else {
              stopEarly = true;
              break;
            }
          } else if (ref.action === "clarify" && ref.clarify_message) {
            appendInterAgentMessage(
              trace,
              {
                from: "Reflector",
                to: "Coordinator",
                intent: "clarify_user",
                evidenceRefs: [step.id, finalCallId],
                blockingQuestions: [ref.clarify_message.slice(0, 320)],
                meta: { stepId: step.id },
              },
              safeEmit
            );
            trace.endedAt = Date.now();
            materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
            return {
              answer: ref.clarify_message,
              charts: mergedCharts.length ? mergedCharts : undefined,
              insights: mergedInsights.length ? mergedInsights : undefined,
              agentTrace: capAgentTrace(trace),
              lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
              ...briefOut(),
      ...appliedFiltersOut(),
            };
          } else if (ref.action === "replan") {
            // Single-flow policy: replan is suppressed; continue with the
            // original plan. Reflector's note is preserved in the trace and
            // emitted as a flow_decision so the suggestion is still visible.
            appendInterAgentMessage(
              trace,
              {
                from: "Reflector",
                to: "Planner",
                intent: "replan_suggested_suppressed",
                evidenceRefs: [step.id, finalCallId],
                meta: { afterStep: step.id, tool: step.tool, policy: "single-flow" },
              },
              safeEmit
            );
            safeEmit("flow_decision", {
              layer: "reflector-replan",
              chosen: "continue-as-planned",
              reason: `Replan suggested but suppressed (single-flow policy). Reflector note: ${(
                ref.note ?? "(none)"
              ).slice(0, 350)}`.slice(0, 500),
              candidates: plan.steps.slice(0, 8).map((s) => `${s.id}:${s.tool}`),
            });
            trace.reflectorNotes.push(`replan_suppressed: ${ref.note ?? "(none)"}`);
          } else if (ref.action === "investigate_gap" && ref.gapFill) {
            // W11: inject a targeted tool step to fill an uncovered hypothesis.
            const gf = ref.gapFill;
            const gapStepId = `gap_${gf.hypothesisId}_${Date.now()}`;
            // W12a: use explicit args when provided; otherwise derive
            // question_override from hypothesis text so the tool targets the
            // specific gap rather than repeating the original question.
            const gapHypothesis = ctx.blackboard?.hypotheses.find(
              (h) => h.id === gf.hypothesisId
            );
            const fallbackGapArgs: Record<string, unknown> =
              gf.tool === "execute_query_plan"
                ? {}
                : { question_override: gapHypothesis?.text ?? gf.rationale };
            const gapStep: PlanStep = {
              id: gapStepId,
              tool: gf.tool,
              args: gf.args ?? fallbackGapArgs,
              hypothesisId: gf.hypothesisId,
            };
            plan.steps.splice(si + 1, 0, gapStep);
            appendInterAgentMessage(
              trace,
              {
                from: "Reflector",
                to: "Coordinator",
                intent: "investigate_gap",
                evidenceRefs: [step.id],
                meta: { hypothesisId: gf.hypothesisId, tool: gf.tool, gapStepId },
              },
              safeEmit
            );
            trace.reflectorNotes.push(`investigate_gap: hypothesis=${gf.hypothesisId} via ${gf.tool}`);
          }
        }
      }

      if (stopEarly) {
        break;
      }
      if (replans > 0 && observations.length > 0) {
        /* replan loop continues */
        continue;
      }
      break;
    }

    // W4: RAG Round 2 — derive queries from blackboard findings and retrieve
    // additional domain context before synthesis. Non-fatal; runs once per turn.
    if (ctx.blackboard && ctx.mode === "analysis") {
      await runContextAgentRound2(ctx, ctx.blackboard, turnId);
    }

    await maybeMidTurn({
      phase: "pre_synthesis",
      bypassThrottle: true,
      ok: true,
      summary: buildPreSynthesisMidTurnSummary(ctx, trace, observations, mergedCharts),
    });

    // W3 · `answerSource` flags whether `answer` is a real LLM-authored
    // narrative (`narrator` / `synthesizer`) or a deterministic placeholder
    // (`fallback`). W4 uses this to skip the final verifier on placeholders;
    // W5 logs it as telemetry. Default to `delegate` because that's the
    // tool-handed-off case (delegateAnswer non-empty above this block).
    let answerSource: "delegate" | "narrator" | "synthesizer" | "fallback" =
      "delegate";

    let answer = delegateAnswer || "";
    if (!answer && observations.length > 0) {
      try {
        // W5: narrator-first path when the blackboard has structured findings;
        // falls back to the existing synthesizer when blackboard is empty.
        const useNarrator =
          ctx.blackboard && shouldUseNarrator(ctx.blackboard) && ctx.mode === "analysis";

        let envKeyInsight: string | null | undefined;
        let envCtas: string[] = [];
        let envMagnitudes: typeof envelopeMagnitudes;
        let envUnexplained: string | undefined;

        if (useNarrator) {
          const narResult = await runNarrator(ctx, ctx.blackboard!, turnId, onLlmCall);
          if (narResult) {
            // formatAnswerFromEnvelope signature is already in scope
            answer = formatAnswerFromEnvelope(narResult.body ?? "", narResult.keyInsight ?? null);
            envKeyInsight = narResult.keyInsight ?? undefined;
            envCtas = (narResult.ctas ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
            envMagnitudes = narResult.magnitudes;
            envUnexplained = narResult.unexplained;
            if (answer.trim()) answerSource = "narrator";
            // W5 + W8 · synthesis telemetry — narrator branch. W8 adds
            // bodyWordCount / implicationsCount / recommendationsCount /
            // domainLensLen so we can confirm the new envelope sections are
            // actually being produced post-rollout.
            agentLog("synthesis_result", {
              turnId,
              source: "narrator",
              answerLen: answer.length,
              bodyWordCount: countWords(narResult.body ?? ""),
              keyInsightLen: narResult.keyInsight?.length ?? 0,
              ctaCount: narResult.ctas?.length ?? 0,
              magnitudesCount: narResult.magnitudes?.length ?? 0,
              implicationsCount: narResult.implications?.length ?? 0,
              recommendationsCount: narResult.recommendations?.length ?? 0,
              domainLensLen: narResult.domainLens?.length ?? 0,
              questionShape: ctx.analysisBrief?.questionShape ?? "none",
              observationsCount: observations.length,
              observationsTotalLen: observations.reduce(
                (n, o) => n + (o?.length ?? 0),
                0
              ),
            });
            // W3 + W8 · capture the structured AnswerEnvelope. W8 adds
            // implications, recommendations, and domainLens so the AnswerCard
            // can render decision-grade sections.
            const env: NonNullable<import("../../../shared/schema.js").Message["answerEnvelope"]> = {};
            if (narResult.tldr) env.tldr = narResult.tldr;
            if (narResult.findings?.length) env.findings = narResult.findings;
            if (narResult.methodology) env.methodology = narResult.methodology;
            if (narResult.caveats?.length) env.caveats = narResult.caveats;
            if (envCtas.length) env.nextSteps = envCtas;
            if (narResult.implications?.length) env.implications = narResult.implications;
            if (narResult.recommendations?.length) env.recommendations = narResult.recommendations;
            if (narResult.domainLens) env.domainLens = narResult.domainLens;
            if (Object.keys(env).length) envelopeAnswerEnvelope = env;
          }
        }

        // Fallback: use existing synthesizer when narrator was skipped or returned null.
        // O4: prepend blackboard narrative block so synthesizer sees structured findings.
        if (!answer) {
          const synthObservations =
            ctx.blackboard && ctx.blackboard.findings.length > 0
              ? [`[BLACKBOARD]\n${formatForNarrator(ctx.blackboard).slice(0, 3000)}`, ...observations]
              : observations;
          const env = await synthesizeFinalAnswerEnvelope(
            ctx,
            synthObservations,
            turnId,
            onLlmCall,
            upfrontRagHitsBlock
          );
          answer = env.answer;
          agentSuggestionHints = env.suggestionHints;
          envKeyInsight = env.keyInsight;
          envCtas = (env.ctas ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
          envMagnitudes = env.magnitudes;
          envUnexplained = env.unexplained;
          // W3 · `fallback_dump` means the LLM paths all failed and the
          // clean renderer produced a markdown table. Anything else
          // (json_envelope, narrative_retry, plain_text_retry) is a real
          // synthesized narrative.
          answerSource = env.source === "fallback_dump" ? "fallback" : "synthesizer";
          // W8 · synthesizer also produces decision-grade envelope sections —
          // capture them so the AnswerCard renders the same shape regardless
          // of which writer ran. Skipped on `fallback_dump` (deterministic
          // markdown table; no envelope to surface).
          if (env.source !== "fallback_dump") {
            const synthEnv: NonNullable<
              import("../../../shared/schema.js").Message["answerEnvelope"]
            > = {};
            if (envCtas.length) synthEnv.nextSteps = envCtas;
            if (env.implications?.length) synthEnv.implications = env.implications;
            if (env.recommendations?.length) synthEnv.recommendations = env.recommendations;
            if (env.domainLens) synthEnv.domainLens = env.domainLens;
            if (Object.keys(synthEnv).length) envelopeAnswerEnvelope = synthEnv;
          }
          // W5 + W8 · synthesis telemetry. When a fallback fires in production we
          // need to know which retry path failed and what the LLM produced
          // (or didn't) to fix the prompt at its source. W8 adds the same
          // depth-of-answer counters as the narrator branch.
          agentLog("synthesis_result", {
            turnId,
            source: env.source,
            answerLen: env.answer.length,
            bodyWordCount: countWords(env.answer),
            keyInsightLen: env.keyInsight?.length ?? 0,
            ctaCount: env.ctas?.length ?? 0,
            magnitudesCount: env.magnitudes?.length ?? 0,
            implicationsCount: env.implications?.length ?? 0,
            recommendationsCount: env.recommendations?.length ?? 0,
            domainLensLen: env.domainLens?.length ?? 0,
            questionShape: ctx.analysisBrief?.questionShape ?? "none",
            observationsCount: synthObservations.length,
            observationsTotalLen: synthObservations.reduce(
              (n, o) => n + (o?.length ?? 0),
              0
            ),
          });
        }

        if (envCtas.length) followUpPrompts = envCtas;
        if (!agentSuggestionHints.length) {
          agentSuggestionHints = [...envCtas, ...(envKeyInsight ? [envKeyInsight] : [])];
        }

        // PR 1.G — capture Phase-1 rich fields.
        if (envMagnitudes && envMagnitudes.length > 0) {
          envelopeMagnitudes = envMagnitudes;
          safeEmit("magnitudes", { items: envMagnitudes });
        }
        if (envUnexplained) {
          envelopeUnexplained = envUnexplained;
          safeEmit("unexplained", { note: envUnexplained });
        }
        appendEnvelopeInsight(mergedInsights, envKeyInsight ?? undefined);
        appendInterAgentMessage(
          trace,
          {
            from: "Synthesizer",
            to: "Coordinator",
            intent: "answer_drafted",
            evidenceRefs: [useNarrator ? "narrator" : "synthesis"],
            meta: {
              ctas: String(envCtas.length),
              approxLen: String(answer.length),
            },
          },
          safeEmit
        );
      } catch (synErr) {
        const msg = synErr instanceof Error ? synErr.message : String(synErr);
        agentLog("synthesis_error", { turnId, err: msg.slice(0, 300) });
        answer = observationsFallbackAnswer();
        answerSource = "fallback";
      }
    }
    preservedAnswer = answer;

    materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);

    let visualExtra: Awaited<ReturnType<typeof proposeAndBuildExtraCharts>> = {
      charts: [],
    };
    try {
      visualExtra = await proposeAndBuildExtraCharts(
        ctx,
        observations.join("\n\n---\n\n"),
        turnId,
        onLlmCall,
        mergedCharts,
        answer.trim().slice(0, 6000)
      );
    } catch (visErr) {
      const msg = visErr instanceof Error ? visErr.message : String(visErr);
      agentLog("visual_planner_failed", { turnId, err: msg.slice(0, 300) });
    }
    if (visualExtra.charts.length) {
      mergedCharts.push(...visualExtra.charts);
      appendInterAgentMessage(
        trace,
        {
          from: "VisualPlanner",
          to: "Coordinator",
          intent: "extra_charts_added",
          evidenceRefs: visualExtra.charts.map((_, i) => `chart_${i}`).slice(0, 8),
          meta: { count: String(visualExtra.charts.length) },
        },
        safeEmit
      );
      if (ctx.mode === "analysis") {
        void maybeMidTurn({
          phase: "post_visual",
          summary: `Visual planner added: ${visualExtra.charts.map((c) => `${c.title}:${c.x}/${c.y}`).join("; ")}`,
          ok: true,
        });
      }
    }

    if (!answer?.trim()) {
      const fb = observationsFallbackAnswer();
      if (fb) {
        answer = fb;
        preservedAnswer = fb;
        answerSource = "fallback";
        agentLog("synthesis_empty_fallback", {
          turnId,
          observationsCount: observations.length,
          toolCallsDone,
        });
      }
    }

    // PR 2.B — emit a DashboardSpec draft when the user asked for a dashboard
    // and at least one chart exists. Non-fatal: failures leave dashboardDraft
    // unset and the normal answer still streams to the client.
    try {
      const { shouldBuildDashboard, buildDashboardFromTurn } = await import(
        "./buildDashboard.js"
      );
      if (
        answer?.trim() &&
        shouldBuildDashboard({
          brief: ctx.analysisBrief,
          charts: mergedCharts,
          userKey: ctx.username,
        })
      ) {
        const intermediateSummaries = trace.toolCalls
          .filter((t) => t.ok && t.resultSummary)
          .map((t) => `${t.name}: ${t.resultSummary}`);
        const spec = await buildDashboardFromTurn({
          question: ctx.question,
          answerBody: answer,
          keyInsight: mergedInsights[0]?.text,
          charts: mergedCharts,
          magnitudes: envelopeMagnitudes,
          brief: ctx.analysisBrief,
          turnId,
          onLlmCall,
          intermediateSummaries,
        });
        if (spec) {
          dashboardDraft = spec;
          safeEmit("dashboard_draft", {
            name: spec.name,
            template: spec.template,
            sheetCount: spec.sheets.length,
            chartCount: mergedCharts.length,
          });
          appendInterAgentMessage(
            trace,
            {
              from: "Synthesizer",
              to: "Coordinator",
              intent: "dashboard_drafted",
              meta: {
                template: spec.template,
                sheetCount: String(spec.sheets.length),
              },
            },
            safeEmit
          );
        }
      }
    } catch (dashErr) {
      agentLog("buildDashboard.dispatch_failed", {
        turnId,
        error: dashErr instanceof Error ? dashErr.message : String(dashErr),
      });
    }

    if (!answer?.trim()) {
      trace.endedAt = Date.now();
      agentLog("turn.abort", {
        phase: "synthesis",
        turnId,
        observationsCount: observations.length,
        hadDelegateAnswer: Boolean(delegateAnswer?.trim()),
        toolCallsDone,
        chartsCount: mergedCharts.length,
        sessionIdLen: ctx.sessionId.length,
      });
      return {
        answer: "",
        charts: mergedCharts.length ? mergedCharts : undefined,
        insights: mergedInsights.length ? mergedInsights : undefined,
        table,
        operationResult,
        agentTrace: capAgentTrace(trace),
        agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
        lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
        ...briefOut(),
      ...appliedFiltersOut(),
      };
    }

    let finalRound = 0;
    const chartTitles = mergedCharts.map((c) => `${c.title}:${c.x}/${c.y}`).join("; ");
    const finalEvidence = buildFinalEvidence(
      observations,
      chartTitles,
      ctx.blackboard,
      envelopeMagnitudes
    );

    // W4 · The final verifier critiques narrative quality. When the answer
    // came from the deterministic fallback renderer (renderFallbackAnswer),
    // there is no narrative — only a markdown render of tool data — so the
    // verifier would always flag MISSING_MAGNITUDES / MISSING_NARRATIVE and
    // single-flow would lock the placeholder in place. Skip it instead and
    // emit a flow_decision so the trace remains transparent.
    if (answerSource === "fallback") {
      safeEmit("flow_decision", {
        layer: "verifier-rewrite-final",
        chosen: "fallback-skipped",
        reason:
          "Synthesis fallback used; verifier skipped because there is no narrative to critique.",
        candidates: [],
      });
    }

    while (answerSource !== "fallback" && finalRound < config.maxVerifierRoundsFinal) {
      const fv = await runVerifier(
        ctx,
        {
          candidate: answer,
          evidenceSummary: finalEvidence,
          stepId: "final",
          turnId,
          blackboard: ctx.blackboard,
          planSteps: trace.steps,
          charts: mergedCharts,
        },
        onLlmCall
      );
      trace.criticRounds.push({
        stepId: "final",
        verdict: fv.verdict,
        issueCodes: fv.issues.map((i) => i.code),
        courseCorrection: fv.course_correction,
      });
      safeEmit("critic_verdict", {
        stepId: "final",
        verdict: fv.verdict,
        issue_codes: fv.issues.map((i) => i.code),
        course_correction: fv.course_correction,
      });
      if (fv.verdict === VERIFIER_VERDICT.pass) {
        break;
      }
      if (
        fv.verdict === VERIFIER_VERDICT.reviseNarrative ||
        fv.course_correction === VERIFIER_VERDICT.reviseNarrative
      ) {
        // Single-flow policy: narrator-repair and rewriteNarrative are both
        // suppressed. The verifier's verdict is still emitted as critic_verdict
        // (visible in workbench) so users see what was flagged without having
        // the synthesized answer silently swapped out.
        const issuesText = fv.issues.map((i) => i.description).join("; ");
        safeEmit("flow_decision", {
          layer: "verifier-rewrite-final",
          chosen: "kept-original",
          reason: `Rewrite suppressed (single-flow policy); ${issuesText.slice(0, 400)}`.slice(0, 500),
          candidates: fv.issues.map((i) => i.code).slice(0, 8),
        });
      }
      break;
    }

    {
      const finalCritic = [...trace.criticRounds]
        .reverse()
        .find((c) => c.stepId === "final");
      appendInterAgentMessage(
        trace,
        {
          from: "Verifier",
          to: "Coordinator",
          intent: "final_verdict",
          evidenceRefs: ["final", finalCritic?.verdict ?? "unknown"],
          meta: { verdict: finalCritic?.verdict ?? "" },
        },
        safeEmit
      );
    }

    preservedAnswer = answer;
    trace.endedAt = Date.now();
    agentLog("turn_done", {
      turnId,
      tools: toolCallsDone,
      llmCalls,
      mode: ctx.mode,
      legacyFallback: false,
      ragHitCount: lastRagHitCount,
    });

    return {
      answer,
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
      agentSuggestionHints: agentSuggestionHints.length ? agentSuggestionHints : undefined,
      ...(followUpPrompts?.length ? { followUpPrompts } : {}),
      ...(envelopeMagnitudes?.length ? { magnitudes: envelopeMagnitudes } : {}),
      ...(envelopeUnexplained ? { unexplained: envelopeUnexplained } : {}),
      ...(envelopeAnswerEnvelope ? { answerEnvelope: envelopeAnswerEnvelope } : {}),
      ...(dashboardDraft ? { dashboardDraft } : {}),
      ...(accumulatedSpawnedQuestions.length ? { spawnedQuestions: accumulatedSpawnedQuestions } : {}),
      ...(ctx.blackboard ? { blackboard: ctx.blackboard } : {}),
      // W13 · compact persistable digest of the analytical blackboard so
      // the client can render an "Investigation summary" card. Returns
      // undefined when blackboard has nothing material to show.
      ...(buildInvestigationSummary(ctx.blackboard)
        ? { investigationSummary: buildInvestigationSummary(ctx.blackboard) }
        : {}),
      lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
      ...briefOut(),
      ...appliedFiltersOut(),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "AGENT_LLM_BUDGET") {
      trace.budgetHits?.push("max_llm_calls");
      trace.endedAt = Date.now();
      agentLog("turn_budget", {
        turnId,
        kind: "llm",
        mode: ctx.mode,
        legacyFallback: false,
      });
      materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
      const partial =
        delegateAnswer ||
        (observations.length > 0
          ? observations.join("\n\n").slice(0, config.observationMaxChars)
          : "Agent LLM budget exceeded for this turn.");
      return {
        answer: partial,
        charts: mergedCharts.length ? mergedCharts : undefined,
        insights: mergedInsights.length ? mergedInsights : undefined,
        table,
        operationResult,
        agentTrace: capAgentTrace(trace),
        lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
        ...briefOut(),
      ...appliedFiltersOut(),
      };
    }
    trace.endedAt = Date.now();
    agentLog("turn_error", {
      turnId,
      err: msg.slice(0, 200),
      mode: ctx.mode,
      legacyFallback: false,
    });
    materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);
    const errFallback =
      preservedAnswer.trim() ||
      observationsFallbackAnswer() ||
      "";
    return {
      answer:
        errFallback ||
        `The analysis agent encountered an error (${msg.length > 200 ? `${msg.slice(0, 200)}…` : msg}). Please try again.`,
      charts: mergedCharts.length ? mergedCharts : undefined,
      insights: mergedInsights.length ? mergedInsights : undefined,
      table,
      operationResult,
      agentTrace: capAgentTrace(trace),
      ...(followUpPrompts?.length ? { followUpPrompts } : {}),
      lastAnalyticalRowsForEnrichment: lastAnalyticalRowsSnapshot(ctx),
      ...briefOut(),
      ...appliedFiltersOut(),
    };
  }
}
