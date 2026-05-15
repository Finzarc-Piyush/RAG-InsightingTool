/**
 * Business Action Items agent.
 *
 * Runs *after* the narrator's answer envelope has passed all deterministic
 * gates AND the final verifier returned `pass`. Reads the completed envelope
 * + question + domain context + user notes and decides whether to emit a
 * short list of CONCRETE BUSINESS ACTIONS — things the user could do in the
 * world to act on the analysis, distinct from the analytical next-steps that
 * already live in `answerEnvelope.recommendations[]`.
 *
 * Self-gating: the agent is invited on every passing turn (cheap MINI-routed
 * call). When the question isn't a strategy ask, or the envelope's findings
 * don't ground at least 2 actions, the agent returns `{ items: [] }` and the
 * client renders no section. There is intentionally no regex or classifier
 * gate above this — past iterations of that gate silently suppressed
 * legitimate strategy phrasings ("the team's wondering what to do about
 * LASHE — talk me through it") and produced false negatives.
 *
 * Failure mode: any error or timeout returns `[]` to the caller, which means
 * the answer envelope is delivered/persisted exactly as it would have been
 * without this agent. Zero impact on the existing analytical path.
 */

import { z } from "zod";
import type { Message } from "../../../shared/schema.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { agentLog } from "./agentLogger.js";
import type { AgentExecutionContext } from "./types.js";
import { extractStrategyIntentHints } from "./businessActionsHints.js";
import {
  formatDimensionHierarchiesBlock,
  formatWideFormatShapeBlock,
} from "./context.js";

type AnswerEnvelope = NonNullable<Message["answerEnvelope"]>;
export type BusinessActionItem = NonNullable<Message["businessActions"]>[number];

/**
 * Mirrors `answerEnvelope.businessActions[number]` from `shared/schema.ts`
 * exactly. The wrapper `{ items: [...] }` lets the agent return an empty
 * array when actions aren't warranted without struggling against
 * `z.array(...).min(1)` on the top-level shape.
 */
const businessActionsOutputSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(4).max(160),
        rationale: z.string().min(10).max(400),
        horizon: z.enum(["now", "this_quarter", "strategic"]),
        confidence: z.enum(["low", "medium", "high"]),
        dependencies: z.string().max(280).optional(),
        expectedImpact: z.string().max(200).optional(),
      })
    )
    .max(5),
});

const SYSTEM_PROMPT = `You are a senior FMCG / consumer-goods business strategist embedded in an analytical chat tool. You read a completed analytical answer (the user has already seen it) and decide whether the user's question warrants a short list of CONCRETE BUSINESS ACTIONS — decisions or moves the user could take in the business, distinct from analytical next steps.

WHEN TO EMIT ACTIONS (return non-empty \`items\`):
- The user is asking a strategy / decision / "what should we do" question — explicit ("how do I increase sales", "what should we do about LASHE") OR implicit ("the team's wondering what to do", "your take?", "any thoughts on the situation"), AND
- You can ground at least 2 actions in specific findings, magnitudes, or implications from the ANSWER ENVELOPE.

WHEN TO RETURN { items: [] } (preferred over weak output):
- The user asked a purely descriptive / analytical question (e.g. "what are sales by brand", "show me the trend", "compare X vs Y") and is not seeking a business decision.
- The envelope has fewer than 2 grounded findings, or its caveats are so strong that any action would be irresponsible.
- Better to render nothing than to render boilerplate.

ACTION CONTRACT — each item must:
- have a TITLE that is a concrete imperative ≤ 160 chars ("Run a 90-day shelf-share audit in metro stores"; NOT "Improve performance" or "Look into things").
- have a RATIONALE that ties the action to a specific FINDING or MAGNITUDE from the envelope, citing it inline (e.g. "Q4 share fell 4.2pp vs Q3 (finding 2)"). NEVER invent numbers or mention metrics not in the envelope.
- specify a HORIZON: "now" (this week), "this_quarter", or "strategic" (>1 quarter / requires investment / org change).
- specify a CONFIDENCE per the rubric below.
- be DISTINCT from anything already in the envelope's \`recommendations[]\` (those are analytical next steps inside the app — these are decisions to act on outside it).
- be GROUNDED in domain reality. If the FMCG / Marico domain context is provided, use it for vocabulary and plausibility (channels, formats, festive calendars, distribution mechanics) — but never invent domain facts the data doesn't support.

CONFIDENCE RUBRIC:
- "high" — directly grounded in a quantified finding or magnitude with low caveat weight; the action is the obvious response to what the data shows.
- "medium" — grounded in a finding but requires an assumption, requires cross-source validation, or has a counter-pull from a caveat. Most actions land here.
- "low" — directionally suggested by findings but materially under-evidenced (single noisy data point, contradicted by a caveat, depends on an external assumption). MUST then populate \`dependencies\` describing what would lift confidence (e.g. "Validate with rep-panel data before committing budget").

NEVER:
- Invent metric names, brand names, channels, regions, or facts not in the envelope or domain context.
- Repeat what's already in \`recommendations[]\`. (If the envelope already says "drill into Q3 segments", do not emit "drill into Q3 segments" as an action.)
- Manufacture confidence — "low" is a legitimate, useful answer when evidence is thin.
- Emit more than 5 items. The section is opinionated, not exhaustive.
- Treat a dimension's rollup-row as a peer in any action. If the DIMENSION HIERARCHIES block lists a column with a rollupValue (e.g. "FEMALE SHOWER GEL" is the category total for "Products"), actions on that dimension MUST treat the rollup as the category whole — never as a competing item ("focus on FEMALE SHOWER GEL vs MARICO" is wrong; "lift MARICO's share within the FEMALE SHOWER GEL category" is right).
- Reference original wide-format column names. If the DATASET SHAPE block flags the dataset was melted (wide→long), the column names "Q3 2024 Value Sales" / "MAT-2024 Volume" no longer exist — refer to the Period column + the Metric (or measure) column instead. Compound-shape SUM(Value) is only meaningful when scoped by a Metric value.

OUTPUT: JSON exactly matching \`{ items: BusinessActionItem[] }\`. Empty array is valid and preferred to weak output.`;

