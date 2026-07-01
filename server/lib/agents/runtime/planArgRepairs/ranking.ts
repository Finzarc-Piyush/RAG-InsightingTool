/**
 * ============================================================================
 * planArgRepairs/ranking.ts — ranking / leaderboard / entity-max intent family
 * ============================================================================
 * Extracted verbatim from planArgRepairs.ts (Wave R31, behaviour-preserving
 * re-export split). See planArgRepairs.ts for the surrounding context.
 *
 * Ranking / leaderboard / entity-max question intent extraction +
 * deterministic plan-shape enforcement.
 *
 * Questions like "who are the top 300 salespeople" / "who has the maximum
 * leaves this month" / "who has the highest absenteeism" / "list the products"
 * can produce wrong or truncated answers if the planner doesn't emit a clean
 * groupBy + sort + limit shape. The helpers below recognise the intent from
 * the question wording and enforce that shape deterministically so the LLM
 * can't drop it on the floor.
 *
 * This family is LOW-COUPLING: it depends only on external modules
 * (`findMatchingColumn`, and `TREND_INTENT_RE` from queryIntentAuthority for the
 * growth-question exclusion) and type-only references to `PlanStep` /
 * `DataSummary`. It does NOT reference any runtime value from planArgRepairs.ts
 * and queryIntentAuthority does not import back here, so it carries no cycle.
 */
import type { PlanStep } from "../types.js";
import type { DataSummary } from "../../../../shared/schema.js";
import { findMatchingColumn } from "../../utils/columnMatcher.js";
import { TREND_INTENT_RE } from "../queryIntentAuthority.js";

/** Shape of a user-question ranking intent, when one is recognised. */
export type RankingIntentKind = "topN" | "extremum" | "entityList";

export interface RankingIntent {
  kind: RankingIntentKind;
  /** Number of rows to return (the user's N for `topN`, `EXTREMUM_LEADERBOARD_N` for `extremum`, undefined for `entityList`). */
  n?: number;
  /** Sort direction implied by the question wording (desc by default). */
  direction: "desc" | "asc";
  /** Aggregation hint for `extremum` ("max"/"min"). Not used for `topN`/`entityList`. */
  agg?: "max" | "min";
  /** Resolved entity (categorical) column from the schema. */
  entityColumn: string;
  /** Resolved metric (numeric) column from the schema. May be undefined for `entityList`. */
  metricColumn?: string;
  /** Verbatim phrase that triggered the intent (for logging / tests). */
  matchedPhrase: string;
}

/**
 * How many rows an extremum / single-winner question ("who has the highest X",
 * "which channel shows the most Y") should return. A superlative answer is more
 * trustworthy and decision-grade when the narrator can name the winner AND cite
 * the surrounding leaderboard — a bare `LIMIT 1` leaves the synthesis step with
 * a single row, so it (honestly) hedges "no other result is present, a ranking
 * cannot be completed". 15 stays well under the synthesis surfacing cap
 * (QUERY_RESULTS_MAX_ROWS_PER_STEP = 50 in buildSynthesisContext.ts), so every
 * row reaches the narrator.
 */
export const EXTREMUM_LEADERBOARD_N = 15;

const TOP_N_RE =
  /\b(top|best|leading)\s+(\d{1,7})\b/i;
const BOTTOM_N_RE =
  /\b(bottom|worst)\s+(\d{1,7})\b/i;
const EXTREMUM_MAX_RE =
  /\bwho\s+(?:has|have|had|is|are)\s+(?:the\s+)?(highest|maximum|max|most|largest|greatest|biggest)\b/i;
const EXTREMUM_MIN_RE =
  /\bwho\s+(?:has|have|had|is|are)\s+(?:the\s+)?(lowest|minimum|min|least|smallest|fewest|worst)\b/i;
const ENTITY_LIST_RE =
  /\b(who\s+are|list\s+(?:all\s+)?(?:the\s+)?|show\s+me\s+(?:all\s+)?(?:the\s+)?)\b/i;

