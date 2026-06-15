/**
 * ============================================================================
 * priceElasticityTool.ts — how much does demand move when price moves
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `run_price_elasticity` tool. "Price elasticity" measures how
 *   sensitive quantity sold is to price changes: an elasticity of -1.5 means a
 *   1% price increase roughly cuts volume by 1.5%. The standard way to estimate
 *   it is a log-log regression — fit the line
 *       log(quantity) = a + b · log(price)
 *   and the slope `b` IS the elasticity. ("OLS" = ordinary least squares, the
 *   plain best-fit-line method. "Regression" = fitting a line through data
 *   points.) The tool can also split by a `groupColumn` to get a separate
 *   elasticity per SKU / region / channel. For each fit it reports the
 *   elasticity, its 95% confidence interval (CI), the t-value (how far from
 *   zero / how trustworthy the slope is), R² (how well the line fits, 0..1),
 *   and a plain-English label like "inelastic" or "highly elastic".
 *
 * WHY IT MATTERS
 *   Answers "what happens to volume if I raise shelf price by 5%?" without a
 *   Python round-trip. It is deliberately a simple single-variable OLS fit —
 *   no fixed effects, instrumental variables, or panel corrections. The
 *   multi-driver case (price + promo + media together) is handled by the MMM
 *   optimiser pipeline in the Python service instead.
 *
 * KEY PIECES
 *   - priceElasticityArgsSchema — validates price/quantity columns, optional
 *     group column, minObservations, row filters.
 *   - interpretElasticity — maps a slope to a human label.
 *   - bucketPriceElasticity — maps a slope onto the shared four-step effect-
 *     size taxonomy (negligible / small / medium / large) used by the
 *     confidence classifier downstream.
 *   - fitLogLogElasticity — the pure OLS math; exported for direct tests.
 *   - registerPriceElasticityTool / runPriceElasticity — register the tool and
 *     the pure per-group transform (filter → fit → rank → build table).
 *
 * HOW IT CONNECTS
 *   Called by the agent act loop via the tool registry (toolRegistry.ts), runs
 *   on `ctx.exec.data`. The result summary is decorated with a canonical
 *   "evidence" suffix (n, R², effect magnitude) via composeFindingDetail
 *   (../formatFindingEvidence.js) so the downstream confidence grader can judge
 *   the finding by real numbers rather than guessing.
 */

import { z } from "zod";
import type { ToolRegistry, ToolResult, ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";
import { roundTo } from "../../../numberCoercion.js";
import { composeFindingDetail } from "../formatFindingEvidence.js";
import type { FindingEvidence } from "../scaleNarrativeByConfidence.js";

const dimensionFilterSchema = z
  .object({
    column: z.string().min(1),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()).min(1),
    match: z.enum(["exact", "case_insensitive"]).optional(),
  })
  .strict();

export const priceElasticityArgsSchema = z
  .object({
    /** Numeric price column (positive values only — log skips ≤ 0). */
    priceColumn: z.string().min(1),
    /** Numeric quantity / volume column (positive values only). */
    quantityColumn: z.string().min(1),
    /** Optional categorical column to compute per-segment elasticities. */
    groupColumn: z.string().min(1).optional(),
    /** Minimum row count per group before a fit is reported (regression
     *  is unstable below ~6 observations). */
    minObservations: z.number().int().min(3).max(1000).default(6),
    /** Optional row-level prefilter. */
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
  })
  .strict();

export type PriceElasticityArgs = z.infer<typeof priceElasticityArgsSchema>;