const ENVELOPE_SECTION_CHAR_CAP = 6000;
const DOMAIN_CONTEXT_CHAR_CAP = 2500;
const PERMANENT_CONTEXT_CHAR_CAP = 1200;
const PRIOR_INVESTIGATION_CHAR_CAP = 800;

/**
 * Serialise the envelope into a compact, citation-friendly text block. We
 * include only the fields the agent needs to ground actions and skip the
 * markdown body (already too verbose for this purpose).
 */
function formatEnvelopeForActions(env: AnswerEnvelope | undefined): string {
  if (!env) return "(no envelope available)";
  const parts: string[] = [];
  if (env.tldr) parts.push(`TL;DR: ${env.tldr}`);
  if (env.findings?.length) {
    parts.push(
      "FINDINGS:\n" +
        env.findings
          .map((f, i) => {
            const mag = f.magnitude ? ` [magnitude: ${f.magnitude}]` : "";
            return `${i + 1}. ${f.headline}${mag}\n   evidence: ${f.evidence}`;
          })
          .join("\n")
    );
  }
  if (env.implications?.length) {
    parts.push(
      "IMPLICATIONS:\n" +
        env.implications
          .map(
            (im, i) =>
              `${i + 1}. ${im.statement} → ${im.soWhat}${
                im.confidence ? ` (${im.confidence} confidence)` : ""
              }`
          )
          .join("\n")
    );
  }
  if (env.caveats?.length) {
    parts.push("CAVEATS:\n- " + env.caveats.join("\n- "));
  }
  if (env.recommendations?.length) {
    parts.push(
      "EXISTING ANALYTICAL NEXT STEPS (do NOT repeat these as business actions):\n" +
        env.recommendations
          .map(
            (r, i) =>
              `${i + 1}. ${r.action}${
                r.horizon ? ` [${r.horizon}]` : ""
              } — ${r.rationale}`
          )
          .join("\n")
    );
  }
  if (env.domainLens) {
    parts.push(`DOMAIN LENS: ${env.domainLens}`);
  }
  const joined = parts.join("\n\n");
  return joined.length > ENVELOPE_SECTION_CHAR_CAP
    ? joined.slice(0, ENVELOPE_SECTION_CHAR_CAP) + "\n[envelope truncated]"
    : joined;
}

function formatPriorInvestigations(
  ctx: AgentExecutionContext
): string | null {
  const items =
    ctx.sessionAnalysisContext?.sessionKnowledge?.priorInvestigations;
  if (!items?.length) return null;
  const top = items.slice(-3);
  const text = top
    .map((p, i) => {
      const finding = p.headlineFinding ? ` — ${p.headlineFinding}` : "";
      return `${i + 1}. (${p.at}) ${p.question}${finding}`;
    })
    .join("\n");
  return text.length > PRIOR_INVESTIGATION_CHAR_CAP
    ? text.slice(0, PRIOR_INVESTIGATION_CHAR_CAP) + "\n[truncated]"
    : text;
}

function formatHintsBlock(hints: string[]): string {
  if (!hints.length) {
    return "INTENT HINTS (surface-form regex; empty does NOT mean the question lacks strategy intent):\n(none — decide from the question semantics)";
  }
  return (
    "INTENT HINTS (surface-form regex; informational only — agent decides):\n- " +
    hints.join("\n- ")
  );
}

