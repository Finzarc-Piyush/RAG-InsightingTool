/**
 * Wave W19 · enrichStepInsights — single-batched per-step LLM commentary
 *
 * After synthesis completes, fire ONE LLM call that takes the accumulated
 * workbench entries plus the final answer and returns a richer 1–2 sentence
 * interpretation per step. Backfills `entry.insight` in-place; deterministic
 * W10 insights stay as the fallback for entries the LLM omits.
 *
 * Design notes:
 *   - Single LLM call per turn (cheap model — `getInsightModel`). One extra
 *     call's latency (~2–5s) is the only user-visible cost. Gated by env.
 *   - Skips noise rows (`flow_decision` with no insight or override) so the
 *     LLM sees only meaningful steps.
 *   - Cap each enriched insight at 200 chars to match the W10 schema cap.
 *   - On any failure (LLM error, parse error, env disabled) returns the
 *     workbench unchanged. The deterministic W10 insights ship as-is.
 *
 * Why this lives outside `agentLoop.service.ts`: the agent loop doesn't
 * accumulate the workbench (it streams events via SSE; the workbench is
 * built up in `chatStream.service.ts`). Running enrichment after the agent
 * loop returns keeps the loop pure and the entire workbench available for
 * a single batched call.
 */
import type {
  AgentWorkbenchEntry,
  SessionAnalysisContext,
} from "../../../shared/schema.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { z } from "zod";
import { getInsightModel, getInsightTemperature } from "../../insightSynthesis/insightModelConfig.js";
import { agentLog } from "./agentLogger.js";

export function isRichStepInsightsEnabled(): boolean {
  return process.env.RICH_STEP_INSIGHTS_ENABLED === "true";
}

const ENRICHED_INSIGHT_MAX = 200;
const FINAL_ANSWER_PREVIEW_MAX = 4_000;
const ENTRY_SUMMARY_MAX = 400;
const MAX_ENTRIES_PER_CALL = 20;

const enrichStepInsightsSchema = z.object({
  insights: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        text: z.string().min(1),
      })
    )
    .max(MAX_ENTRIES_PER_CALL),
});

export interface EnrichStepInsightsParams {
  workbench: AgentWorkbenchEntry[];
  finalAnswer: string;
  /**
   * Optional: feeds the dataset short-description into the prompt so each
   * enriched insight can reference what the data is about.
   */
  sessionAnalysisContext?: SessionAnalysisContext;
  /**
   * Optional: composed FMCG/Marico domain pack text. When present the LLM
   * may cite the pack id verbatim in the enriched insight.
   */
  domainContext?: string;
  turnId: string;
  onLlmCall?: () => void;
}

export interface EnrichResult {
  /** True when the LLM call ran and at least one entry was enriched. */
  ok: boolean;
  /** Number of entries the LLM provided enriched insights for. */
  enrichedCount: number;
  /** Latency in ms; 0 when the wave was skipped or failed pre-LLM. */
  latencyMs: number;
}

function isMeaningfulEntry(entry: AgentWorkbenchEntry): boolean {
  if (entry.kind === "flow_decision") {
    return Boolean(entry.insight) || Boolean(entry.flowDecision?.overriddenBy) ||
      Boolean(entry.flowDecision?.reason);
  }
  return true;
}

function clip(s: string, max: number): string {
  if (!s) return "";
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Enrich the workbench in-place. Returns telemetry; on failure the
 * workbench is unchanged and `ok: false` is reported. The caller decides
 * whether to emit an SSE event or just rely on persistence.
 */
export async function enrichStepInsights(
  params: EnrichStepInsightsParams
): Promise<EnrichResult> {
  if (!isRichStepInsightsEnabled()) {
    return { ok: false, enrichedCount: 0, latencyMs: 0 };
  }
  const startedAt = Date.now();

  const candidates = params.workbench.filter(isMeaningfulEntry).slice(0, MAX_ENTRIES_PER_CALL);
  if (candidates.length === 0 || !params.finalAnswer.trim()) {
    return { ok: false, enrichedCount: 0, latencyMs: 0 };
  }

  const stepsBlock = candidates
    .map((e) => {
      const summary = clip(e.insight ?? e.code, ENTRY_SUMMARY_MAX);
      return `- id: ${e.id}\n  kind: ${e.kind}\n  title: ${clip(e.title, 200)}\n  current_insight: ${summary}`;
    })
    .join("\n");

  const sacBrief = params.sessionAnalysisContext?.dataset?.shortDescription
    ? `\n\nDATASET: ${params.sessionAnalysisContext.dataset.shortDescription.trim().slice(0, 600)}`
    : "";
  const domainBrief = params.domainContext?.trim()
    ? `\n\nDOMAIN (FMCG/Marico — orientation only, never numeric evidence): ${params.domainContext.trim().slice(0, 1500)}`
    : "";

  const system = `You are a senior data analyst summarising the *interpretation* of each step in a multi-step analysis for a non-technical reader. For each step listed, write a 1–2 sentence enriched insight that:
- Connects the step to the analysis arc (what it contributed to the final answer).
- Uses domain context where it adds clarity, citing the pack id verbatim when relevant.
- Stays grounded ONLY in the step's current_insight, the final answer, the dataset description, and the domain context. Do NOT invent figures or claims.
- Is ≤200 characters; one sentence is fine when nothing more adds value.

Output ONLY JSON:
{ "insights": [ { "id": "<step id>", "text": "<enriched 1–2 sentences>" }, ... ] }`;

  const user = `STEPS (in order, with their deterministic 1-line insights):
${stepsBlock}

FINAL ANSWER (for context only — do NOT echo it back):
${clip(params.finalAnswer, FINAL_ANSWER_PREVIEW_MAX)}${sacBrief}${domainBrief}`;

  const out = await completeJson(system, user, enrichStepInsightsSchema, {
    turnId: `${params.turnId}_step_enrich`,
    maxTokens: 1_500,
    temperature: getInsightTemperature(),
    model: getInsightModel(),
    onLlmCall: params.onLlmCall,
    purpose: LLM_PURPOSE.INSIGHT_GEN,
  });
  if (!out.ok) {
    agentLog("rich_step_insights.failed", {
      turnId: params.turnId,
      error: out.error.slice(0, 200),
    });
    return { ok: false, enrichedCount: 0, latencyMs: Date.now() - startedAt };
  }

  // Backfill in-place. Build an id→text map to avoid O(n²) lookups.
  const enrichedById = new Map<string, string>();
  for (const item of out.data.insights) {
    const text = clip(item.text, ENRICHED_INSIGHT_MAX);
    if (text) enrichedById.set(item.id, text);
  }

  let enrichedCount = 0;
  for (const entry of params.workbench) {
    const enriched = enrichedById.get(entry.id);
    if (enriched) {
      entry.insight = enriched;
      enrichedCount++;
    }
  }

  const latencyMs = Date.now() - startedAt;
  agentLog("rich_step_insights.ok", {
    turnId: params.turnId,
    candidateCount: candidates.length,
    enrichedCount,
    latencyMs,
  });
  return { ok: true, enrichedCount, latencyMs };
}
