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
    out.push({
      id: `plan-${ts}`,
      kind: "plan",
      title: "Plan",
      code: truncateCode(code),
      language: "markdown",
    });
    return out;
  }

  if (event === "tool_call" && data && typeof data === "object") {
    const t = data as ToolCallSse;
    const name = t.name || "tool";
    const code = tryPrettyJson(t.args_summary || "{}");
    out.push({
      id: `call-${t.id || ts}`,
      kind: "tool_call",
      title: `Tool: ${name}`,
      code: truncateCode(code),
      language: "json",
    });
    return out;
  }

  if (event === "tool_result" && data && typeof data === "object") {
    const t = data as ToolResultSse;
    const ok = t.ok === true ? "ok" : t.ok === false ? "failed" : "?";
    const summary = (t.summary || "").trim() || "(no summary)";
    out.push({
      id: `result-${t.id || ts}`,
      kind: "tool_result",
      title: `Result (${ok})`,
      code: truncateCode(summary),
      language: "text",
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
    out.push({
      id: `critic-${c.stepId || "step"}-${ts}-${Math.random().toString(36).slice(2, 10)}`,
      kind: "critic",
      title: "Critic",
      code: truncateCode(parts.join("\n")),
      language: "text",
    });
    return out;
  }

  return out;
}
