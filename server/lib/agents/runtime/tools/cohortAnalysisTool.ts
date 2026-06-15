/**
 * ============================================================================
 * cohortAnalysisTool.ts — the "run_cohort_analysis" tool (retention tables)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines the tool that builds a cohort / retention table. A "cohort" is a
 *   group of entities (customers, stores, SKUs) that all started in the same
 *   period — e.g. "everyone first seen in 2024-01". The tool then tracks how
 *   that same group behaves in later periods, so you can see retention
 *   (do they keep coming back?) or expansion (do they spend more over time?).
 *
 *   Output is a "wide" matrix — one row per cohort, and one column per
 *   period offset (period_offset_0 is the cohort's first/"birth" period,
 *   period_offset_1 is the next period, and so on):
 *
 *     [{ cohort: "2024-01", cohort_size: 120,
 *        period_offset_0: 120, period_offset_1: 95, period_offset_2: 78, ... },
 *      { cohort: "2024-02", cohort_size:  98,
 *        period_offset_0:  98, period_offset_1: 80, ... }]
 *
 *   Behaviour notes:
 *     • `cohort_size` = count of distinct entities in period_offset_0,
 *       regardless of the chosen aggregation.
 *     • If `cohortColumn` is omitted, each entity's cohort is auto-computed as
 *       its earliest observed `periodColumn` value (classic acquisition cohort).
 *     • If `retentionMode: true`, every cell is divided by the cohort's
 *       period_offset_0 value, turning counts into 0..1 retention fractions.
 *
 *   It is pure Node.js (no Python call) and runs on the in-memory row data.
 *
 * WHY IT MATTERS
 *   Retention/expansion is a distinct question shape that simple aggregation
 *   can't answer. This fills that gap so the agent can answer "how well do we
 *   keep customers month over month?".
 *
 * KEY PIECES
 *   - cohortAnalysisArgsSchema — Zod schema for the tool arguments (entity,
 *     period, optional explicit cohort, optional metric, aggregation, how many
 *     period columns, retention mode, row filters).
 *   - registerCohortAnalysisTool — registers the tool as "run_cohort_analysis".
 *   - runCohortAnalysis — the exported pure transform that does the actual
 *     bucketing and matrix building (also reused by tests and skills).
 *
 * HOW IT CONNECTS
 *   Registered into the ToolRegistry (../toolRegistry.js). Logs progress via
 *   agentLog (../agentLogger.js). Reads `ctx.exec.data` (the row-level data
 *   for the session); applies its own simple dimension filters first. Pairs
 *   well with execute_query_plan when pre-aggregated rows are needed.
 */

import { z } from "zod";
import type { ToolRegistry, ToolResult, ToolRunContext } from "../toolRegistry.js";
import { agentLog } from "../agentLogger.js";
import {
  passesFilter,
  categoricalDimensionFilterSchema as dimensionFilterSchema,
} from "./dimensionFilterMatch.js";
import { toFiniteNumber as toNumberOrNull } from "../../../numberCoercion.js";

export const cohortAnalysisArgsSchema = z
  .object({
    /** Column identifying the unique entity to track (customer/store/SKU). */
    entityColumn: z.string().min(1),
    /** Time-period column. Lexicographic sort must produce the desired order
     *  (use ISO-like values: "2024-01", "2024-W03", "2024Q1"). */
    periodColumn: z.string().min(1),
    /** Optional explicit cohort label column. If omitted, cohort = each
     *  entity's earliest observed period (classic acquisition cohort). */
    cohortColumn: z.string().min(1).optional(),
    /** Optional metric to aggregate. Required when aggregation is sum/mean. */
    metricColumn: z.string().min(1).optional(),
    /** Aggregation per cell. `count_distinct` counts unique entities active. */
    aggregation: z.enum(["count_distinct", "sum", "mean"]).default("count_distinct"),
    /** Cap the number of period-offset columns. 2..24. */
    maxPeriods: z.number().int().min(2).max(24).default(12),
    /** Divide every cell by the cohort's period_offset_0 value. */
    retentionMode: z.boolean().default(false),
    /** Optional row-level prefilter. */
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
  })
  .strict()
  .refine((a) => a.aggregation === "count_distinct" || !!a.metricColumn, {
    message: "metricColumn is required when aggregation is 'sum' or 'mean'",
    path: ["metricColumn"],
  });

