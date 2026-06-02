/**
 * ============================================================================
 * rfmSegmentationTool.ts — score & label customers by RFM (the `run_rfm_segmentation` tool)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `run_rfm_segmentation` tool. "RFM" is a classic customer-
 *   analytics framework that scores each entity (a customer, store, or SKU) on
 *   three things:
 *     - Recency   — how recently they last transacted (more recent = better).
 *     - Frequency — how often they transact (more = better).
 *     - Monetary  — how much they spend in total (more = better).
 *   Each of the three is rank-scored 1..B (B = number of buckets, default 5,
 *   where 5 is the top fifth). Combining the three scores gives a code like
 *   "555" and, via a fixed ruleset, a friendly segment label — Champions,
 *   Loyal Customers, At Risk, Hibernating, Lost, New Customers, Potential
 *   Loyalist, About to Sleep, Cant Lose Them, Regular.
 *
 * WHY IT MATTERS
 *   Turns a raw transaction log into actionable customer segments ("who are my
 *   champions? who is about to churn?") without a Python round-trip. The output
 *   table is sorted best-first and capped at `maxEntities` so it stays
 *   renderable; the full per-segment counts ride along in `numericPayload` for
 *   dashboards.
 *
 * KEY PIECES
 *   - rfmSegmentationArgsSchema — validates entity/period/monetary columns,
 *     bucket count, frequency mode, row cap, optional row filters.
 *   - scoreByValue — quantile rank scoring (turns raw values into 1..B scores).
 *   - classifyRfmSegment — the priority-ordered ruleset mapping (R,F,M) → label.
 *   - registerRfmSegmentationTool / runRfmSegmentation — register the tool and
 *     the pure transform (filter → aggregate per entity → score → label).
 *
 * HOW IT CONNECTS
 *   Called by the agent act loop via the tool registry (toolRegistry.ts), runs
 *   on `ctx.exec.data`. Pure JavaScript, no Python. Pairs with
 *   `execute_query_plan` when the dataset needs prerequisite shaping.
 */

import { z } from "zod";
import type { ToolRegistry, ToolResult, ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";

const dimensionFilterSchema = z
  .object({
    column: z.string().min(1),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()).min(1),
    match: z.enum(["exact", "case_insensitive"]).optional(),
  })
  .strict();

export const rfmSegmentationArgsSchema = z
  .object({
    /** Column identifying the unique entity (customer/store/SKU). */
    entityColumn: z.string().min(1),
    /** Time-period column. Lexicographic sort must match calendar order
     *  (ISO-like values: "2024-01", "2024-W03", "2024Q1"). */
    periodColumn: z.string().min(1),
    /** Numeric column used for the Monetary dimension. */
    monetaryColumn: z.string().min(1),
    /** Bucket count for R/F/M scoring (quintiles by default). */
    buckets: z.number().int().min(3).max(7).default(5),
    /** Frequency mode: count rows OR count distinct periods. */
    frequencyMode: z.enum(["rows", "distinct_periods"]).default("distinct_periods"),
    /** Cap on rows returned. Segment counts in numericPayload cover the
     *  full entity population regardless. */
    maxEntities: z.number().int().min(10).max(2000).default(100),
    /** Optional row-level prefilter. */
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
  })
  .strict();

export type RfmSegmentationArgs = z.infer<typeof rfmSegmentationArgsSchema>;

interface EntityAggregate {
  key: string;
  lastPeriod: string;
  /** Index of lastPeriod in the sorted period list — used as recency value. */
  recencyValue: number;
  frequency: number;
  monetary: number;
  /** Holds period set if frequencyMode === "distinct_periods". */
  periods?: Set<string>;
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

/** Quantile rank scoring: larger value → higher score (1..B). */
function scoreByValue(
  entities: Array<{ key: string; value: number }>,
  buckets: number,
): Map<string, number> {
  const sorted = entities.map((e) => e.value).sort((a, b) => a - b);
  const N = sorted.length;
  const result = new Map<string, number>();
  for (const e of entities) {
    // upper_bound: index of first sorted[i] > e.value
    let lo = 0;
    let hi = N;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= e.value) lo = mid + 1;
      else hi = mid;
    }
    const rank = lo; // count of values ≤ e.value (1..N)
    const score = Math.max(1, Math.min(buckets, Math.ceil((rank / N) * buckets)));
    result.set(e.key, score);
  }
  return result;
}

