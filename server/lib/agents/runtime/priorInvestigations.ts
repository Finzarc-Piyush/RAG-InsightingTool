/**
 * Wave W21 · prior-turn investigation carry-over
 *
 * Two pure helpers:
 *   1. `appendPriorInvestigation` — pushes a turn's `InvestigationSummary`
 *      into `sessionAnalysisContext.sessionKnowledge.priorInvestigations`
 *      with FIFO eviction (cap = 5) and string clipping. Idempotent on the
 *      input session-context (returns a new object).
 *   2. `formatPriorInvestigationsForPlanner` — renders the array as a
 *      labelled markdown block the planner can read directly. Emitted by
 *      `formatUserAndSessionJsonBlocks` so every prompt gets the same
 *      stable text — keeps prefix-cache friendly.
 *
 * Why this lives outside `sessionAnalysisContext.ts`: that file is the merge
 * machinery (LLM-driven). The W21 carry-over is deterministic — no LLM
 * call needed — so it sits in the agents/runtime layer alongside the other
 * deterministic block builders.
 */
import type {
  InvestigationSummary,
  SessionAnalysisContext,
} from "../../../shared/schema.js";

const MAX_PRIOR = 5;
const MAX_HYPOTHESIS_TEXT = 200;
const MAX_QUESTION_TEXT = 280;
const MAX_HEADLINE_FINDING = 280;
const PER_BUCKET_MAX = 5;

export type PriorInvestigation = NonNullable<
  NonNullable<SessionAnalysisContext["sessionKnowledge"]>["priorInvestigations"]
>[number];

function clip(s: string | undefined, max: number): string {
  const trimmed = s?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed) return "";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Build a single `PriorInvestigation` digest from a turn's question and the
 * `InvestigationSummary` we already persist on the message. Returns
 * `undefined` when the summary is empty AND the question is empty —
 * nothing worth carrying.
 */
export function buildPriorInvestigationDigest(
  question: string,
  summary: InvestigationSummary | undefined,
  at: string = new Date().toISOString()
): PriorInvestigation | undefined {
  const q = clip(question, MAX_QUESTION_TEXT);
  if (!q) return undefined;

  const hypsByStatus = (status: string): string[] =>
    (summary?.hypotheses ?? [])
      .filter((h) => h.status === status)
      .slice(0, PER_BUCKET_MAX)
      .map((h) => clip(h.text, MAX_HYPOTHESIS_TEXT))
      .filter((t): t is string => t.length > 0);

  const confirmed = hypsByStatus("confirmed");
  const refuted = hypsByStatus("refuted");
  const open = [
    ...hypsByStatus("open"),
    ...hypsByStatus("partial"),
  ].slice(0, PER_BUCKET_MAX);

  // Headline finding = the most-significant entry. The blackboard already
  // sorts by significance in `buildInvestigationSummary`, so just take the
  // first non-routine if present, else the first overall.
  const findings = summary?.findings ?? [];
  const headline =
    findings.find((f) => f.significance !== "routine") ?? findings[0];
  const headlineFinding = headline
    ? clip(headline.label, MAX_HEADLINE_FINDING)
    : "";

  if (
    confirmed.length === 0 &&
    refuted.length === 0 &&
    open.length === 0 &&
    !headlineFinding
  ) {
    return undefined;
  }

  return {
    at,
    question: q,
    hypothesesConfirmed: confirmed,
    hypothesesRefuted: refuted,
    hypothesesOpen: open,
    ...(headlineFinding ? { headlineFinding } : {}),
  };
}

/**
 * Push a digest onto sessionAnalysisContext.sessionKnowledge.priorInvestigations
 * with FIFO eviction (oldest dropped first). Returns a new
 * SessionAnalysisContext; the input is not mutated.
 */
export function appendPriorInvestigation(
  ctx: SessionAnalysisContext,
  digest: PriorInvestigation
): SessionAnalysisContext {
  const prev = ctx.sessionKnowledge.priorInvestigations ?? [];
  const next = [...prev, digest].slice(-MAX_PRIOR);
  return {
    ...ctx,
    sessionKnowledge: {
      ...ctx.sessionKnowledge,
      priorInvestigations: next,
    },
  };
}

/**
 * Markdown block emitted into the planner / reflector prompt when prior
 * investigations exist. Returns "" when the array is empty so callers can
 * concatenate without conditional logic. Stable byte-for-byte across calls
 * with the same input — keeps prefix-cache hits.
 */
export function formatPriorInvestigationsForPlanner(
  ctx: SessionAnalysisContext | undefined
): string {
  const prior = ctx?.sessionKnowledge?.priorInvestigations ?? [];
  if (prior.length === 0) return "";

  const lines: string[] = [
    "PRIOR_INVESTIGATIONS (last turns; chain hypotheses, do not re-run settled questions, pick up open threads — figures still come from this turn's tool output):",
  ];
  prior.forEach((p, i) => {
    lines.push(`  [${i + 1}] ${p.at} · Q: ${p.question}`);
    if (p.headlineFinding) {
      lines.push(`      Headline: ${p.headlineFinding}`);
    }
    if (p.hypothesesConfirmed.length > 0) {
      lines.push(`      Confirmed: ${p.hypothesesConfirmed.join("; ")}`);
    }
    if (p.hypothesesRefuted.length > 0) {
      lines.push(`      Refuted: ${p.hypothesesRefuted.join("; ")}`);
    }
    if (p.hypothesesOpen.length > 0) {
      lines.push(`      Open: ${p.hypothesesOpen.join("; ")}`);
    }
  });
  return lines.join("\n");
}