export type CohortAnalysisArgs = z.infer<typeof cohortAnalysisArgsSchema>;

interface CellAccumulator {
  entities: Set<string>;
  sum: number;
  count: number;
}

function cellValue(cell: CellAccumulator | undefined, agg: CohortAnalysisArgs["aggregation"]): number {
  if (!cell) return 0;
  switch (agg) {
    case "count_distinct":
      return cell.entities.size;
    case "sum":
      return cell.sum;
    case "mean":
      return cell.count === 0 ? 0 : cell.sum / cell.count;
  }
}

export function registerCohortAnalysisTool(registry: ToolRegistry) {
  registry.register(
    "run_cohort_analysis",
    cohortAnalysisArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_cohort_analysis is only available in analysis mode.",
        };
      }
      const parsed = cohortAnalysisArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_cohort_analysis: ${parsed.error.message}`,
        };
      }
      const result = runCohortAnalysis(ctx.exec.data, parsed.data);
      if (!result.ok) return result;
      agentLog("run_cohort_analysis.done", {
        entityColumn: parsed.data.entityColumn,
        periodColumn: parsed.data.periodColumn,
        cohortColumn: parsed.data.cohortColumn ?? "",
        aggregation: parsed.data.aggregation,
        retentionMode: parsed.data.retentionMode,
      });
      return result;
    },
    {
      description:
        "Cohort retention/expansion table. Groups entities by cohort (acquisition period or explicit cohort label) and tracks aggregated activity over period offsets. Pure-Node; pairs with execute_query_plan when you need pre-aggregated rows.",
      argsHelp:
        '{"entityColumn":"<col>","periodColumn":"<col>","cohortColumn"?:"<col>","metricColumn"?:"<col>","aggregation":"count_distinct"|"sum"|"mean","maxPeriods":12,"retentionMode":false,"dimensionFilters"?:[{"column":"<col>","op":"in"|"not_in","values":["..."]}]}',
    },
  );
}

/**
 * Pure transform — exported for tests + skill reuse. No I/O.
 */
export function runCohortAnalysis(
  rows: Array<Record<string, unknown>>,
  args: CohortAnalysisArgs,
): ToolResult {
  if (!rows || rows.length === 0) {
    return { ok: false, summary: "run_cohort_analysis: dataset is empty." };
  }

  const filtered = rows.filter((row) =>
    (args.dimensionFilters ?? []).every((f) => passesFilter(row, f)),
  );
  if (filtered.length === 0) {
    return {
      ok: false,
      summary: "run_cohort_analysis: no rows match the supplied filters.",
    };
  }

  // 1. Collect sorted distinct periods (lexicographic — caller chooses
  //    ISO-like values to make order match calendar order).
  const periodSet = new Set<string>();
  for (const row of filtered) {
    const p = row[args.periodColumn];
    if (p === null || p === undefined || p === "") continue;
    periodSet.add(String(p));
  }
  if (periodSet.size === 0) {
    return {
      ok: false,
      summary: `run_cohort_analysis: no rows had a value for periodColumn '${args.periodColumn}'.`,
    };
  }
  const sortedPeriods = Array.from(periodSet).sort();
  const periodIndex = new Map<string, number>();
  sortedPeriods.forEach((p, i) => periodIndex.set(p, i));

  // 2. Assign each entity to a cohort.
  const entityCohort = new Map<string, string>();
  if (args.cohortColumn) {
    for (const row of filtered) {
      const entity = row[args.entityColumn];
      const cohort = row[args.cohortColumn];
      if (entity === null || entity === undefined || entity === "") continue;
      if (cohort === null || cohort === undefined || cohort === "") continue;
      const eKey = String(entity);
      if (!entityCohort.has(eKey)) entityCohort.set(eKey, String(cohort));
    }
  } else {
    const entityMinPeriodIdx = new Map<string, number>();
    for (const row of filtered) {
      const entity = row[args.entityColumn];
      const period = row[args.periodColumn];
      if (entity === null || entity === undefined || entity === "") continue;
      if (period === null || period === undefined || period === "") continue;
      const eKey = String(entity);
      const pIdx = periodIndex.get(String(period));
      if (pIdx === undefined) continue;
      const prev = entityMinPeriodIdx.get(eKey);
      if (prev === undefined || pIdx < prev) entityMinPeriodIdx.set(eKey, pIdx);
    }
    for (const [eKey, pIdx] of entityMinPeriodIdx) {
      entityCohort.set(eKey, sortedPeriods[pIdx]!);
    }
  }
  if (entityCohort.size === 0) {
    return {
      ok: false,
      summary: "run_cohort_analysis: no entities have a valid cohort assignment.",
    };
  }

  // 3. Build cohort × offset matrix.
  const matrix = new Map<string, Map<number, CellAccumulator>>();
  function getCell(cohort: string, offset: number): CellAccumulator {
    let row = matrix.get(cohort);
    if (!row) {
      row = new Map();
      matrix.set(cohort, row);
    }
    let cell = row.get(offset);
    if (!cell) {
      cell = { entities: new Set(), sum: 0, count: 0 };
      row.set(offset, cell);
    }
    return cell;
  }

  for (const row of filtered) {
    const entityRaw = row[args.entityColumn];
    const periodRaw = row[args.periodColumn];
    if (entityRaw === null || entityRaw === undefined || entityRaw === "") continue;
    if (periodRaw === null || periodRaw === undefined || periodRaw === "") continue;
    const eKey = String(entityRaw);
    const cohort = entityCohort.get(eKey);
    if (cohort === undefined) continue;
    // For explicit-cohort mode, the cohort label may not itself be a known
    // period; in that case the offset is computed against the earliest
    // observed period for entities in that cohort. For the simple case
    // we require cohort to be a known period — falling back gracefully.
    const cohortIdx = periodIndex.get(cohort);
    if (cohortIdx === undefined) continue;
    const periodIdx = periodIndex.get(String(periodRaw));
    if (periodIdx === undefined) continue;
    const offset = periodIdx - cohortIdx;
    if (offset < 0 || offset >= args.maxPeriods) continue;
    const cell = getCell(cohort, offset);
    cell.entities.add(eKey);
    if (args.aggregation !== "count_distinct") {
      const metricVal = toNumberOrNull(row[args.metricColumn!]);
      if (metricVal !== null) {
        cell.sum += metricVal;
        cell.count += 1;
      }
    } else {
      cell.count += 1;
    }
  }

  if (matrix.size === 0) {
    return {
      ok: false,
      summary:
        "run_cohort_analysis: no cells could be populated. Check that entity, period and (if set) cohort columns are consistent.",
    };
  }

  // 4. Render cohort table.
  const cohorts = Array.from(matrix.keys()).sort();
  const offsetCols: string[] = [];
  for (let i = 0; i < args.maxPeriods; i++) offsetCols.push(`period_offset_${i}`);

  const tableRows: Array<Record<string, unknown>> = cohorts.map((cohort) => {
    const cohortRow = matrix.get(cohort)!;
    const baseCell = cohortRow.get(0);
    const cohortSize = baseCell ? baseCell.entities.size : 0;
    const baseValue = cellValue(baseCell, args.aggregation);

    const out: Record<string, unknown> = {
      cohort,
      cohort_size: cohortSize,
    };
    for (let i = 0; i < args.maxPeriods; i++) {
      const cell = cohortRow.get(i);
      let val = cellValue(cell, args.aggregation);
      if (args.retentionMode) {
        val = baseValue === 0 ? 0 : val / baseValue;
      }
      out[`period_offset_${i}`] = val;
    }
    return out;
  });

  const summary =
    `Cohort table · ${cohorts.length} cohort(s) × up to ${args.maxPeriods} periods · ` +
    `${args.aggregation}` +
    `${args.aggregation !== "count_distinct" ? `(${args.metricColumn})` : ""}` +
    `${args.retentionMode ? " · retention mode" : ""}`;

  return {
    ok: true,
    summary,
    table: {
      columns: ["cohort", "cohort_size", ...offsetCols],
      rows: tableRows,
    },
    numericPayload: JSON.stringify({
      kind: "cohort_analysis",
      entityColumn: args.entityColumn,
      periodColumn: args.periodColumn,
      cohortColumn: args.cohortColumn ?? null,
      metricColumn: args.metricColumn ?? null,
      aggregation: args.aggregation,
      retentionMode: args.retentionMode,
      cohortCount: cohorts.length,
      maxPeriods: args.maxPeriods,
      totalEntities: entityCohort.size,
    }),
  };
}
