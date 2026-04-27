import type { AgentWorkbenchEntry } from "../../shared/schema.js";
import {
  AGENT_WORKBENCH_ENTRY_CODE_MAX,
  AGENT_WORKBENCH_MAX_BYTES,
} from "../../lib/agents/runtime/types.js";

function truncateCode(s: string): string {
  if (s.length <= AGENT_WORKBENCH_ENTRY_CODE_MAX) return s;
  return `${s.slice(0, AGENT_WORKBENCH_ENTRY_CODE_MAX)}…`;
}

function workbenchJsonSize(entries: AgentWorkbenchEntry[]): number {
  return JSON.stringify(entries).length;
}

/**
 * Append an entry; drops oldest entries if over byte or count budget.
 */
export function appendWorkbenchEntry(
  workbench: AgentWorkbenchEntry[],
  entry: AgentWorkbenchEntry
): AgentWorkbenchEntry {
  const normalized: AgentWorkbenchEntry = {
    ...entry,
    code: truncateCode(entry.code),
  };
  workbench.push(normalized);
  while (workbench.length > 48) {
    workbench.shift();
  }
  while (workbenchJsonSize(workbench) > AGENT_WORKBENCH_MAX_BYTES && workbench.length > 1) {
    workbench.shift();
  }
  return workbench[workbench.length - 1] ?? normalized;
}

function tryPrettyJson(s: string): string {
  const t = s.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return s;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return s;
  }
}

type PlanSsePayload = {
  rationale?: string;
  steps?: Array<{ id?: string; tool?: string; args_summary?: string }>;
};

type ToolCallSse = { id?: string; name?: string; args_summary?: string };
type ToolResultSse = { id?: string; ok?: boolean; summary?: string };
type CriticSse = {
  stepId?: string;
  verdict?: string;
  issue_codes?: string[];
  course_correction?: string;
};

const INSIGHT_MAX = 400;

function clampInsight(s: string | undefined): string | undefined {
  const trimmed = s?.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length <= INSIGHT_MAX ? trimmed : `${trimmed.slice(0, INSIGHT_MAX - 1)}…`;
}

function firstSentence(s: string): string {
  const m = s.match(/^(.+?[.!?])(?:\s|$)/);
  return m?.[1] ?? s;
}

/** W10 · "what this step means" line for `kind: "plan"`. Prefer the rationale. */
function insightForPlan(p: PlanSsePayload): string | undefined {
  const r = p.rationale?.trim();
  if (r) return clampInsight(firstSentence(r));
  const stepCount = p.steps?.length ?? 0;
  if (stepCount === 0) return undefined;
  const tools = (p.steps ?? [])
    .map((s) => s.tool)
    .filter((t): t is string => Boolean(t))
    .slice(0, 3);
  return clampInsight(
    tools.length > 0
      ? `Planning ${stepCount} step${stepCount === 1 ? "" : "s"}: ${tools.join(", ")}.`
      : `Planning ${stepCount} step${stepCount === 1 ? "" : "s"}.`
  );
}

/** W10 · "what this step means" for `kind: "tool_call"`. */
function insightForToolCall(t: ToolCallSse): string | undefined {
  const name = t.name?.trim();
  if (!name) return undefined;
  const args = (t.args_summary || "").trim();
  // Strip JSON braces for the inline preview so the insight reads as prose.
  const argPreview = args
    .replace(/^[{[]/, "")
    .replace(/[}\]]$/, "")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
  return clampInsight(
    argPreview ? `Calling \`${name}\` with ${argPreview}.` : `Calling \`${name}\`.`
  );
}

/** W10 · "what this step means" for `kind: "tool_result"`. First sentence wins. */
function insightForToolResult(t: ToolResultSse): string | undefined {
  if (t.ok === false) {
    const summary = (t.summary || "").trim();
    return clampInsight(summary ? `Tool failed: ${firstSentence(summary)}` : "Tool failed.");
  }
  const summary = (t.summary || "").trim();
  if (!summary) return undefined;
  return clampInsight(firstSentence(summary));
}

