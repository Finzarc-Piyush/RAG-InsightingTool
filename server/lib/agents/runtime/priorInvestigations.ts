/**
 * ============================================================================
 * priorInvestigations.ts — remembers what past turns concluded, for the planner
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Across a chat session the agent should remember what earlier questions
 *   settled, so it can chain hypotheses and not re-run work already done. These
 *   pure helpers keep a short rolling memory of past "investigations": each entry
 *   is a compact digest of one turn — its question, headline finding, and which
 *   hypotheses were confirmed / refuted / still open. The list is capped at 5
 *   (oldest dropped first) and all strings are clipped to keep it small.
 *
 * WHY IT MATTERS
 *   It gives the planner cross-turn continuity. Injected into the prompt as a
 *   stable, labelled "PRIOR_INVESTIGATIONS" block, it tells the agent to pick up
 *   open threads and avoid re-settling closed questions — while still drawing all
 *   actual figures from the current turn's fresh tool output. Building this block
 *   the same way every time also keeps prompts prefix-cache friendly.
 *
 * KEY PIECES
 *   - buildPriorInvestigationDigest — distils a turn's question + InvestigationSummary
 *     into one compact digest (or undefined when there's nothing worth keeping).
 *   - appendPriorInvestigation — pushes a digest with FIFO eviction (cap 5);
 *     returns a NEW session-context object (does not mutate the input).
 *   - formatPriorInvestigationsForPlanner — renders the list as the markdown
 *     prompt block ("" when empty).
 *   - Re-exports priorInvestigationItemSchema / PriorInvestigationItem whose
 *     single source of truth lives in shared/schema.ts (avoids a circular import).
 *
 * HOW IT CONNECTS
 *   Reads InvestigationSummary / SessionAnalysisContext (shared/schema.js). The
 *   prompt block is emitted via formatUserAndSessionJsonBlocks into planner /
 *   reflector prompts. Lives in agents/runtime (not sessionAnalysisContext.ts)
 *   because it's deterministic — no LLM merge needed — unlike that file.
 */
import type {
  InvestigationSummary,
  SessionAnalysisContext,
} from "../../../shared/schema.js";

/**
 * Re-export the canonical per-entry schema (defined in `shared/schema.ts` to
 * avoid a circular import — the lib layer imports schema, not the other way
 * round). Callers that already imported priorInvestigations.ts continue to
 * work; the schema's single source of truth lives in `shared/schema.ts`.
 */
export {
  priorInvestigationItemSchema,
  type PriorInvestigationItem,
} from "../../../shared/schema.js";

// A1 · 5 → 8. Carrying a couple more turns of context is what lets the agent
// "build up" across a working session (the user's core complaint) without
// blowing the prompt budget — each digest is small and number-dense.
const MAX_PRIOR = 8;
const MAX_HYPOTHESIS_TEXT = 200;
const MAX_QUESTION_TEXT = 280;
const MAX_HEADLINE_FINDING = 280;
const PER_BUCKET_MAX = 5;
const MAX_KEY_NUMBERS = 3;
const MAX_KEY_NUMBER_LABEL = 200;
const MAX_KEY_NUMBER_VALUE = 120;

/** Loose shape of an answer-envelope magnitude (label + value). */
export interface DigestMagnitude {
  label?: string;
  value?: string;
}

/**
 * Distil the answer envelope's magnitudes into the 2-3 most useful labelled
 * numbers to carry forward. Pure + order-preserving; drops entries missing a
 * label or value so the recall block never renders a dangling "= ".
 */
function buildKeyNumbers(
  magnitudes: ReadonlyArray<DigestMagnitude> | undefined
): { label: string; value: string }[] {
  if (!magnitudes?.length) return [];
  const out: { label: string; value: string }[] = [];
  for (const m of magnitudes) {
    const label = clip(m?.label, MAX_KEY_NUMBER_LABEL);
    const value = clip(m?.value, MAX_KEY_NUMBER_VALUE);
    if (label && value) out.push({ label, value });
    if (out.length >= MAX_KEY_NUMBERS) break;
  }
  return out;
}

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
  at: string = new Date().toISOString(),
  // A1 · `at` stays 3rd-positional for backward compatibility (existing
  // callers pass a timestamp here); magnitudes is appended as the 4th arg.
  magnitudes?: ReadonlyArray<DigestMagnitude>
): PriorInvestigation | undefined {
  const q = clip(question, MAX_QUESTION_TEXT);
  if (!q) return undefined;

  const keyNumbers = buildKeyNumbers(magnitudes);

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
    !headlineFinding &&
    keyNumbers.length === 0
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
    ...(keyNumbers.length > 0 ? { keyNumbers } : {}),
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
    // A1 · the actual numbers this turn established, so the agent can build on
    // them (e.g. compare to "last month") instead of re-running the query.
    if (p.keyNumbers && p.keyNumbers.length > 0) {
      lines.push(
        `      Numbers: ${p.keyNumbers
          .map((k) => `${k.label} = ${k.value}`)
          .join("; ")}`
      );
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