/** Canonical RFM segment ruleset. Priority order — first match wins. */
export function classifyRfmSegment(r: number, f: number, m: number, buckets: number): string {
  const top = buckets;
  const high = buckets - 1;
  const mid = Math.ceil(buckets / 2);
  const lowMid = Math.floor(buckets / 2);
  const low = 1;
  if (r === low && f === low && m === low) return "Lost";
  // "Cant Lose Them" reserved for the highest-value customers who are
  // slipping — require F=top AND M=top. F=4,M=4 with low R is just At Risk.
  if (r <= lowMid && f === top && m === top) return "Cant Lose Them";
  if (r <= lowMid && f >= mid && m >= mid) return "At Risk";
  if (r <= lowMid && f <= lowMid && m <= lowMid) return "Hibernating";
  if (r === top && f === low) return "New Customers";
  if (r >= high && f >= high && m >= high) return "Champions";
  if (f >= high && m >= mid) return "Loyal Customers";
  if (r >= high && f <= mid) return "Potential Loyalist";
  if (r === mid && f <= lowMid) return "About to Sleep";
  return "Regular";
}

export function registerRfmSegmentationTool(registry: ToolRegistry) {
  registry.register(
    "run_rfm_segmentation",
    rfmSegmentationArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_rfm_segmentation is only available in analysis mode.",
        };
      }
      const parsed = rfmSegmentationArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_rfm_segmentation: ${parsed.error.message}`,
        };
      }
      const result = runRfmSegmentation(ctx.exec.data, parsed.data);
      if (!result.ok) return result;
      agentLog("run_rfm_segmentation.done", {
        entityColumn: parsed.data.entityColumn,
        periodColumn: parsed.data.periodColumn,
        monetaryColumn: parsed.data.monetaryColumn,
        buckets: parsed.data.buckets,
        frequencyMode: parsed.data.frequencyMode,
      });
      return result;
    },
    {
      description:
        "Score each entity (customer/store/SKU) on Recency / Frequency / Monetary and assign a canonical RFM segment (Champions / Loyal / At Risk / Hibernating / etc). Pure-Node aggregation; pairs with execute_query_plan when the dataset needs prerequisite shaping.",
      argsHelp:
        '{"entityColumn":"<col>","periodColumn":"<col>","monetaryColumn":"<col>","buckets":5,"frequencyMode":"rows"|"distinct_periods","maxEntities":100,"dimensionFilters"?:[{"column":"<col>","op":"in"|"not_in","values":["..."]}]}',
    },
  );
}

/** Pure transform — exported for tests + skill reuse. No I/O. */
export function runRfmSegmentation(
  rows: Array<Record<string, unknown>>,
  args: RfmSegmentationArgs,
): ToolResult {
  if (!rows || rows.length === 0) {
    return { ok: false, summary: "run_rfm_segmentation: dataset is empty." };
  }

  const filtered = rows.filter((row) =>
    (args.dimensionFilters ?? []).every((f) => passesFilter(row, f)),
  );
  if (filtered.length === 0) {
    return {
      ok: false,
      summary: "run_rfm_segmentation: no rows match the supplied filters.",
    };
  }

  // 1. Period index (lexicographic).
  const periodSet = new Set<string>();
  for (const row of filtered) {
    const p = row[args.periodColumn];
    if (p === null || p === undefined || p === "") continue;
    periodSet.add(String(p));
  }
  if (periodSet.size === 0) {
    return {
      ok: false,
      summary: `run_rfm_segmentation: no rows had a value for periodColumn '${args.periodColumn}'.`,
    };
  }
  const sortedPeriods = Array.from(periodSet).sort();
  const periodIndex = new Map<string, number>();
  sortedPeriods.forEach((p, i) => periodIndex.set(p, i));

  // 2. Aggregate per entity.
  const aggregates = new Map<string, EntityAggregate>();
  for (const row of filtered) {
    const entityRaw = row[args.entityColumn];
    const periodRaw = row[args.periodColumn];
    if (entityRaw === null || entityRaw === undefined || entityRaw === "") continue;
    if (periodRaw === null || periodRaw === undefined || periodRaw === "") continue;
    const eKey = String(entityRaw);
    const pStr = String(periodRaw);
    const pIdx = periodIndex.get(pStr);
    if (pIdx === undefined) continue;

    let agg = aggregates.get(eKey);
    if (!agg) {
      agg = {
        key: eKey,
        lastPeriod: pStr,
        recencyValue: pIdx,
        frequency: 0,
        monetary: 0,
      };
      if (args.frequencyMode === "distinct_periods") agg.periods = new Set();
      aggregates.set(eKey, agg);
    }
    if (pIdx > agg.recencyValue) {
      agg.recencyValue = pIdx;
      agg.lastPeriod = pStr;
    }
    if (args.frequencyMode === "distinct_periods") {
      agg.periods!.add(pStr);
    } else {
      agg.frequency += 1;
    }
    const monetary = toNumberOrNull(row[args.monetaryColumn]);
    if (monetary !== null) agg.monetary += monetary;
  }
  if (aggregates.size === 0) {
    return {
      ok: false,
      summary: "run_rfm_segmentation: no entities could be aggregated.",
    };
  }

  // Finalize distinct-period frequency.
  for (const agg of aggregates.values()) {
    if (args.frequencyMode === "distinct_periods") {
      agg.frequency = agg.periods!.size;
      delete agg.periods;
    }
  }

  // 3. Score each dimension.
  const entityList = Array.from(aggregates.values());
  const rScores = scoreByValue(
    entityList.map((e) => ({ key: e.key, value: e.recencyValue })),
    args.buckets,
  );
  const fScores = scoreByValue(
    entityList.map((e) => ({ key: e.key, value: e.frequency })),
    args.buckets,
  );
  const mScores = scoreByValue(
    entityList.map((e) => ({ key: e.key, value: e.monetary })),
    args.buckets,
  );

  // 4. Compose rows + segment counts.
  const segmentCounts = new Map<string, number>();
  const composed = entityList.map((agg) => {
    const r = rScores.get(agg.key)!;
    const f = fScores.get(agg.key)!;
    const m = mScores.get(agg.key)!;
    const rfmScore = `${r}${f}${m}`;
    const segment = classifyRfmSegment(r, f, m, args.buckets);
    segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1);
    return {
      [args.entityColumn]: agg.key,
      last_period: agg.lastPeriod,
      frequency: agg.frequency,
      monetary: agg.monetary,
      r_score: r,
      f_score: f,
      m_score: m,
      rfm_score: rfmScore,
      segment,
    };
  });

  // 5. Sort by combined score desc, tie-break by monetary desc.
  composed.sort((a, b) => {
    const aScore = (a.r_score as number) + (a.f_score as number) + (a.m_score as number);
    const bScore = (b.r_score as number) + (b.f_score as number) + (b.m_score as number);
    if (bScore !== aScore) return bScore - aScore;
    return (b.monetary as number) - (a.monetary as number);
  });

  const cappedRows = composed.slice(0, args.maxEntities);

  const segmentBreakdown = Array.from(segmentCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([segment, count]) => ({ segment, count }));

  const summary =
    `${entityList.length} entities scored on R/F/M (${args.buckets} buckets) · ` +
    `${segmentBreakdown.length} segments · ` +
    `top segments: ${segmentBreakdown.slice(0, 3).map((s) => `${s.segment} (${s.count})`).join(", ")}` +
    `${entityList.length > args.maxEntities ? ` · table capped at top ${args.maxEntities}` : ""}`;

  return {
    ok: true,
    summary,
    table: {
      columns: [
        args.entityColumn,
        "last_period",
        "frequency",
        "monetary",
        "r_score",
        "f_score",
        "m_score",
        "rfm_score",
        "segment",
      ],
      rows: cappedRows,
    },
    numericPayload: JSON.stringify({
      kind: "rfm_segmentation",
      entityColumn: args.entityColumn,
      periodColumn: args.periodColumn,
      monetaryColumn: args.monetaryColumn,
      buckets: args.buckets,
      frequencyMode: args.frequencyMode,
      totalEntities: entityList.length,
      cappedTo: cappedRows.length,
      segmentBreakdown,
    }),
  };
}