/** W10 · "what this step means" for `kind: "handoff"`. */
function insightForHandoff(h: {
  from?: string;
  to?: string;
  intent?: string;
}): string | undefined {
  const intent = h.intent?.trim();
  const from = h.from?.trim();
  const to = h.to?.trim();
  if (intent && from && to) {
    return clampInsight(`${from} → ${to}: ${intent}`);
  }
  if (intent) return clampInsight(intent);
  if (from && to) return clampInsight(`${from} handed off to ${to}.`);
  return undefined;
}

/** W10 · "what this step means" for `kind: "flow_decision"`. */
function insightForFlowDecision(f: {
  layer?: string;
  chosen?: string;
  overriddenBy?: string;
  reason?: string;
}): string | undefined {
  const reason = f.reason?.trim();
  if (reason) return clampInsight(reason);
  const layer = f.layer?.trim();
  const chosen = f.chosen?.trim();
  if (f.overriddenBy && layer && chosen) {
    return clampInsight(`${layer} overridden to ${chosen} (by ${f.overriddenBy}).`);
  }
  if (layer && chosen) return clampInsight(`${layer} routed to ${chosen}.`);
  return undefined;
}

/** W10 · "what this step means" for `kind: "critic"`. Course correction wins. */
function insightForCritic(c: CriticSse): string | undefined {
  const cc = c.course_correction?.trim();
  if (cc) return clampInsight(firstSentence(cc));
  const issues = c.issue_codes?.filter(Boolean) ?? [];
  const verdict = c.verdict?.trim();
  if (verdict && issues.length) {
    return clampInsight(`${verdict} — ${issues.slice(0, 3).join(", ")}.`);
  }
  if (verdict) return clampInsight(`Verdict: ${verdict}.`);
  return undefined;
}