function buildUserMessage(
  ctx: AgentExecutionContext,
  envelope: AnswerEnvelope | undefined
): string {
  const hints = extractStrategyIntentHints(ctx.question);
  const sections: string[] = [];
  sections.push(`USER QUESTION: ${ctx.question}`);
  sections.push(formatHintsBlock(hints));
  sections.push("ANSWER ENVELOPE (the analytical answer the user just saw):\n" + formatEnvelopeForActions(envelope));
  const userIntent = ctx.sessionAnalysisContext?.userIntent;
  const permanent = (ctx.permanentContext ?? "").trim();
  const userNotesParts: string[] = [];
  if (userIntent) {
    const verbatim = (userIntent.verbatimNotes ?? "").trim();
    const constraints = (userIntent.interpretedConstraints ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (verbatim) userNotesParts.push(`stated intent: ${verbatim}`);
    if (constraints.length) {
      userNotesParts.push(
        `interpreted constraints:\n- ${constraints.join("\n- ")}`
      );
    }
  }
  if (permanent) {
    userNotesParts.push(`notes: ${permanent}`);
  }
  if (userNotesParts.length) {
    const joined = userNotesParts.join("\n");
    sections.push(
      "USER NOTES:\n" +
        (joined.length > PERMANENT_CONTEXT_CHAR_CAP
          ? joined.slice(0, PERMANENT_CONTEXT_CHAR_CAP) + "\n[truncated]"
          : joined)
    );
  }
  if (ctx.domainContext && ctx.domainContext.trim()) {
    const dc = ctx.domainContext.trim();
    sections.push(
      "FMCG / MARICO DOMAIN CONTEXT (background only; cite pack id when used; never numeric evidence):\n" +
        (dc.length > DOMAIN_CONTEXT_CHAR_CAP
          ? dc.slice(0, DOMAIN_CONTEXT_CHAR_CAP) + "\n[truncated]"
          : dc)
    );
  }
  const prior = formatPriorInvestigations(ctx);
  if (prior) {
    sections.push("PRIOR INVESTIGATIONS (most recent first; for cross-turn continuity):\n" + prior);
  }
  // Wave B2 · Dimension hierarchies (H1+) — if any column has a user-
  // declared rollup row (e.g. "FEMALE SHOWER GEL" is a category total in
  // the Marico-VN dataset), the agent must NOT recommend "deep dive on
  // FEMALE SHOWER GEL vs MARICO" — they're not peers. Without this
  // block the agent treated the rollup as a competing brand.
  const hierarchies = formatDimensionHierarchiesBlock(ctx);
  if (hierarchies) {
    sections.push(hierarchies);
  }
  // Wave B2 · Wide-format shape (WPF1+) — when the dataset arrived in
  // wide form and was melted at upload time, the agent must know about
  // the Period/PeriodIso semantics and the compound-shape Metric column.
  // Without this block recommended actions could reference the original
  // wide column names ("Q3 2024 Value Sales") which no longer exist
  // post-melt, or recommend SUM(Value) without scoping by Metric — both
  // of which produce nonsense follow-ups.
  if (ctx.summary) {
    const shape = formatWideFormatShapeBlock(ctx.summary);
    if (shape) {
      sections.push(shape);
    }
  }
  sections.push(
    'Return JSON exactly: { "items": BusinessActionItem[] }. Empty array is valid and preferred to weak output.'
  );
  return sections.join("\n\n");
}

export interface RunBusinessActionsOptions {
  /** Per-turn correlation id passed to LLM telemetry. */
  turnId: string;
  /** Increment cost counter on the agent loop. */
  onLlmCall?: () => void;
}

/**
 * Run the agent. Returns `[]` on any failure (LLM error, schema mismatch,
 * empty self-gate). Never throws — caller can fire-and-await without
 * defensive wrappers.
 */
export async function runBusinessActions(
  ctx: AgentExecutionContext,
  envelope: AnswerEnvelope | undefined,
  opts: RunBusinessActionsOptions
): Promise<BusinessActionItem[]> {
  // Hard skip when there's nothing to ground actions on. The agent would
  // self-gate to empty anyway; saves an LLM call on edge-case turns.
  const findingsCount = envelope?.findings?.length ?? 0;
  const magnitudesPresent = (envelope?.findings ?? []).some((f) => !!f.magnitude);
  if (findingsCount < 2 && !magnitudesPresent) {
    agentLog("businessActionsAgent.skip_no_findings", {
      turnId: opts.turnId,
      findingsCount,
    });
    return [];
  }

  const user = buildUserMessage(ctx, envelope);

  const result = await completeJson(
    SYSTEM_PROMPT,
    user,
    businessActionsOutputSchema,
    {
      turnId: `${opts.turnId}_business_actions`,
      maxTokens: 1500,
      temperature: 0.3,
      onLlmCall: opts.onLlmCall,
      purpose: LLM_PURPOSE.BUSINESS_ACTIONS,
    }
  );

  if (!result.ok) {
    agentLog("businessActionsAgent.failed", {
      turnId: opts.turnId,
      error: result.error,
    });
    return [];
  }

  const items = result.data.items;
  agentLog("businessActionsAgent.done", {
    turnId: opts.turnId,
    itemCount: items.length,
    horizons: items.map((i) => i.horizon).join(","),
    confidences: items.map((i) => i.confidence).join(","),
  });
  return items;
}
