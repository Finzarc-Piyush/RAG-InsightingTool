/**
 * ============================================================================
 * agentLoopFormatters.ts — pure shape/extraction/serialisation helpers for the
 *                          agent loop (extracted from agentLoop.service.ts).
 * ============================================================================
 *
 * WHAT THIS FILE DOES
 *   A cohesive, low-coupling cluster of PURE helper functions that the agent
 *   loop uses to inspect tool results, extract numbers/rows from loosely-typed
 *   payloads, byte-cap the trace before persistence, and format the final
 *   answer string. None of them touch the plan→act→reflect control flow; they
 *   are deterministic transforms over data shapes (a `ToolResult`, an
 *   `AgentTrace`, a row array, an answer body).
 *
 * WHY IT LIVES HERE (and not in agentLoop.service.ts)
 *   These helpers depend only on EXTERNAL modules/types (`ToolResult`,
 *   `Finding`, `AgentExecutionContext`, `AgentTrace`, `AGENT_TRACE_MAX_BYTES`),
 *   never on runtime values defined inside agentLoop.service.ts. Pulling them
 *   into a sibling module keeps the orchestrator file smaller and lets these
 *   transforms be unit-tested in isolation. agentLoop.service.ts re-exports
 *   the publicly-relevant ones so existing importers keep resolving unchanged.
 *
 * BEHAVIOUR: identical to the originals — moved verbatim, no logic change.
 */
import type { AgentExecutionContext, AgentTrace } from "./types.js";
import { AGENT_TRACE_MAX_BYTES } from "./runtimeConfig.js";
import type { ToolResult } from "./toolRegistry.js";
import type { Finding } from "./analyticalBlackboard.js";

export function detectSignificance(summary: string): Finding["significance"] {
  if (/spike|anomal|outlier|unusual|unexpected/i.test(summary)) return "anomalous";
  if (/\b\d{1,3}\.?\d*%|\bhighest\b|\blowest\b|\btop\b|\bbottom\b|\bdeclin|\bsurg|\bjump|\bdrop/i.test(summary)) return "notable";
  return "routine";
}

/**
 * Wave B4 · derive a confidence label for a structured finding from the
 * tool result's analyticalMeta + significance. High = aggregation applied
 * over a sufficient row count; medium = aggregation applied but small N;
 * low = no aggregation OR very small N.
 */
export function pickFindingConfidence(
  result: ToolResult,
  significance: Finding["significance"]
): "low" | "medium" | "high" {
  const meta = result.analyticalMeta;
  const inputN = meta?.inputRowCount ?? 0;
  const outputN = meta?.outputRowCount ?? 0;
  const aggregated = !!meta?.appliedAggregation;
  if (significance === "anomalous" && aggregated && inputN >= 100) return "high";
  if (aggregated && inputN >= 50) return "medium";
  if (aggregated || outputN >= 5) return "medium";
  return "low";
}

/**
 * Wave B4 · best-effort numeric extraction from a tool's `summary` /
 * `numericPayload`. Only fires for unambiguous patterns (single percent or
 * single signed delta). When the pattern is ambiguous, returns undefined and
 * Wave C2 (magnitude audit) treats the finding as unverifiable rather than
 * inventing a number.
 */
