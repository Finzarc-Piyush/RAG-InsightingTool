/**
 * Wave QL1 · Quick-lookup planner. One Mini-tier LLM call that turns a simple
 * lookup question into a schema-grounded `QueryPlanBody`.
 *
 * Inputs to the user prompt are kept slim (under ~2KB) — only the columns
 * the planner needs to pick groupBy/aggregations/filters from, plus the
 * wide-format shape block and dimension-hierarchy block already used by the
 * full planner. Repair budget is ONE retry on Zod fail; on terminal failure
 * the caller (`tryQuickAnswer`) returns null and the request falls through
 * to the full agentic loop.
 *
 * The output plan is run through the existing `normalizeAndValidateQueryPlanBody`
 * + planner-side deterministic repairs (`injectRollupExcludeFilters`,
 * `injectCompoundShapeMetricGuard`) so wide-format and hierarchy invariants
 * are honoured for free.
 */

import { z } from "zod";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { queryPlanBodySchema, type QueryPlanBody } from "../../queryPlanExecutor.js";
import {
  formatDimensionHierarchiesBlock,
  formatWideFormatShapeBlock,
  formatUserAndSessionJsonBlocks,
} from "./context.js";
import type { AgentExecutionContext } from "./types.js";
import type { DataSummary } from "../../../shared/schema.js";

// ── LLM output sanitizers (W-QL-FIX1) ──────────────────────────────────
// The Mini-tier LLM frequently produces JSON that fails the strict
// queryPlanBodySchema. These preprocessors fix the three common patterns:
//   1. `null` on optional fields (Zod .optional() accepts undefined, not null)
//   2. `limit: 0` (.positive() rejects 0)
//   3. Extra keys like `steps`, `rationale`, `measure` (.strict() rejects)
//
// Applied via z.preprocess() so the strict schema still validates the cleaned
// output — no invalid plan can escape to the executor.

const KNOWN_PLAN_KEYS = new Set([
  "groupBy", "dateAggregationPeriod", "aggregations",
  "computedAggregations", "windowAggregations",
  "dimensionFilters", "limit", "sort",
]);

const KNOWN_AGG_KEYS = new Set([
  "column", "operation", "alias", "predicate",
  "perDimension", "innerOperation",
]);

export function sanitizeLlmPlan(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const key of KNOWN_PLAN_KEYS) {
    if (!(key in obj)) continue;
    const val = obj[key];
    cleaned[key] = val === null ? undefined : val;
  }
  if (cleaned.limit === 0) delete cleaned.limit;
  if (Array.isArray(cleaned.aggregations)) {
    cleaned.aggregations = (cleaned.aggregations as unknown[]).map(
      sanitizeLlmAggregation
    );
  }
  return cleaned;
}

function sanitizeLlmAggregation(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const key of KNOWN_AGG_KEYS) {
    if (!(key in obj)) continue;
    const val = obj[key];
    cleaned[key] = val === null ? undefined : val;
  }
  return cleaned;
}

export function sanitizeLlmResponse(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (!("plan" in obj) && Array.isArray(obj.steps) && obj.steps.length > 0) {
    const first = obj.steps[0] as Record<string, unknown> | undefined;
    const args = first?.args as Record<string, unknown> | undefined;
    if (args?.plan) {
      return {
        plan: args.plan,
        questionRestated:
          obj.questionRestated ?? obj.rationale ?? "lookup query",
      };
    }
  }
  return obj;
}

/**
 * Quick-lookup planner response. Mirrors the planner's structured output
 * pattern: one `plan` object + a one-line restatement that doubles as a
 * UI header / sanity check.
 *
 * Local to this file — not exported through `server/shared/schema.ts`
 * because the client never sees it directly.
 */
export const quickLookupPlanResponseSchema = z.object({
  plan: queryPlanBodySchema,
  /** One-sentence restatement the planner derived from the question. */
  questionRestated: z.string().min(4).max(160),
});

const quickLookupPlanResponseSchemaLenient = z.preprocess(
  sanitizeLlmResponse,
  z.object({
    plan: z.preprocess(sanitizeLlmPlan, queryPlanBodySchema),
    questionRestated: z.string().min(4).max(160),
  }),
);

export type QuickLookupPlanResponse = z.infer<typeof quickLookupPlanResponseSchema>;

const MAX_COLUMNS_IN_PROMPT = 60;
const MAX_TOP_VALUES_PER_COLUMN = 8;

/**
 * Byte-stable system prompt. Lives entirely in the `system` slot so
 * prompt-cache hits across repeat fast-path turns.
 */