export function agentSseEventToWorkbenchEntries(
  event: string,
  data: unknown
): AgentWorkbenchEntry[] {
  const out: AgentWorkbenchEntry[] = [];
  const ts = Date.now();

  if (event === "plan" && data && typeof data === "object") {
    const p = data as PlanSsePayload;
    const rationale = (p.rationale || "").trim();
    const lines: string[] = [];
    if (rationale) lines.push(rationale, "");
    const steps = p.steps || [];
    steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.tool || "?"} (${s.id || "step"})`);
      if (s.args_summary) lines.push(`   ${tryPrettyJson(s.args_summary)}`);
    });
    const code = lines.join("\n").trim() || "(empty plan)";
    const insight = insightForPlan(p);
    out.push({
      id: `plan-${ts}`,
      kind: "plan",
      title: "Plan",
      code: truncateCode(code),
      language: "markdown",
      ...(insight ? { insight } : {}),
    });
    return out;
  }

  if (event === "tool_call" && data && typeof data === "object") {
    const t = data as ToolCallSse;
    const name = t.name || "tool";
    const code = tryPrettyJson(t.args_summary || "{}");
    const insight = insightForToolCall(t);
    out.push({
      id: `call-${t.id || ts}`,
      kind: "tool_call",
      title: `Tool: ${name}`,
      code: truncateCode(code),
      language: "json",
      ...(insight ? { insight } : {}),
    });
    return out;
  }

  if (event === "tool_result" && data && typeof data === "object") {
    const t = data as ToolResultSse;
    const ok = t.ok === true ? "ok" : t.ok === false ? "failed" : "?";
    const summary = (t.summary || "").trim() || "(no summary)";
    const insight = insightForToolResult(t);
    out.push({
      id: `result-${t.id || ts}`,
      kind: "tool_result",
      title: `Result (${ok})`,
      code: truncateCode(summary),
      language: "text",
      ...(insight ? { insight } : {}),
    });
    return out;
  }

  if (event === "handoff" && data && typeof data === "object") {
    const h = data as {
      at?: number;
      from?: string;
      to?: string;
      intent?: string;
      artifacts?: string[];
      evidenceRefs?: string[];
      blockingQuestions?: string[];
      meta?: Record<string, string>;
    };
    const payload = {
      intent: h.intent,
      artifacts: h.artifacts,
      evidenceRefs: h.evidenceRefs,
      blockingQuestions: h.blockingQuestions,
      meta: h.meta,
    };
    const code = truncateCode(JSON.stringify(payload, null, 2));
    const insight = insightForHandoff(h);
    out.push({
      id: `handoff-${h.at ?? ts}-${Math.random().toString(36).slice(2, 10)}`,
      kind: "handoff",
      title: `Handoff: ${h.from ?? "?"} → ${h.to ?? "?"}`,
      code,
      language: "json",
      ...(insight ? { insight } : {}),
    });
    return out;
  }

  if (event === "flow_decision" && data && typeof data === "object") {
    const f = data as {
      layer?: string;
      chosen?: string;
      overriddenBy?: string;
      reason?: string;
      confidence?: number;
      candidates?: string[];
    };
    const layer = (f.layer || "unknown").slice(0, 80);
    const chosen = (f.chosen || "?").slice(0, 120);
    const overriddenBy = f.overriddenBy ? f.overriddenBy.slice(0, 120) : undefined;
    const title = overriddenBy
      ? `Override: ${layer} → ${chosen}`
      : `Routed: ${layer} → ${chosen}`;
    const lines = [
      `layer: ${layer}`,
      `chosen: ${chosen}`,
      overriddenBy ? `overriddenBy: ${overriddenBy}` : "",
      typeof f.confidence === "number" ? `confidence: ${f.confidence.toFixed(2)}` : "",
      f.candidates?.length ? `candidates: ${f.candidates.slice(0, 8).join(", ")}` : "",
      f.reason ? `reason: ${f.reason}` : "",
    ].filter(Boolean);
    const fdInsight = insightForFlowDecision(f);
    out.push({
      id: `fd-${ts}-${Math.random().toString(36).slice(2, 10)}`,
      kind: "flow_decision",
      title: title.slice(0, 500),
      code: truncateCode(lines.join("\n")),
      language: "text",
      ...(fdInsight ? { insight: fdInsight } : {}),
      flowDecision: {
        layer,
        chosen,
        ...(overriddenBy ? { overriddenBy } : {}),
        ...(typeof f.confidence === "number" && f.confidence >= 0 && f.confidence <= 1
          ? { confidence: f.confidence }
          : {}),
        ...(f.candidates?.length
          ? { candidates: f.candidates.slice(0, 8).map((c) => String(c).slice(0, 200)) }
          : {}),
        ...(f.reason ? { reason: String(f.reason).slice(0, 500) } : {}),
      },
    });
    return out;
  }

  if (event === "critic_verdict" && data && typeof data === "object") {
    const c = data as CriticSse;
    // Per-step critic still runs server-side; workbench shows only final synthesis review by default.
    const showAllCritics =
      process.env.AGENT_SSE_CRITIC_FINAL_ONLY === "0" ||
      process.env.AGENT_SSE_CRITIC_FINAL_ONLY === "false";
    if (!showAllCritics && c.stepId !== "final") {
      return out;
    }
    const parts = [
      `Verdict: ${c.verdict || "?"}`,
      c.stepId ? `Step: ${c.stepId}` : "",
      c.issue_codes?.length ? `Issues: ${c.issue_codes.join(", ")}` : "",
      c.course_correction ? `Course correction:\n${c.course_correction}` : "",
    ].filter(Boolean);
    const insight = insightForCritic(c);
    out.push({
      id: `critic-${c.stepId || "step"}-${ts}-${Math.random().toString(36).slice(2, 10)}`,
      kind: "critic",
      title: "Critic",
      code: truncateCode(parts.join("\n")),
      language: "text",
      ...(insight ? { insight } : {}),
    });
    return out;
  }

  return out;
}