export interface ElasticityFit {
  ok: true;
  n: number;
  elasticity: number;
  intercept: number;
  r_squared: number;
  slope_se: number;
  ci_low: number;
  ci_high: number;
  t_value: number;
  significant: boolean;
  interpretation: string;
}
export interface ElasticityFitFailure {
  ok: false;
  reason: string;
  n: number;
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function passesFilter(
  row: Record<string, unknown>,
  filter: { column: string; op: "in" | "not_in"; values: string[]; match?: "exact" | "case_insensitive" },
): boolean {
  const cell = row[filter.column];
  const cellStr = cell === null || cell === undefined ? "" : String(cell);
  const eq =
    filter.match === "case_insensitive"
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  const matched = filter.values.some((v) => eq(cellStr, v));
  return filter.op === "in" ? matched : !matched;
}

export function interpretElasticity(elasticity: number, significant: boolean): string {
  if (!significant) return "not statistically significant";
  if (elasticity > 0) return "anomalous (positive coefficient — possible Giffen good or data issue)";
  const mag = Math.abs(elasticity);
  if (mag < 0.5) return "highly inelastic";
  if (mag < 1) return "inelastic";
  if (mag < 1.1) return "unit elastic";
  if (mag < 2) return "elastic";
  return "highly elastic";
}

/**
 * Maps a fitted price elasticity (β) to the canonical four-bucket
 * `effectMagnitude` taxonomy on `FindingEvidence` so the downstream
 * confidence classifier can distinguish "highly inelastic with tight n"
 * (real but tiny practical effect → LOW confidence in acting on it) from
 * "highly elastic with tight n" (real and large → HIGH). Mirrors
 * `bucketCorrelationR` in [`correlationMath.ts`](../../../correlationMath.ts)
 * and `bucketCohensD` / `bucketCramersV` in [`significanceTests.ts`](../../../significanceTests.ts).
 *
 * Bucket boundaries align to the existing five-step `interpretElasticity`
 * ladder, collapsed onto the four-step `effectMagnitude` taxonomy:
 *
 *   not significant            → "negligible"  (no measurable response)
 *   |β| < 0.5  (highly inel.)  → "small"
 *   |β| < 1.5  (inel. + unit + most of elastic) → "medium"
 *   |β| ≥ 1.5  (highly elastic)→ "large"
 *
 * The 0.5 / 1.5 boundaries match the "highly inelastic" / "elastic"
 * thresholds in `interpretElasticity`; the |β| = 1 unit-elastic point
 * sits in "medium" (a 1% price change yields 1% quantity change — by
 * convention a balanced response, not a "large" one).
 *
 * Returns `null` on:
 *   - non-finite β (degenerate fit)
 *   - β > 0 (anomalous positive coefficient — Giffen-good shape; the
 *     `interpretElasticity` function flags it too. Caller decides
 *     whether to skip emitting the bucket or downgrade narrative.)
 *
 * Industry-specific cutoffs intentionally NOT layered on. FMCG own-price
 * elasticity of -2.0 is conventionally "huge" and -0.5 is "moderate";
 * the universal ladder maps both onto "large" / "small" respectively,
 * which is approximately right for FMCG but more conservative than the
 * domain conventions. If a per-vertical override surfaces as a use
 * case, the bucket function can take an optional context arg then.
 */
export function bucketPriceElasticity(
  elasticity: number,
  significant: boolean,
): "negligible" | "small" | "medium" | "large" | null {
  if (!Number.isFinite(elasticity)) return null;
  if (!significant) return "negligible";
  if (elasticity > 0) return null;
  const mag = Math.abs(elasticity);
  if (mag < 0.5) return "small";
  if (mag < 1.5) return "medium";
  return "large";
}

/** Pure log-log OLS fit. Exported for direct tests. */
export function fitLogLogElasticity(
  rows: Array<{ price: number; quantity: number }>,
  minObservations: number,
): ElasticityFit | ElasticityFitFailure {
  // Filter to strictly-positive pairs (log undefined for ≤ 0).
  const clean = rows.filter((r) => r.price > 0 && r.quantity > 0);
  if (clean.length < minObservations) {
    return {
      ok: false,
      reason: `insufficient observations (${clean.length} positive pairs, need ${minObservations})`,
      n: clean.length,
    };
  }
  const N = clean.length;
  const logP: number[] = new Array(N);
  const logQ: number[] = new Array(N);
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < N; i++) {
    logP[i] = Math.log(clean[i]!.price);
    logQ[i] = Math.log(clean[i]!.quantity);
    sumX += logP[i]!;
    sumY += logQ[i]!;
  }
  const meanX = sumX / N;
  const meanY = sumY / N;
  let SSxy = 0;
  let SSxx = 0;
  let SSyy = 0;
  for (let i = 0; i < N; i++) {
    const dx = logP[i]! - meanX;
    const dy = logQ[i]! - meanY;
    SSxy += dx * dy;
    SSxx += dx * dx;
    SSyy += dy * dy;
  }
  if (SSxx === 0) {
    return {
      ok: false,
      reason: "all log(price) values are identical — slope is undefined",
      n: N,
    };
  }
  const slope = SSxy / SSxx;
  const intercept = meanY - slope * meanX;
  // Residual sum of squares.
  let SSres = 0;
  for (let i = 0; i < N; i++) {
    const pred = intercept + slope * logP[i]!;
    const resid = logQ[i]! - pred;
    SSres += resid * resid;
  }
  const r_squared = SSyy === 0 ? 1 : 1 - SSres / SSyy;
  // Slope standard error.
  const slope_se =
    N <= 2 ? 0 : Math.sqrt(SSres / (N - 2)) / Math.sqrt(SSxx);
  // 95% CI using normal approximation (1.96 ≈ z_{0.975}). For N>30 this
  // matches the t-distribution closely; for small N we accept the slight
  // under-coverage rather than ship a t-table.
  const ci_low = slope - 1.96 * slope_se;
  const ci_high = slope + 1.96 * slope_se;
  const t_value = slope_se === 0 ? 0 : slope / slope_se;
  // |t| > 2 ≈ α=0.05 for N>30. Below that we still flag significant when
  // |t| > 2 — analyst can decide whether to trust it.
  const significant = Math.abs(t_value) > 2;
  return {
    ok: true,
    n: N,
    elasticity: slope,
    intercept,
    r_squared,
    slope_se,
    ci_low,
    ci_high,
    t_value,
    significant,
    interpretation: interpretElasticity(slope, significant),
  };
}