const QUICK_LOOKUP_SYSTEM_PROMPT = `You are a precise data-query planner. The user has asked a SIMPLE LOOKUP question on a tabular dataset (top-N, list, count, sum, average, latest, etc.). Your job is to emit ONE valid \`QueryPlanBody\` that, when executed against the dataset, produces the answer.

Constraints:
- Output JSON only. Shape: { "plan": <QueryPlanBody>, "questionRestated": "<one sentence>" }.
- Use ONLY the column names listed in the SCHEMA block. Never invent columns.
- Pick a measure column for aggregation only when the question requires aggregation. For \`list\` / \`show me\` questions, leave \`aggregations\` empty and use \`limit\` + \`sort\` instead.
- Aggregation ops: sum, mean, count, min, max, median.
- For "top N <dimension> by <metric>", emit groupBy=[<dimension>], aggregations=[{column:<metric>, operation:sum (or avg/count as the question implies), alias:<friendly_name>}], sort=[{column:<alias>, direction:desc}], limit=N.
- For "how many <thing>" or "count of X", use aggregations=[{column:<any_existing>, operation:count, alias:"count"}].
- For "latest" / "most recent", sort by the date column descending and limit 1 (or the N implied).
- Honour the DIMENSION HIERARCHIES block when present: when the user names a rollup, do NOT exclude it; otherwise the deterministic pre-pass excludes it for peer comparisons (you do not need to add the not_in filter yourself).
- Honour the DATASET SHAPE block when present (wide-format melt). On compound shape, you MAY add a dimensionFilter on the metric column if you're confident; the deterministic post-pass will add one if you don't.
- Honour the User-provided notes block when present — it's standing user instructions ("always exclude Central", "interpret 'budget' as cost_cap_eur"). Apply as dimensionFilters / column choices where the note constrains the query.
- Honour the Domain knowledge block when present — it's authored FMCG/Marico vocabulary (MAT, L12M, VND, sub-brand cannibalisation, etc.). Use it to resolve metric/dimension names the user mentions in jargon. Never invent figures from it.
- Honour the Prior investigations block when present — recent answered questions. Avoid re-emitting an identical groupBy that's already in the digest unless the user explicitly asks for a refresh.
- Keep the restatement short: "Top 10 brands by Sales", "Latest 5 orders", "Total revenue for 2024".
- Do NOT add explanatory prose, methodology, or implications — those are produced elsewhere.

If the question turns out to require analysis (why, drivers, comparison, trend), output the closest lookup-shaped plan you can; the system will fall through to the full agent loop on your behalf when needed.`;

interface RunQuickLookupPlannerOpts {
  turnId: string;
  onLlmCall?: () => void;
  /** Optional pre-stub override (tests). Production passes nothing. */
  systemPromptOverride?: string;
  /**
   * Wave QL3 · Optional intent steering hint. When QL3 retries after a
   * null result, the caller passes the detected PD1/PD3 shape here so the
   * planner LLM gets an explicit "use perDimension + this groupBy" nudge.
   * Appended to the user prompt without changing the system prompt so
   * prompt-cache hits stay maximal on the first attempt.
   */
  intentHint?: string;
}

/**
 * Emits a slim schema snapshot for the user prompt. Keeps payload under ~2KB
 * by capping columns + top-values. Includes role chips and currency tags so
 * the planner picks the right measure on currency-bearing datasets.
 */
function buildSchemaChips(summary: DataSummary): string {
  const numericSet = new Set(summary.numericColumns ?? []);
  const dateSet = new Set(summary.dateColumns ?? []);
  const cols = (summary.columns ?? []).slice(0, MAX_COLUMNS_IN_PROMPT);
  const lines: string[] = [];
  for (const c of cols) {
    const role = numericSet.has(c.name)
      ? "numeric"
      : dateSet.has(c.name)
        ? "temporal"
        : "dimension";
    const currencyTag = c.currency
      ? ` · ${c.currency.isoCode} (${c.currency.symbol})`
      : "";
    let topValuesLine = "";
    if (role === "dimension" && Array.isArray(c.topValues) && c.topValues.length > 0) {
      const vals = c.topValues
        .slice(0, MAX_TOP_VALUES_PER_COLUMN)
        .map((tv) => String(tv.value).slice(0, 40))
        .join(" | ");
      topValuesLine = ` · top values: ${vals}`;
    }
    lines.push(`- ${c.name} (${role}${currencyTag})${topValuesLine}`);
  }
  if ((summary.columns?.length ?? 0) > MAX_COLUMNS_IN_PROMPT) {
    lines.push(
      `... (${(summary.columns?.length ?? 0) - MAX_COLUMNS_IN_PROMPT} more columns omitted; ask if you need them)`
    );
  }
  return lines.join("\n");
}

