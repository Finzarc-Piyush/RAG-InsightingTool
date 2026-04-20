import type { AgentTrace, InterAgentMessage } from "./types.js";
import { isInterAgentTraceEnabled } from "./types.js";

const MAX_MESSAGES = 48;
const MAX_INTENT_CHARS = 400;

type AppendInput = Omit<InterAgentMessage, "at"> & { at?: number };

export type AgentSseLikeEmitter = (event: string, data: unknown) => void;

function normalizeMeta(m?: Record<string, string>): Record<string, string> | undefined {
  if (!m || !Object.keys(m).length) return undefined;
  return Object.fromEntries(
    Object.entries(m)
      .slice(0, 12)
      .map(([k, v]) => [k.slice(0, 64), (v ?? "").slice(0, 240)])
  );
}

/**
 * Compact digest of handoffs for planner/reflector prompts (bounded characters; keeps **tail**
 * so recent replan/reflector decisions are preserved when truncated).
 */
export function formatInterAgentHandoffsForPrompt(
  messages: InterAgentMessage[] | undefined,
  maxChars: number
): string | undefined {
  if (!messages?.length || maxChars < 80) return undefined;
  const lines: string[] = [];
  for (const m of messages) {
    const arts = m.artifacts?.length ? ` artifacts=${m.artifacts.join(",")}` : "";
    const ev = m.evidenceRefs?.length ? ` evidence=${m.evidenceRefs.join(",")}` : "";
    const bq = m.blockingQuestions?.length
      ? ` ask=${m.blockingQuestions[0]!.slice(0, 120)}`
      : "";
    const meta =
      m.meta && Object.keys(m.meta).length ?
        ` ${Object.entries(m.meta)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
          .slice(0, 200)}`
      : "";
    lines.push(`- [${m.from}→${m.to}] ${m.intent}${arts}${ev}${bq}${meta}`);
  }
  let s = lines.join("\n");
  if (s.length > maxChars) {
    s = `…(truncated)\n${s.slice(-(maxChars - 20))}`;
  }
  const t = s.trim();
  return t.length ? t : undefined;
}

/**
 * Append a coordinator-visible handoff when `AGENT_INTER_AGENT_MESSAGES=true` (no-op otherwise).
 * Optionally emits SSE `handoff` for workbench mapping (see agentWorkbench.util).
 */
export function appendInterAgentMessage(
  trace: AgentTrace,
  msg: AppendInput,
  emit?: AgentSseLikeEmitter
): void {
  if (!isInterAgentTraceEnabled()) return;
  const full: InterAgentMessage = {
    at: msg.at ?? Date.now(),
    from: msg.from,
    to: msg.to,
    intent: (msg.intent ?? "").slice(0, MAX_INTENT_CHARS),
    artifacts: msg.artifacts?.slice(0, 24).map((a) => a.slice(0, 160)),
    evidenceRefs: msg.evidenceRefs?.slice(0, 24).map((r) => r.slice(0, 160)),
    blockingQuestions: msg.blockingQuestions?.slice(0, 4).map((q) => q.slice(0, 320)),
    meta: normalizeMeta(msg.meta),
  };
  if (!trace.interAgentMessages) trace.interAgentMessages = [];
  trace.interAgentMessages.push(full);
  if (trace.interAgentMessages.length > MAX_MESSAGES) {
    trace.interAgentMessages = trace.interAgentMessages.slice(-MAX_MESSAGES);
  }
  emit?.("handoff", {
    at: full.at,
    from: full.from,
    to: full.to,
    intent: full.intent,
    artifacts: full.artifacts,
    evidenceRefs: full.evidenceRefs,
    blockingQuestions: full.blockingQuestions,
    meta: full.meta,
  });
}
