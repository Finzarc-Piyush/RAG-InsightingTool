/**
 * Wave W3 · hypothesisPlanner
 *
 * Runs before the main planner. Given the user question, schema summary,
 * and session context, generates 3–5 testable hypotheses that bound the
 * upcoming investigation. Writes them to the blackboard and returns a
 * formatted block for injection into the planner prompt.
 */

import { z } from "zod";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import { agentLog } from "./agentLogger.js";
import {
  addHypothesis,
  formatForPlanner,
  type AnalyticalBlackboard,
} from "./analyticalBlackboard.js";
import type { AgentExecutionContext } from "./types.js";

const hypothesisItemSchema = z.object({
  text: z.string(),
  targetColumn: z.string().optional(),
});

const hypothesisOutputSchema = z.object({
  hypotheses: z.array(hypothesisItemSchema).min(1).max(6),
});

type HypothesisOutput = z.infer<typeof hypothesisOutputSchema>;

/** Cap on the FMCG/Marico domain context block injected into the user prompt.
 * WTL2 · 2_500 → 4_000 to match the merged W39 path; helps domain-aware
 * hypothesis quality. Packs are background, not numeric evidence. */
const HYPOTHESIS_DOMAIN_CONTEXT_CAP = 4000;

/** DB1 · cap on columns enumerated with metadata in the user block. */
const HYPOTHESIS_COLUMN_CAP = 60;
const HYPOTHESIS_EXAMPLES_PER_COL = 6;

/**
 * DB1 · Build a metadata-rich column line for the hypothesis prompt.
 *
 * Pre-DB1 the planner only saw `name (type)` per column — the LLM had no way
 * to discriminate id-like columns from real dimensions, missed candidate
 * drivers, and couldn't ground hypotheses in actual value distributions.
 * `dataSummary.columns` already carries `topValues` (top categorical values
 * by frequency, capped at 48) and `sampleValues` (first non-null values);
 * surfacing those gives the LLM cardinality and shape signals at zero
 * additional cost.
 */
function formatColumnMeta(
  col: AgentExecutionContext["summary"]["columns"][number],
  numericSet: ReadonlySet<string>,
  dateSet: ReadonlySet<string>
): string {
  const name = col.name;
  const type = col.type;
  const isNumeric = numericSet.has(name) || type === "number";
  const isDate = dateSet.has(name) || type === "date";

  if (isDate) {
    const samples = Array.isArray(col.sampleValues)
      ? col.sampleValues.filter((v) => v != null).map((v) => String(v))
      : [];
    if (samples.length === 0) return `${name} (date)`;
    const first = samples[0];
    const last = samples[samples.length - 1];
    return first === last
      ? `${name} (date, e.g. ${first})`
      : `${name} (date, range≈${first}..${last})`;
  }

  if (isNumeric) {
    const nums = Array.isArray(col.sampleValues)
      ? col.sampleValues
          .map((v) => (typeof v === "number" ? v : Number(v)))
          .filter((n) => Number.isFinite(n))
      : [];
    if (nums.length === 0) return `${name} (number)`;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    return `${name} (number, sample-range≈[${min}..${max}])`;
  }

  // Categorical / string column
  const topValues = Array.isArray(col.topValues) ? col.topValues : [];
  if (topValues.length === 0) {
    return `${name} (${type})`;
  }
  const examples = topValues
    .slice(0, HYPOTHESIS_EXAMPLES_PER_COL)
    .map((t) => String(t.value).trim())
    .filter(Boolean);
  // topValues caps at 48; use ≥N when saturated as a coarse cardinality lower bound.
  const cardinalityHint =
    topValues.length >= 48 ? "distinct≥48" : `distinct≈${topValues.length}`;
  return `${name} (${type}, ${cardinalityHint}, examples=[${examples.join("|")}])`;
}

function buildUserBlock(ctx: AgentExecutionContext): string {
  const numericSet = new Set(ctx.summary.numericColumns ?? []);
  const dateSet = new Set(ctx.summary.dateColumns ?? []);
  const colsForPrompt = ctx.summary.columns.slice(0, HYPOTHESIS_COLUMN_CAP);
  const cols = colsForPrompt
    .map((c) => formatColumnMeta(c, numericSet, dateSet))
    .join("\n  - ");
  const truncated = ctx.summary.columns.length > HYPOTHESIS_COLUMN_CAP
    ? ` (showing first ${HYPOTHESIS_COLUMN_CAP} of ${ctx.summary.columns.length})`
    : "";
  const sacSnippet = ctx.sessionAnalysisContext?.sessionContext
    ? ctx.sessionAnalysisContext.sessionContext.slice(0, 800)
    : "";
  const briefSnippet = ctx.analysisBrief
    ? `OutcomeMetric: ${ctx.analysisBrief.outcomeMetricColumn ?? "?"} | Dimensions: ${(ctx.analysisBrief.segmentationDimensions ?? []).join(", ")}`
    : "";
  const domainSnippet = ctx.domainContext?.trim()
    ? `FMCG / MARICO DOMAIN CONTEXT (background only — never numeric evidence; cite pack id when used):\n${ctx.domainContext.trim().slice(0, HYPOTHESIS_DOMAIN_CONTEXT_CAP)}`
    : "";
  return [
    `Question: ${ctx.question}`,
    `Columns${truncated}:\n  - ${cols}`,
    briefSnippet ? `Analysis brief: ${briefSnippet}` : "",
    sacSnippet ? `Session context (excerpt): ${sacSnippet}` : "",
    domainSnippet,
  ]
    .filter(Boolean)
    .join("\n");
}