export function registerPriceElasticityTool(registry: ToolRegistry) {
  registry.register(
    "run_price_elasticity",
    priceElasticityArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_price_elasticity is only available in analysis mode.",
        };
      }
      const parsed = priceElasticityArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_price_elasticity: ${parsed.error.message}`,
        };
      }
      const result = runPriceElasticity(ctx.exec.data, parsed.data);
      if (!result.ok) return result;
      agentLog("run_price_elasticity.done", {
        priceColumn: parsed.data.priceColumn,
        quantityColumn: parsed.data.quantityColumn,
        groupColumn: parsed.data.groupColumn ?? "",
        groupsReturned: result.table?.rows.length ?? 0,
      });
      return result;
    },
    {
      description:
        "Estimate price elasticity via log-log OLS regression. Returns slope (= elasticity), 95% CI, R², t-value, and a human-readable interpretation. Optional groupColumn for per-segment elasticities. Pure-Node; pairs with the MMM optimiser for the multi-driver case.",
      argsHelp:
        '{"priceColumn":"<col>","quantityColumn":"<col>","groupColumn"?:"<col>","minObservations":6,"dimensionFilters"?:[{"column":"<col>","op":"in"|"not_in","values":["..."]}]}',
    },
  );
}

/** Pure transform — exported for direct tests + skill reuse. No I/O. */
export function runPriceElasticity(
  rows: Array<Record<string, unknown>>,
  args: PriceElasticityArgs,
): ToolResult {
  if (!rows || rows.length === 0) {
    return { ok: false, summary: "run_price_elasticity: dataset is empty." };
  }
  const filtered = rows.filter((row) =>
    (args.dimensionFilters ?? []).every((f) => passesFilter(row, f)),
  );
  if (filtered.length === 0) {
    return {
      ok: false,
      summary: "run_price_elasticity: no rows match the supplied filters.",
    };
  }

  // Bucket rows by group (or single bucket if no groupColumn).
  const groups = new Map<string, Array<{ price: number; quantity: number }>>();
  for (const row of filtered) {
    const p = toNumberOrNull(row[args.priceColumn]);
    const q = toNumberOrNull(row[args.quantityColumn]);
    if (p === null || q === null) continue;
    let groupKey = "__all__";
    if (args.groupColumn) {
      const gv = row[args.groupColumn];
      if (gv === null || gv === undefined || gv === "") continue;
      groupKey = String(gv);
    }
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = [];
      groups.set(groupKey, bucket);
    }
    bucket.push({ price: p, quantity: q });
  }
  if (groups.size === 0) {
    return {
      ok: false,
      summary:
        "run_price_elasticity: no numeric (price, quantity) pairs found. Check column names.",
    };
  }

  const tableRows: Array<Record<string, unknown>> = [];
  const skipped: Array<{ group: string; reason: string; n: number }> = [];

  for (const [groupKey, bucket] of groups) {
    const fit = fitLogLogElasticity(bucket, args.minObservations);
    if (!fit.ok) {
      skipped.push({ group: groupKey, reason: fit.reason, n: fit.n });
      continue;
    }
    const row: Record<string, unknown> = {
      n: fit.n,
      elasticity: roundTo(fit.elasticity, 4),
      intercept: roundTo(fit.intercept, 4),
      r_squared: roundTo(fit.r_squared, 4),
      slope_se: roundTo(fit.slope_se, 4),
      ci_low: roundTo(fit.ci_low, 4),
      ci_high: roundTo(fit.ci_high, 4),
      t_value: roundTo(fit.t_value, 4),
      significant: fit.significant,
      interpretation: fit.interpretation,
    };
    if (args.groupColumn) row[args.groupColumn] = groupKey;
    tableRows.push(row);
  }

  if (tableRows.length === 0) {
    return {
      ok: false,
      summary: `run_price_elasticity: no group met the ${args.minObservations}-observation minimum. ${skipped.length} group(s) skipped.`,
    };
  }

  // Sort by |elasticity| desc — most-responsive segments first.
  tableRows.sort(
    (a, b) =>
      Math.abs(b.elasticity as number) - Math.abs(a.elasticity as number),
  );

  const columns = args.groupColumn
    ? [
        args.groupColumn,
        "n",
        "elasticity",
        "intercept",
        "r_squared",
        "slope_se",
        "ci_low",
        "ci_high",
        "t_value",
        "significant",
        "interpretation",
      ]
    : [
        "n",
        "elasticity",
        "intercept",
        "r_squared",
        "slope_se",
        "ci_low",
        "ci_high",
        "t_value",
        "significant",
        "interpretation",
      ];

  // Canonical FindingEvidence suffix. Top row by |elasticity| is the headline
  // result; emit its n + R² so the downstream extractor catches them
  // deterministically and the confidence grader judges by real evidence. Both
  // summary branches get the suffix — keeping the canonical block uniform
  // across tools (extractor returns the first match either way; the
  // duplication is harmless and the canonical phrasing is the contract).
  //
  // The headline row's β + significance flag also get mapped to the canonical
  // four-bucket `effectMagnitude` token via `bucketPriceElasticity` so the
  // grader can downgrade "highly inelastic with tight n" from HIGH to LOW
  // confidence (real but practically negligible response). The bucket only
  // emits when finite β + non-anomalous sign; positive β (Giffen-good shape)
  // returns null and the suffix omits the magnitude field rather than ship a
  // misleading "large" for a sign-anomalous fit.
  const topRow = tableRows[0]!;
  const headlineEvidence: FindingEvidence = {};
  if (typeof topRow.n === "number" && Number.isFinite(topRow.n) && topRow.n >= 0) {
    headlineEvidence.n = topRow.n;
  }
  if (
    typeof topRow.r_squared === "number" &&
    Number.isFinite(topRow.r_squared) &&
    topRow.r_squared >= 0 &&
    topRow.r_squared <= 1
  ) {
    headlineEvidence.rSquared = topRow.r_squared;
  }
  if (
    typeof topRow.elasticity === "number" &&
    typeof topRow.significant === "boolean"
  ) {
    const bucket = bucketPriceElasticity(topRow.elasticity, topRow.significant);
    if (bucket !== null) {
      headlineEvidence.effectMagnitude = bucket;
    }
  }
  const wv6EvidenceSuffix = composeFindingDetail("", headlineEvidence);

  const summary = args.groupColumn
    ? `${tableRows.length} group(s) fit; ${skipped.length} skipped (insufficient observations or degenerate).` +
      ` Most elastic: ${topRow[args.groupColumn]} (β=${topRow.elasticity}, ${topRow.interpretation})` +
      wv6EvidenceSuffix
    : `Elasticity β=${topRow.elasticity} (${topRow.interpretation}); R²=${topRow.r_squared}, n=${topRow.n}` +
      wv6EvidenceSuffix;

  return {
    ok: true,
    summary,
    table: { columns, rows: tableRows },
    numericPayload: JSON.stringify({
      kind: "price_elasticity",
      priceColumn: args.priceColumn,
      quantityColumn: args.quantityColumn,
      groupColumn: args.groupColumn ?? null,
      minObservations: args.minObservations,
      groupsFit: tableRows.length,
      groupsSkipped: skipped.length,
      skipped,
    }),
  };
}