export function extractMagnitudeFromSummary(
  summary?: string,
  numericPayload?: string
):
  | {
      value: number;
      unit: string;
      direction?: "up" | "down" | "flat";
    }
  | undefined {
  const text = `${summary ?? ""}\n${numericPayload ?? ""}`;
  // Percent change with explicit sign (e.g. "−12.4%" or "+5.0%").
  const pctMatch = text.match(/([+\-−])\s*(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    const sign = pctMatch[1] === "+" ? 1 : -1;
    const value = sign * parseFloat(pctMatch[2]!);
    return {
      value,
      unit: "%",
      direction: value > 0 ? "up" : value < 0 ? "down" : "flat",
    };
  }
  // Bare percent without sign — treat as magnitude only, no direction.
  const bareMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (bareMatch) return { value: parseFloat(bareMatch[1]!), unit: "%" };
  return undefined;
}

/**
 * Wave B4 · pull simple numeric stats from `numericPayload` (a colon-separated
 * key:value blob written by `run_analytical_query`). Best-effort; unparseable
 * payloads return `[]`.
 */
export function extractStatsFromNumericPayload(
  numericPayload: string | undefined,
  tool: string
): Array<{ kind: string; column?: string; value: number; filter?: Record<string, unknown> }> {
  if (!numericPayload) return [];
  const out: Array<{
    kind: string;
    column?: string;
    value: number;
  }> = [];
  // Look for "metric=value" or "column: number" patterns.
  const matches = numericPayload.matchAll(/(\w[\w_-]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g);
  let count = 0;
  for (const m of matches) {
    if (count >= 6) break;
    const value = parseFloat(m[2]!);
    if (!Number.isFinite(value)) continue;
    out.push({ kind: tool, column: m[1], value });
    count++;
  }
  return out;
}

export function toolTableRowsForIntermediate(tr: ToolResult): Record<string, unknown>[] {
  const t = tr.table;
  if (!t) return [];
  if (Array.isArray(t)) return t as Record<string, unknown>[];
  if (typeof t === "object" && t !== null && Array.isArray((t as { rows?: unknown }).rows)) {
    return (t as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

/** Extract `{rows, columns}` from the loosely-typed `table` field on
 *  AgentLoopResult. Same shape contract as derivePivotDefaultsFromExecution. */
export function extractTableRowsAndColumns(table: unknown): {
  rows: Record<string, unknown>[];
  columns: string[] | null;
} {
  if (!table) return { rows: [], columns: null };
  if (Array.isArray(table)) {
    return { rows: table as Record<string, unknown>[], columns: null };
  }
  if (typeof table === "object" && table !== null) {
    const rows = Array.isArray((table as { rows?: unknown }).rows)
      ? ((table as { rows: Record<string, unknown>[] }).rows)
      : [];
    const cols = Array.isArray((table as { columns?: unknown }).columns)
      ? ((table as { columns: unknown[] }).columns).filter(
          (v): v is string => typeof v === "string"
        )
      : null;
    return { rows, columns: cols };
  }
  return { rows: [], columns: null };
}

export function toolTableColumnOrderForIntermediate(tr: ToolResult): string[] | null {
  const t = tr.table;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const cols = (t as { columns?: unknown }).columns;
  if (!Array.isArray(cols)) return null;
  const out = cols.filter((v): v is string => typeof v === "string");
  return out.length ? out : null;
}

export function lastAnalyticalRowsSnapshot(
  ctx: AgentExecutionContext
): Record<string, unknown>[] | undefined {
  const rows = ctx.lastAnalyticalTable?.rows;
  return rows?.length ? rows : undefined;
}

export function rowKeysFromFirstRow(rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return [];
  return Object.keys(rows[0] as object);
}

export function capAgentTrace(trace: AgentTrace): AgentTrace {
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

export function lastVerdictForStep(trace: AgentTrace, stepId: string): string | undefined {
  for (let i = trace.criticRounds.length - 1; i >= 0; i--) {
    if (trace.criticRounds[i]!.stepId === stepId) {
      return trace.criticRounds[i]!.verdict;
    }
  }
  return undefined;
}

/**
 * W8 · word-count helper for `synthesis_result` telemetry. Whitespace-split
 * is good enough for tracking whether the new 600–1200-word body target is
 * being hit; we don't need locale-aware tokenisation here.
 */
export function countWords(s: string): number {
  const trimmed = s?.trim() ?? "";
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function formatAnswerFromEnvelope(body: string, _keyInsight?: string | null): string {
  // The key insight is surfaced exactly once — in the "Key Insights" section
  // (InsightCard, fed by appendEnvelopeInsight) — so it is NOT appended to the
  // answer body here. Appending it produced a visible duplicate: a bolded
  // "Key insight:" line inside the answer block AND the same sentence again in
  // Key Insights. `_keyInsight` is kept for call-site compatibility but is
  // intentionally unused.
  return body.trim();
}