function buildUserPrompt(ctx: AgentExecutionContext): string {
  const schemaBlock = buildSchemaChips(ctx.summary);
  const wideFormatBlock = formatWideFormatShapeBlock(ctx.summary);
  const hierarchiesBlock = formatDimensionHierarchiesBlock(ctx);
  const activeFilterBlock =
    ctx.chatDocument?.activeFilter?.conditions?.length
      ? `\n\nACTIVE FILTER (user-defined; data is pre-filtered before your query runs — do NOT replicate these as dimensionFilters):\n${ctx.chatDocument.activeFilter.conditions
          .slice(0, 12)
          .map((c) => `  - ${c.column} ${c.kind}`)
          .join("\n")}`
      : "";

  // Wave B1 · Bring the same first-class context the full planner sees so
  // QL1 doesn't return a "perfect" lookup that quietly ignores user
  // intent / domain vocabulary. Pre-B1 QL1's user prompt was just
  // schema + wide-format + hierarchies + active filter. It was BLIND to:
  //   - the user's free-text "additional context" notes (ctx.permanentContext)
  //   - the FMCG/Marico domain knowledge packs (ctx.domainContext)
  //   - prior-turn investigation digests (ctx.sessionAnalysisContext.sessionKnowledge.priorInvestigations)
  //   - the user's stated intent / interpreted constraints (ctx.sessionAnalysisContext.userIntent)
  //
  // Concrete failures this closes:
  //   - "always exclude Central region from regional rollups" lives in
  //     permanentContext → QL1 had no way to honor it
  //   - "what's our top product" in a session where the user already
  //     asked "show me brand-level Marico" — QL1 doesn't see the prior
  //     and re-asks the SKU-level breakdown
  //   - VND/MAT/L12M terminology in the domain packs — QL1 couldn't
  //     resolve those metric names without re-asking
  //
  // Caps are tighter than the full planner's (this is the MINI-tier
  // path; we want the prompt under ~5KB even with full context). The
  // helper itself reads `ctx.permanentContext`, `ctx.domainContext`, and
  // the prior-investigations digest from `ctx.sessionAnalysisContext`.
  const userSessionBlocks = formatUserAndSessionJsonBlocks(ctx, {
    maxUserChars: 800,
    maxJsonChars: 1500,
    maxDomainChars: 2000,
  });

  return `USER QUESTION:
${ctx.question}

SCHEMA (column · role · top values for dimensions):
${schemaBlock}${wideFormatBlock ? `\n${wideFormatBlock}` : ""}${
    hierarchiesBlock ? `\n${hierarchiesBlock}` : ""
  }${activeFilterBlock}${userSessionBlocks}

Return JSON: { "plan": <QueryPlanBody>, "questionRestated": "<one sentence>" }.`;
}

/**
 * One Mini-tier LLM call. `completeJson` owns the 3-attempt repair loop
 * (vanilla → error-fed-back → minimal-instruction reset), so we don't add an
 * outer retry. Returns null on terminal failure so the caller can fall
 * through to the full agent loop. NEVER throws.
 *
 * Logs the failure reason to stdout so production grep can find rapidly-
 * failing planner shapes (e.g. a new dataset format that's tripping the
 * column-allowlist check).
 */
export async function runQuickLookupPlanner(
  ctx: AgentExecutionContext,
  opts: RunQuickLookupPlannerOpts
): Promise<QuickLookupPlanResponse | null> {
  const system = opts.systemPromptOverride ?? QUICK_LOOKUP_SYSTEM_PROMPT;
  const baseUser = buildUserPrompt(ctx);
  const user = opts.intentHint
    ? `${baseUser}\n\nDETECTED INTENT (deterministic regex on the question — honour unless the schema makes it impossible):\n${opts.intentHint}`
    : baseUser;

  try {
    const res = await completeJson(
      system,
      user,
      quickLookupPlanResponseSchemaLenient,
      {
        purpose: LLM_PURPOSE.QUICK_LOOKUP_PLANNER,
        turnId: opts.turnId,
        onLlmCall: opts.onLlmCall,
        // Keep output small: a single plan + a sentence. 1024 tokens is
        // ~6x what a clean response needs but cheap insurance for verbose
        // planner output.
        maxTokens: 1024,
        // Slight temperature for natural restatements but still
        // structurally deterministic for the plan body.
        temperature: 0.1,
      }
    );
    if (res.ok) return res.data as QuickLookupPlanResponse;
    console.warn(`[quickAnswerPlanner] terminal Zod fail: ${res.error.slice(0, 400)}`);
    return null;
  } catch (err) {
    console.warn(
      `[quickAnswerPlanner] threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