// DB1 · exposed for tests so the metadata-rich column formatting is pinned.
export const __test__ = { formatColumnMeta, buildUserBlock };

/**
 * Generate 3–5 testable hypotheses for the given question and write them to
 * the blackboard. Returns true on success; false if the LLM call failed
 * (caller continues without hypotheses — planner still works).
 */
export async function generateHypotheses(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string,
  onLlmCall: () => void
): Promise<boolean> {
  // W4.2 · ANALYST_PREAMBLE prefix → cache eligibility (>1024 tokens). System
  // is purely static; the per-turn dataset/question/brief lives in user via
  // buildUserBlock(ctx).
  const system = `${ANALYST_PREAMBLE}You are an investigation planner for a data analysis assistant.
Given a user question and dataset schema, generate 3 to 5 concise testable hypotheses
that would, if confirmed or refuted by the data, fully explain the user's question.

Rules:
- Each hypothesis MUST be falsifiable by querying the data (a simple aggregation, breakdown, or correlation).
- Focus on specific dimensions, metrics, or time windows visible in the schema.
- Do not repeat the question — each hypothesis should be a distinct explanation candidate.
- Keep each hypothesis under 25 words.
- If the question is purely operational (add a column, rename a sheet, etc.), output a single
  hypothesis: "User request is a data operation with no analytical hypothesis needed."
- When the FMCG / MARICO DOMAIN CONTEXT block is present, prefer hypotheses that test domain-relevant explanations (category seasonality, channel-mix shifts, commodity/input-cost lag, premiumisation, sub-brand cannibalisation, distribution gains/losses) over generic statistical fishing — but only when the data could plausibly answer them. Do not invent metric names; use only columns from the supplied schema.
- WGR5 — For trend / growth / "fastest growing" / "biggest decliner" questions, candidate hypotheses must include period-on-period growth shifts (YoY decay, QoQ acceleration, MoM swings) — not only level differences between segments. Test growth-rate explanations across all available year-pairs, not just the first one.
- WSE5 — Trend questions on multi-year monthly/quarterly data must also include candidate hypotheses about recurring within-year SEASONALITY (Q4 holiday peak, Q1 summer peak, monsoon-driven rural demand, Diwali festive Q3, back-to-school) — these are distinct from growth hypotheses. Seasonality hypotheses are testable: "Sales peak in the same calendar quarter every year" / "Volume is consistently lower in monsoon months". Generate at least one such hypothesis when the dataset has ≥2 years × monthly or quarterly cadence.
- DB1 — Each Columns line carries a metadata hint (\`distinct≈N\` or \`distinct≥N\` for categoricals, \`sample-range\` for numerics, \`range\` for dates). Use those hints to pick targetColumn: prefer dimension-like columns (distinct between 2 and ~60) over id-like columns (\`distinct≥48\` with no clear semantic name). Numeric columns with very narrow ranges, monotonic dates, or columns that look like row identifiers are unlikely to drive an outcome.
- Output JSON: {"hypotheses": [{"text": string, "targetColumn"?: string}]}`;

  const user = buildUserBlock(ctx);
  const result = await completeJson(system, user, hypothesisOutputSchema, {
    // WTL2 · 512 → 1200. Lets the model emit more candidate hypotheses
    // when the dataset / domain context invites them; was clipping mid-list.
    maxTokens: 1200,
    temperature: 0.3,
    turnId,
    onLlmCall,
    purpose: LLM_PURPOSE.HYPOTHESIS,
  });

  if (!result.ok) {
    agentLog("hypothesisPlanner.failed", { turnId, error: result.error });
    return false;
  }

  const { hypotheses } = result.data as HypothesisOutput;
  for (const h of hypotheses) {
    addHypothesis(blackboard, h.text, { targetColumn: h.targetColumn });
  }

  agentLog("hypothesisPlanner.done", { turnId, count: hypotheses.length });
  return true;
}