/** Tokens we strip / ignore when extracting candidate nouns from the question. */
const STOPWORDS = new Set([
  "a","an","the","of","in","on","at","by","for","with","from","to","is","are","was","were","be","been",
  "and","or","but","not","this","that","these","those","my","your","our","their","its","it","they",
  "we","you","i","me","he","she","him","her","his","hers","theirs","ours","yours","myself","yourself",
  "what","which","who","whom","whose","when","where","why","how","do","does","did","done","can","could",
  "would","should","may","might","will","shall","have","has","had","having","top","bottom","best","worst",
  "highest","lowest","maximum","minimum","max","min","most","least","largest","smallest","greatest","biggest",
  "fewest","leading","ranked","ranking","sorted","sort","by","over","across","this","last","next","each",
  "all","every","any","some","many","few","such","than","then","also","just","very","really","quite",
  "only","even","still","ever","never","always","often","sometimes","rarely","one","two","three","four","five",
  "list","show","me","please","tell","find","get","give","display","return","print","output","report",
]);

/**
 * Extract candidate nouns from the user question for entity-column matching.
 * Strips numbers and stop-words; preserves order so the most prominent noun
 * wins ties. Always returns lowercased tokens.
 */
function questionNouns(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Resolve an entity (categorical) column from the question. We prefer columns
 * whose name shares a noun with the question. When `allowFallback` is true
 * (extremum / topN intents — "who has highest X" / "top 50") and no noun
 * matches, we fall back to the first plausible categorical column so the
 * planner can still emit a per-entity groupBy. For `entityList` intent we
 * never fall back: the user must name the entity ("list the products"),
 * otherwise the question is ambiguous.
 */
function resolveEntityColumn(
  question: string,
  summary: DataSummary,
  allowFallback: boolean
): string | null {
  const numericSet = new Set(summary.numericColumns ?? []);
  const dateSet = new Set(summary.dateColumns ?? []);
  const wideValueCol = summary.wideFormatTransform?.valueColumn;
  const wideMetricCol = summary.wideFormatTransform?.metricColumn;
  const widePeriodCol = summary.wideFormatTransform?.periodColumn;
  const widePeriodIsoCol = summary.wideFormatTransform?.periodIsoColumn;
  const isCategorical = (name: string): boolean => {
    if (numericSet.has(name)) return false;
    if (dateSet.has(name)) return false;
    if (wideValueCol && name === wideValueCol) return false;
    if (wideMetricCol && name === wideMetricCol) return false;
    if (widePeriodCol && name === widePeriodCol) return false;
    if (widePeriodIsoCol && name === widePeriodIsoCol) return false;
    return true;
  };
  const categorical = (summary.columns ?? [])
    .map((c) => c.name)
    .filter((n) => typeof n === "string" && isCategorical(n));
  if (categorical.length === 0) return null;

  // First pass: prefer a column whose name matches a noun in the question.
  const nouns = questionNouns(question);
  for (const noun of nouns) {
    const match = findMatchingColumn(noun, categorical, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Second pass: explicit plural-stripped lookups for common entity shapes
  // ("salespeople" → "salesperson", "employees" → "employee").
  for (const noun of nouns) {
    if (noun.length < 5) continue;
    let stem: string | null = null;
    if (noun.endsWith("people")) stem = noun.replace(/people$/, "person");
    else if (noun.endsWith("ies")) stem = noun.slice(0, -3) + "y";
    else if (noun.endsWith("es")) stem = noun.slice(0, -2);
    else if (noun.endsWith("s")) stem = noun.slice(0, -1);
    if (!stem) continue;
    const match = findMatchingColumn(stem, categorical, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Third pass: nothing in the question maps to a column.
  //  - For entityList intent ("list the X"), the user MUST have named X —
  //    return null and let the LLM handle ambiguity.
  //  - For extremum / topN intent ("who has the highest X" / "top 5 by X"),
  //    "who" / the bare ranking phrase is an implicit reference to the
  //    dataset's primary entity; default to the first categorical column
  //    so the planner can still emit per-entity grouping.
  if (allowFallback && categorical.length > 0) {
    return categorical[0]!;
  }
  return null;
}

/**
 * Resolve a metric (numeric) column from the question. Looks for "by <noun>"
 * / "of <noun>" / "<noun>" patterns matching a numeric column. Returns null
 * when no numeric column is named — caller can leave the LLM's choice intact
 * (or, for the wide-format `valueColumn`, plug it in as the canonical metric).
 */
function resolveMetricColumn(
  question: string,
  summary: DataSummary
): string | null {
  const numericCols = summary.numericColumns ?? [];
  if (numericCols.length === 0) return null;
  const wideValueCol = summary.wideFormatTransform?.valueColumn;
  // Strip the wide-format hidden _rowCount/_numericCount surrogates.
  const candidates = numericCols.filter((c) => !c.startsWith("_"));
  if (candidates.length === 0) return null;

  // "by <metric>" / "of <metric>" / "for <metric>" patterns are strongest.
  const byMatch = question.match(
    /\b(?:by|of|for|in|on)\s+([a-zA-Z][a-zA-Z0-9_\s-]{1,40})/i
  );
  if (byMatch) {
    const phrase = byMatch[1]!.trim();
    const match = findMatchingColumn(phrase, candidates, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Fall back to scanning question nouns against numeric columns.
  const nouns = questionNouns(question);
  for (const noun of nouns) {
    const match = findMatchingColumn(noun, candidates, {
      wideFormatTransform: summary.wideFormatTransform,
    });
    if (match) return match;
  }
  // Wide-format datasets keep the metric in `valueColumn`; if the question
  // didn't name another numeric column, the wide value column is the right
  // default.
  if (wideValueCol && candidates.includes(wideValueCol)) return wideValueCol;
  return null;
}

/**
 * Inspect the user question and return a structured ranking intent if the
 * phrasing matches one of the supported shapes. Returns null when no shape
 * fires — non-ranking analytical questions (trends, drivers, comparisons)
 * pass through untouched.
 */
export function extractRankingIntent(
  question: string | undefined,
  summary: DataSummary
): RankingIntent | null {
  const q = (question ?? "").trim();
  if (!q) return null;

  // Order matters: extremum and topN are more specific than entityList
  // (which would otherwise eat "list the top 10 products"). Bottom/worst
  // patterns are checked before extremum-min so "bottom 5" beats "lowest"
  // when both could match.
  const topMatch = TOP_N_RE.exec(q);
  const bottomMatch = BOTTOM_N_RE.exec(q);
  const extremumMaxMatch = EXTREMUM_MAX_RE.exec(q);
  const extremumMinMatch = EXTREMUM_MIN_RE.exec(q);
  const entityListMatch = ENTITY_LIST_RE.exec(q);

  let kind: RankingIntentKind | null = null;
  let n: number | undefined;
  let direction: "desc" | "asc" = "desc";
  let agg: "max" | "min" | undefined;
  let matchedPhrase = "";

  if (topMatch) {
    kind = "topN";
    n = Number(topMatch[2]);
    direction = "desc";
    matchedPhrase = topMatch[0];
  } else if (bottomMatch) {
    kind = "topN";
    n = Number(bottomMatch[2]);
    direction = "asc";
    matchedPhrase = bottomMatch[0];
  } else if (extremumMaxMatch) {
    kind = "extremum";
    // Return a leaderboard, not a single argmax row — see EXTREMUM_LEADERBOARD_N.
    n = EXTREMUM_LEADERBOARD_N;
    direction = "desc";
    agg = "max";
    matchedPhrase = extremumMaxMatch[0];
  } else if (extremumMinMatch) {
    kind = "extremum";
    // Return a leaderboard, not a single argmax row — see EXTREMUM_LEADERBOARD_N.
    n = EXTREMUM_LEADERBOARD_N;
    direction = "asc";
    agg = "min";
    matchedPhrase = extremumMinMatch[0];
  } else if (entityListMatch) {
    kind = "entityList";
    direction = "desc";
    matchedPhrase = entityListMatch[0];
  }

  if (!kind) return null;
  if (n !== undefined && (!Number.isFinite(n) || n < 1)) return null;

  // Fallback to "first categorical column" is only safe for `extremum`
  // intent — there "who" already implies the dataset's primary entity, so
  // a default lookup won't surprise the user. For `topN` ("top 10 rocket
  // scientists") and `entityList` ("list the rocket scientists") the user
  // explicitly named an entity; failing to find one means we should bail
  // rather than silently substitute Salesperson.
  const allowEntityFallback = kind === "extremum";
  const entityColumn = resolveEntityColumn(q, summary, allowEntityFallback);
  if (!entityColumn) return null;

  const metricColumn =
    kind === "entityList" ? undefined : resolveMetricColumn(q, summary) ?? undefined;
  if (kind !== "entityList" && !metricColumn) {
    // No numeric column named, no wide-format value column to default to —
    // we can't responsibly emit groupBy+sort+limit without a metric. Leave
    // intent null so the LLM's plan stands; the planner prompt block still
    // nudges the LLM toward the right shape.
    return null;
  }

  return {
    kind,
    n,
    direction,
    agg,
    entityColumn,
    metricColumn,
    matchedPhrase,
  };
}

/** Tools whose plan-shape we deterministically enforce for ranking intent. */
const RANKING_TOOLS = new Set(["execute_query_plan", "breakdown_ranking"]);

export interface EnforceRankingResult {
  /** True when at least one repair fired on the step. */
  changed: boolean;
  /** Short summary of the repair (for logging). */
  reason?: string;
}

/**
 * Coerce `args.aggregation` for breakdown_ranking from the intent. We only
 * touch the args when the planner left them inconsistent with the question.
 */
function applyToBreakdownRanking(
  step: PlanStep,
  intent: RankingIntent
): EnforceRankingResult {
  const args = (step.args ?? {}) as Record<string, unknown>;
  const before = JSON.stringify(args);

  // Force entity column when the planner picked something that doesn't
  // match the question's noun (LLMs frequently fall back to the first
  // categorical column).
  if (
    typeof args.breakdownColumn !== "string" ||
    args.breakdownColumn !== intent.entityColumn
  ) {
    args.breakdownColumn = intent.entityColumn;
  }
  if (intent.metricColumn) {
    if (
      typeof args.metricColumn !== "string" ||
      args.metricColumn !== intent.metricColumn
    ) {
      args.metricColumn = intent.metricColumn;
    }
  }
  if (intent.kind === "topN" && intent.n !== undefined) {
    const cur = typeof args.topN === "number" ? args.topN : 0;
    if (cur < intent.n) args.topN = intent.n;
  } else if (intent.kind === "extremum") {
    // Leaderboard, not a single winner: keep whatever (larger) topN the planner
    // may have chosen, but never let it collapse to one row. `rankBy` composite
    // expressions are left untouched, so ratio/composite rankings are safe.
    const cur = typeof args.topN === "number" ? args.topN : 0;
    if (cur < EXTREMUM_LEADERBOARD_N) args.topN = EXTREMUM_LEADERBOARD_N;
    if (intent.agg === "max") {
      // Default aggregation already "sum"; for "who has highest", sum is
      // appropriate when row-per-entity isn't guaranteed and "max" is
      // appropriate when it is. Leave aggregation alone — the planner /
      // user can refine if needed; sort direction (handled by tool) is
      // what really matters.
    }
  }
  args.direction = intent.direction;
  step.args = args;
  return {
    changed: JSON.stringify(args) !== before,
    reason: `breakdown_ranking shape coerced to ${intent.kind} on ${intent.entityColumn}${intent.metricColumn ? ` × ${intent.metricColumn}` : ""}`,
  };
}

/**
 * Coerce execute_query_plan args so groupBy includes the entity column,
 * sort is set on the metric agg with the right direction, and limit is set
 * to the intent's N. For `entityList` intent we leave aggregations empty
 * and skip `limit`.
 */
function applyToExecuteQueryPlan(
  step: PlanStep,
  intent: RankingIntent
): EnforceRankingResult {
  const args = (step.args ?? {}) as Record<string, unknown>;
  let plan = args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") {
    plan = {};
    args.plan = plan;
  }
  const before = JSON.stringify(plan);

  // Prepend the entity column to groupBy (so grouping is per-entity, not lost
  // as a tail dimension). Reused by the entityList and simple-metric branches;
  // deliberately NOT applied in the preserve-computed branch, which trusts the
  // groupBy the planner built for its computed ranking.
  const entityFirstGroupBy = (): string[] => {
    const rest = Array.isArray(plan!.groupBy)
      ? (plan!.groupBy as unknown[]).filter(
          (g): g is string => typeof g === "string" && g !== intent.entityColumn
        )
      : [];
    return [intent.entityColumn, ...rest];
  };

  // Raise plan.limit to the intent's N when the planner truncated the ranking
  // below it — but never REDUCE a deliberately larger limit and never touch an
  // absent/0 (unlimited) limit. This is the single-row → leaderboard lift.
  const liftLimit = (): void => {
    if (intent.n === undefined) return;
    const cur = typeof plan!.limit === "number" ? plan!.limit : undefined;
    if (cur !== undefined && cur > 0 && cur < intent.n) plan!.limit = intent.n;
  };

  if (intent.kind === "entityList") {
    // Listing intent: distinct entities only. Strip aggregations and any
    // numeric sort/limit so the planner doesn't accidentally rank.
    plan.groupBy = entityFirstGroupBy();
    plan.aggregations = [];
    delete plan.sort;
    delete plan.limit;
    args.plan = plan;
    step.args = args;
    return {
      changed: JSON.stringify(plan) !== before,
      reason: `execute_query_plan coerced to entityList on ${intent.entityColumn}`,
    };
  }

  // COMPUTED RANKING GUARD: when the planner deliberately built a computed
  // metric (a ratio like GST/Net Sales, a gap like MRP−NR, a share) it lives in
  // plan.computedAggregations with plan.sort on the computed alias. Rewriting
  // aggregations/sort here to a raw single-column sum would rank by the WRONG
  // measure — a worse bug than the single-row one we're fixing. So preserve the
  // shape verbatim and only lift the row cap off the leaderboard.
  const hasComputed =
    Array.isArray(plan.computedAggregations) &&
    (plan.computedAggregations as unknown[]).length > 0;
  if (hasComputed) {
    liftLimit();
    args.plan = plan;
    step.args = args;
    return {
      changed: JSON.stringify(plan) !== before,
      reason: `execute_query_plan preserved computed ${intent.kind} ranking on ${intent.entityColumn} (limit → ${plan.limit ?? "unlimited"})`,
    };
  }

  if (intent.metricColumn) {
    // Simple-metric ranking: the LLM frequently gets the entity column / metric
    // / limit wrong, so enforce the leaderboard shape deterministically.
    plan.groupBy = entityFirstGroupBy();
    // Ensure an aggregation on the metric column exists. Choose `max` for
    // extremum-style questions where the planner explicitly indicated max,
    // otherwise prefer `sum` (FMCG pragmatism — totals dominate).
    const aggs = Array.isArray(plan.aggregations)
      ? (plan.aggregations as Array<Record<string, unknown>>)
      : [];
    const wantOp =
      intent.kind === "extremum"
        ? intent.agg === "min"
          ? "min"
          : "max"
        : "sum";
    let aggOnMetric = aggs.find(
      (a) => typeof a?.column === "string" && a.column === intent.metricColumn
    );
    if (!aggOnMetric) {
      aggOnMetric = { column: intent.metricColumn, operation: wantOp };
      aggs.push(aggOnMetric);
    } else if (typeof aggOnMetric.operation !== "string") {
      aggOnMetric.operation = wantOp;
    }
    plan.aggregations = aggs;

    const sortKey = `${intent.metricColumn}_${aggOnMetric.operation}`;
    plan.sort = [{ column: sortKey, direction: intent.direction }];
    plan.limit = intent.n;
  }

  args.plan = plan;
  step.args = args;
  return {
    changed: JSON.stringify(plan) !== before,
    reason: `execute_query_plan coerced to ${intent.kind} on ${intent.entityColumn}${intent.metricColumn ? ` × ${intent.metricColumn}` : ""}`,
  };
}

/**
 * Apply ranking-intent repairs to a step. Wired in `planner.ts` immediately
 * after `injectRollupExcludeFilters` so it runs after column resolution but
 * before zod validation. No-op for tools outside `RANKING_TOOLS` and for
 * steps whose tool the LLM picked correctly but with mismatched args.
 *
 * NOTE: this purposefully overrides the LLM's choice of breakdown column /
 * metric column / topN when they conflict with the deterministic intent —
 * the LLM gets the question wrong here often enough that the deterministic
 * extractor is the right source of truth. The LLM still chooses the tool
 * (breakdown_ranking vs execute_query_plan) and any dimensionFilters /
 * temporal facets layered on top.
 */
export function enforceRankingPlanShape(
  step: PlanStep,
  intent: RankingIntent | null
): EnforceRankingResult {
  if (!intent) return { changed: false };
  if (!RANKING_TOOLS.has(step.tool)) return { changed: false };
  if (step.tool === "breakdown_ranking") {
    return applyToBreakdownRanking(step, intent);
  }
  if (step.tool === "execute_query_plan") {
    return applyToExecuteQueryPlan(step, intent);
  }
  return { changed: false };
}

/**
 * Broad superlative detector for the single-row → leaderboard FLOOR (Part 3).
 * Wider than EXTREMUM_MAX_RE / EXTREMUM_MIN_RE (matches "which/what X …" too,
 * not just "who has …") — and that is SAFE here precisely because this floor
 * only ever LIFTS a row cap. It never rewrites the metric / sort / groupBy /
 * computedAggregations, so a false positive is harmless: it just returns a few
 * more rows of whatever the planner already computed. That safety is why we can
 * afford a broad regex here, where `enforceRankingPlanShape` (which clobbers the
 * plan shape) must stay narrow.
 */
export const SUPERLATIVE_FLOOR_RE =
  /\b(?:who|which|what)\b[\s\S]{0,80}?\b(?:highest|largest|greatest|biggest|widest|most|maximum|max|top|lowest|smallest|least|fewest|narrowest|minimum|min|bottom|worst)\b/i;

/**
 * Deterministic backstop for LLM-emitted single-row rankings. When the planner
 * itself (not the ranking-intent repair) shapes a superlative question as a
 * grouped ranking capped at `LIMIT 1` / `topN 1` — the exact failure behind
 * "no other <entity> result is present in the supplied observations, so a
 * ranking cannot be completed" — lift the cap to a leaderboard so the narrator
 * can name the winner AND cite the surrounding field.
 *
 * Wired in planner.ts immediately AFTER `enforceRankingPlanShape`. This is
 * PLAN-SHAPE enforcement (how many rows a ranking step returns), NOT
 * question-intent / depth-budget classification — it computes no intent class
 * and no depthBudget (those live in queryIntentAuthority). It only ever touches
 * the row cap; the metric, sort, groupBy and computedAggregations are left
 * exactly as the planner built them.
 */
export function liftSingleRowRankingFloor(
  step: PlanStep,
  question: string | undefined
): EnforceRankingResult {
  if (!RANKING_TOOLS.has(step.tool)) return { changed: false };
  const q = (question ?? "").trim();
  if (!q) return { changed: false };
  // Growth / trend questions route to compute_growth (WGR5); don't nudge their
  // row shape even if a superlative word appears ("which brand grew the most").
  if (TREND_INTENT_RE.test(q)) return { changed: false };
  if (!SUPERLATIVE_FLOOR_RE.test(q)) return { changed: false };

  const args = (step.args ?? {}) as Record<string, unknown>;

  if (step.tool === "breakdown_ranking") {
    const cur = typeof args.topN === "number" ? args.topN : undefined;
    if (cur !== undefined && cur > 0 && cur < EXTREMUM_LEADERBOARD_N) {
      args.topN = EXTREMUM_LEADERBOARD_N;
      step.args = args;
      return {
        changed: true,
        reason: `breakdown_ranking single-row floor: topN ${cur} → ${EXTREMUM_LEADERBOARD_N}`,
      };
    }
    return { changed: false };
  }

  // execute_query_plan: only lift when this is genuinely a grouped ranking
  // (per-entity groupBy + a sort) truncated below the leaderboard size. A bare
  // scalar/limit query without groupBy+sort is left alone.
  const plan = args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return { changed: false };
  const groupByNonEmpty =
    Array.isArray(plan.groupBy) && (plan.groupBy as unknown[]).length > 0;
  const sortNonEmpty =
    Array.isArray(plan.sort) && (plan.sort as unknown[]).length > 0;
  const cur = typeof plan.limit === "number" ? plan.limit : undefined;
  if (
    groupByNonEmpty &&
    sortNonEmpty &&
    cur !== undefined &&
    cur > 0 &&
    cur < EXTREMUM_LEADERBOARD_N
  ) {
    plan.limit = EXTREMUM_LEADERBOARD_N;
    args.plan = plan;
    step.args = args;
    return {
      changed: true,
      reason: `execute_query_plan single-row floor: limit ${cur} → ${EXTREMUM_LEADERBOARD_N}`,
    };
  }
  return { changed: false };
}
