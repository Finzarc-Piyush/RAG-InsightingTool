/**
 * WGR3 · compute_growth tool.
 *
 * Period-over-period growth analysis (YoY/QoQ/MoM/WoW). Three modes:
 *   - "series"        — one row per (dimension?, period) with growth_pct
 *   - "summary"       — one row per period (no dimension)
 *   - "rankByGrowth"  — fastest-growing N dimension values; this is the
 *                       "fastest growing market" path the user asked for
 *
 * Routing:
 *   - When columnar DuckDB is active for the session, the SQL emitted by
 *     `buildGrowthSql` runs against the canonical `data` table (or the
 *     `data_filtered` view when an active filter is present, per FA2).
 *   - In-memory fallback uses `priorPeriodKey` from `growth/periodShift`
 *     to pair each period to its prior — supports the same three modes.
 *
 * Wide-format awareness:
 *   - `periodIsoColumn` defaults to `wideFormatTransform.periodIsoColumn`
 *     when present. The DuckDB SQL ORDER BY uses it (per WPF3 convention).
 *   - On compound-shape (wide-format) datasets, when the args don't carry
 *     a Metric filter and no Metric is in groupBy, this tool refuses with
 *     a guidance message — same posture as WPF2's compound-shape guard.
 *     The planner's `injectCompoundShapeMetricGuard` is the canonical
 *     fixer; this is defense-in-depth.
 */
import { z } from "zod";
import type { ToolRegistry } from "../toolRegistry.js";
import type { ToolResult } from "../toolRegistry.js";
import {
  ColumnarStorageService,
  isDuckDBAvailable,
} from "../../../columnarStorage.js";
import { resolveSessionDataTable } from "../../../activeFilter/resolveSessionDataTable.js";
import {
  buildGrowthSql,
  type BuildGrowthSqlInput,
} from "../../../growth/buildGrowthSql.js";
import {
  priorPeriodKey,
  chooseAutoGrain,
  type GrowthGrain,
} from "../../../growth/periodShift.js";
import type { DimensionFilter } from "../../../../shared/queryTypes.js";
import { agentLog } from "../agentLogger.js";

const dimensionFilterSchema = z
  .object({
    column: z.string(),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

export const computeGrowthArgsSchema = z
  .object({
    metricColumn: z.string(),
    dimensionColumn: z.string().optional(),
    /** Raw timestamp / date column (used when periodIsoColumn is absent). */
    dateColumn: z.string().optional(),
    /** Pre-bucketed canonical period column (e.g. PeriodIso, temporal facet). */
    periodIsoColumn: z.string().optional(),
    grain: z.enum(["yoy", "qoq", "mom", "wow", "auto"]).default("auto"),
    /** Underlying period kind — drives YoY LAG offset (12 / 4 / 52 / 1). */
    periodKind: z.enum(["month", "quarter", "week", "year"]).optional(),
    mode: z.enum(["series", "summary", "rankByGrowth"]).default("series"),
    topN: z.number().int().min(2).max(50).optional(),
    aggregation: z.enum(["sum", "avg", "min", "max"]).optional(),
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
  })
  .strict();

type ComputeGrowthArgs = z.infer<typeof computeGrowthArgsSchema>;

interface GrowthRow {
  dimension?: string;
  period: string;
  value: number | null;
  prior_value: number | null;
  growth_pct: number | null;
  growth_abs: number | null;
}

function detectTemporalCoverage(
  rows: Array<Record<string, unknown>>,
  periodCol: string
): {
  distinctYears: number;
  distinctQuartersInOneYear: number;
  distinctMonthsInOneYear: number;
  weekly: boolean;
} {
  const periods = new Set<string>();
  for (const r of rows) {
    const v = r[periodCol];
    if (v !== null && v !== undefined && v !== "") periods.add(String(v));
  }
  const arr = [...periods];
  const years = new Set<string>();
  const quartersByYear: Record<string, Set<string>> = {};
  const monthsByYear: Record<string, Set<string>> = {};
  let weekly = false;
  for (const p of arr) {
    const year = p.match(/^(\d{4})/)?.[1];
    if (year) years.add(year);
    if (/^\d{4}-Q[1-4]$/.test(p)) {
      const y = p.slice(0, 4);
      quartersByYear[y] ??= new Set();
      quartersByYear[y].add(p);
    } else if (/^\d{4}-\d{2}$/.test(p)) {
      const y = p.slice(0, 4);
      monthsByYear[y] ??= new Set();
      monthsByYear[y].add(p);
    } else if (/^\d{4}-W\d{2}$/.test(p)) {
      weekly = true;
    }
  }
  const maxQ = Math.max(0, ...Object.values(quartersByYear).map((s) => s.size));
  const maxM = Math.max(0, ...Object.values(monthsByYear).map((s) => s.size));
  return {
    distinctYears: years.size,
    distinctQuartersInOneYear: maxQ,
    distinctMonthsInOneYear: maxM,
    weekly,
  };
}

function inferGrainFromKind(kind: string | undefined): GrowthGrain {
  if (kind === "quarter") return "yoy";
  if (kind === "month") return "yoy";
  if (kind === "week") return "yoy";
  if (kind === "year") return "yoy";
  return "yoy";
}

function summarizeRanked(rows: GrowthRow[], grain: GrowthGrain): string {
  if (rows.length === 0) return "compute_growth (rankByGrowth): no rows had a prior-period pair.";
  const top = rows[0];
  const bottom = rows[rows.length - 1];
  const fmtPct = (v: number | null) =>
    v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
  const lines = [
    `compute_growth (rankByGrowth, ${grain.toUpperCase()}): ${rows.length} segment(s) ranked by growth.`,
    `Top: ${top.dimension} @ ${top.period} → ${fmtPct(top.growth_pct)} (vs ${fmtPct(0)} baseline)`,
    `Bottom: ${bottom.dimension} @ ${bottom.period} → ${fmtPct(bottom.growth_pct)}`,
  ];
  return lines.join("\n");
}

function summarizeSeries(rows: GrowthRow[], grain: GrowthGrain, mode: string): string {
  const nonNull = rows.filter((r) => r.growth_pct !== null);
  if (nonNull.length === 0) {
    return `compute_growth (${mode}, ${grain.toUpperCase()}): ${rows.length} period(s) — no prior-period pairs available (likely insufficient temporal coverage).`;
  }
  const sample = nonNull.slice(0, 4).map((r) => {
    const dim = r.dimension ? `${r.dimension} ` : "";
    const pct = r.growth_pct === null ? "n/a" : `${(r.growth_pct * 100).toFixed(1)}%`;
    return `${dim}${r.period}: ${pct}`;
  });
  return `compute_growth (${mode}, ${grain.toUpperCase()}): ${rows.length} period(s), ${nonNull.length} with growth pairs. Sample: ${sample.join(" · ")}`;
}

// In-memory fallback: aggregates rows by (dimension, period), then pairs
// each period to its prior via `priorPeriodKey`. Supports all three modes.
function computeGrowthInMemory(
  rows: Array<Record<string, unknown>>,
  args: ComputeGrowthArgs,
  effectiveGrain: GrowthGrain,
  periodCol: string
): GrowthRow[] {
  const filtered = applyDimensionFiltersInMemory(rows, args.dimensionFilters);
  // Aggregate by (dimension?, period).
  const buckets = new Map<string, { dimension?: string; period: string; sum: number }>();
  for (const r of filtered) {
    const period = r[periodCol];
    if (period === null || period === undefined || period === "") continue;
    const periodStr = String(period);
    const dim = args.dimensionColumn
      ? r[args.dimensionColumn] === null || r[args.dimensionColumn] === undefined
        ? "(null)"
        : String(r[args.dimensionColumn])
      : undefined;
    const v = Number(r[args.metricColumn]);
    if (!Number.isFinite(v)) continue;
    const key = `${dim ?? "_"}__${periodStr}`;
    const cur = buckets.get(key);
    if (cur) cur.sum += v;
    else buckets.set(key, { dimension: dim, period: periodStr, sum: v });
  }

  // Build a (dimension, period) → value lookup so prior_value pairs work.
  const valueByKey = new Map<string, number>();
  for (const b of buckets.values()) {
    valueByKey.set(`${b.dimension ?? "_"}__${b.period}`, b.sum);
  }

  const out: GrowthRow[] = [];
  for (const b of buckets.values()) {
    const priorPeriod = priorPeriodKey(b.period, effectiveGrain);
    const priorVal = priorPeriod
      ? valueByKey.get(`${b.dimension ?? "_"}__${priorPeriod}`) ?? null
      : null;
    const growthPct =
      priorVal === null || priorVal === undefined || priorVal === 0
        ? null
        : (b.sum - priorVal) / priorVal;
    const growthAbs = priorVal === null || priorVal === undefined ? null : b.sum - priorVal;
    out.push({
      dimension: b.dimension,
      period: b.period,
      value: b.sum,
      prior_value: priorVal,
      growth_pct: growthPct,
      growth_abs: growthAbs,
    });
  }

  if (args.mode === "rankByGrowth") {
    // Latest period per dimension — pick the maximum period string per dim.
    const latestByDim = new Map<string, GrowthRow>();
    for (const r of out) {
      if (r.prior_value === null || r.prior_value === 0) continue;
      const dim = r.dimension ?? "_";
      const cur = latestByDim.get(dim);
      if (!cur || r.period > cur.period) latestByDim.set(dim, r);
    }
    const ranked = [...latestByDim.values()].sort(
      (a, b) => (b.growth_pct ?? -Infinity) - (a.growth_pct ?? -Infinity)
    );
    return ranked.slice(0, Math.max(2, Math.min(50, args.topN ?? 10)));
  }

  if (args.mode === "summary") {
    // Re-aggregate without dimension.
    const periodTotals = new Map<string, number>();
    for (const r of filtered) {
      const period = r[periodCol];
      if (period === null || period === undefined || period === "") continue;
      const v = Number(r[args.metricColumn]);
      if (!Number.isFinite(v)) continue;
      periodTotals.set(String(period), (periodTotals.get(String(period)) ?? 0) + v);
    }
    const periods = [...periodTotals.keys()].sort();
    return periods.map((p) => {
      const value = periodTotals.get(p)!;
      const prior = priorPeriodKey(p, effectiveGrain);
      const priorVal = prior ? periodTotals.get(prior) ?? null : null;
      return {
        period: p,
        value,
        prior_value: priorVal,
        growth_pct:
          priorVal === null || priorVal === 0 ? null : (value - priorVal) / priorVal,
        growth_abs: priorVal === null ? null : value - priorVal,
      };
    });
  }

  // series — sort by (dimension, period)
  out.sort((a, b) => {
    const da = a.dimension ?? "";
    const db = b.dimension ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.period < b.period ? -1 : 1;
  });
  return out;
}

function applyDimensionFiltersInMemory(
  rows: Array<Record<string, unknown>>,
  filters: DimensionFilter[] | undefined
): Array<Record<string, unknown>> {
  if (!filters || filters.length === 0) return rows;
  return rows.filter((r) => {
    for (const f of filters) {
      const raw = r[f.column];
      const cell = raw === null || raw === undefined ? "" : String(raw);
      const cmp =
        f.match === "case_insensitive"
          ? cell.toLowerCase()
          : cell;
      const set = new Set(
        f.values.map((v) =>
          f.match === "case_insensitive" ? String(v).toLowerCase() : String(v)
        )
      );
      const inList = set.has(cmp);
      if (f.op === "in" && !inList) return false;
      if (f.op === "not_in" && inList) return false;
    }
    return true;
  });
}

export function registerComputeGrowthTool(registry: ToolRegistry) {
  registry.register(
    "compute_growth",
    computeGrowthArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, raw): Promise<ToolResult> => {
      const args = computeGrowthArgsSchema.parse(raw) as ComputeGrowthArgs;
      const summary = ctx.exec.summary;

      // Resolve the period column. Wide-format → PeriodIso. Otherwise the
      // caller's explicit periodIsoColumn or dateColumn.
      const wft = summary.wideFormatTransform;
      const periodIsoColumn =
        args.periodIsoColumn ??
        (wft?.detected ? wft.periodIsoColumn : undefined);
      const dateColumn =
        args.dateColumn ??
        (summary.dateColumns && summary.dateColumns[0]) ??
        undefined;

      if (!periodIsoColumn && !dateColumn) {
        return {
          ok: false,
          summary:
            "compute_growth: no period column found. Pass periodIsoColumn (preferred) or dateColumn, or upload a dataset with a recognised date axis.",
        };
      }

      // Validate column membership against schema (defensive — planner repair
      // already runs, but tools should never trust args blindly).
      const allow = new Set(summary.columns.map((c) => c.name));
      for (const col of [
        args.metricColumn,
        args.dimensionColumn,
        periodIsoColumn,
        dateColumn,
      ]) {
        if (col && !allow.has(col)) {
          return {
            ok: false,
            summary: `compute_growth: column not in schema: ${col}`,
          };
        }
      }

      // Compound-shape Metric guard (defense-in-depth — planner should have
      // already injected this via WPF2).
      if (
        wft?.detected &&
        wft.shape === "compound" &&
        wft.metricColumn &&
        args.metricColumn === wft.valueColumn
      ) {
        const filters = args.dimensionFilters ?? [];
        const hasMetricFilter = filters.some((f) => f.column === wft.metricColumn);
        const inGroupBy = args.dimensionColumn === wft.metricColumn;
        if (!hasMetricFilter && !inGroupBy) {
          return {
            ok: false,
            summary: `compute_growth: compound-shape dataset — supply a Metric filter (e.g. dimensionFilters: [{column: "${wft.metricColumn}", op: "in", values: ["Value Sales"]}]) or set dimensionColumn to "${wft.metricColumn}" to break out by metric. Without one, summing Value across mixed metrics produces nonsense.`,
          };
        }
      }

      // Resolve grain.
      const dataRef = ctx.exec.data;
      const periodColForCoverage = periodIsoColumn ?? dateColumn!;
      const coverage = detectTemporalCoverage(dataRef, periodColForCoverage);
      const effectiveGrain: GrowthGrain =
        args.grain === "auto" ? chooseAutoGrain(coverage) : args.grain;

      // Infer periodKind when the caller didn't supply it. The wide-format
      // ISO labels carry the kind unambiguously in their prefix.
      let periodKind = args.periodKind;
      if (!periodKind) {
        if (coverage.weekly) periodKind = "week";
        else if (coverage.distinctMonthsInOneYear >= 3 && coverage.distinctQuartersInOneYear < 4)
          periodKind = "month";
        else if (coverage.distinctQuartersInOneYear >= 1) periodKind = "quarter";
        else periodKind = "year";
      }

      // ────────────────────────────────────────────────────────────
      // Try DuckDB path (preferred — full-dataset, fast LAG, honors
      // active filter via the data_filtered view).
      // ────────────────────────────────────────────────────────────
      if (
        ctx.exec.columnarStoragePath &&
        ctx.exec.sessionId &&
        isDuckDBAvailable()
      ) {
        const storage = new ColumnarStorageService({ sessionId: ctx.exec.sessionId });
        try {
          await storage.initialize();
          await storage.assertTableExists("data");
          const tableName = ctx.exec.chatDocument
            ? await resolveSessionDataTable(storage, {
                sessionId: ctx.exec.sessionId,
                activeFilter: ctx.exec.chatDocument.activeFilter,
              })
            : "data";

          const buildInput: BuildGrowthSqlInput = {
            tableName,
            metricColumn: args.metricColumn,
            dimensionColumn: args.dimensionColumn,
            periodIsoColumn,
            dateColumn,
            grain: effectiveGrain,
            periodKind,
            mode: args.mode,
            topN: args.topN,
            aggregation: args.aggregation,
            dimensionFilters: args.dimensionFilters,
          };
          const built = buildGrowthSql(buildInput);
          const rows = (await storage.executeQuery<GrowthRow>(built.sql)) ?? [];

          const summaryStr =
            args.mode === "rankByGrowth"
              ? summarizeRanked(rows, effectiveGrain)
              : summarizeSeries(rows, effectiveGrain, args.mode);

          // Top finder for memorySlots (helps planner / narrator chain).
          const ranked = rows.filter((r) => r.growth_pct !== null);
          const topGrower = ranked[0];

          agentLog("compute_growth_duckdb", {
            sessionId: ctx.exec.sessionId,
            mode: args.mode,
            grain: effectiveGrain,
            kind: periodKind,
            rowCount: rows.length,
            lag: built.lagOffset,
          });

          return {
            ok: true,
            summary: summaryStr,
            numericPayload: JSON.stringify(rows.slice(0, 200), null, 2).slice(0, 8000),
            table: { rows, columns: built.columns, rowCount: rows.length },
            memorySlots: {
              growth_grain: effectiveGrain,
              growth_mode: args.mode,
              growth_period_kind: periodKind,
              growth_row_count: String(rows.length),
              ...(topGrower
                ? {
                    growth_top_dimension: String(topGrower.dimension ?? ""),
                    growth_top_pct:
                      topGrower.growth_pct === null
                        ? "n/a"
                        : `${(topGrower.growth_pct * 100).toFixed(1)}%`,
                  }
                : {}),
            },
          };
        } catch (e) {
          agentLog("compute_growth_duckdb_fallback", {
            sessionId: ctx.exec.sessionId,
            error: e instanceof Error ? e.message.slice(0, 400) : String(e),
          });
          // Fall through to in-memory path.
        } finally {
          await storage.close().catch(() => {
            /* ignore */
          });
        }
      }

      // ────────────────────────────────────────────────────────────
      // In-memory fallback. Honors dimensionFilters and computes
      // prior-period pairs via priorPeriodKey.
      // ────────────────────────────────────────────────────────────
      if (!dataRef || dataRef.length === 0) {
        return {
          ok: false,
          summary:
            "compute_growth: no row-level data is available and DuckDB session table is unreachable.",
        };
      }
      const periodCol = periodIsoColumn ?? dateColumn!;
      if (!periodCol) {
        return {
          ok: false,
          summary: "compute_growth: no period column resolved.",
        };
      }
      const rows = computeGrowthInMemory(dataRef, args, effectiveGrain, periodCol);
      const summaryStr =
        args.mode === "rankByGrowth"
          ? summarizeRanked(rows, effectiveGrain)
          : summarizeSeries(rows, effectiveGrain, args.mode);
      const topGrower = rows.filter((r) => r.growth_pct !== null)[0];

      agentLog("compute_growth_in_memory", {
        sessionId: ctx.exec.sessionId,
        mode: args.mode,
        grain: effectiveGrain,
        kind: periodKind,
        rowCount: rows.length,
      });

      return {
        ok: true,
        summary: summaryStr,
        numericPayload: JSON.stringify(rows.slice(0, 200), null, 2).slice(0, 8000),
        table: {
          rows,
          columns: ["dimension", "period", "value", "prior_value", "growth_pct", "growth_abs"],
          rowCount: rows.length,
        },
        memorySlots: {
          growth_grain: effectiveGrain,
          growth_mode: args.mode,
          growth_period_kind: periodKind,
          growth_row_count: String(rows.length),
          ...(topGrower
            ? {
                growth_top_dimension: String(topGrower.dimension ?? ""),
                growth_top_pct:
                  topGrower.growth_pct === null
                    ? "n/a"
                    : `${(topGrower.growth_pct * 100).toFixed(1)}%`,
              }
            : {}),
        },
      };
    },
    {
      description:
        "Period-over-period growth analysis (YoY/QoQ/MoM/WoW). Three modes: 'series' (one row per dim×period with growth_pct + prior_value), 'summary' (one row per period, no dimension), 'rankByGrowth' (fastest-growing N dimension values — use this for 'fastest growing market' / 'biggest decliner' questions). Pick grain by temporal coverage: multi-year → yoy; single year multi-quarter → qoq; single year multi-month → mom; weekly → wow; uncertain → 'auto'. Wide-format datasets get PeriodIso for the period axis automatically. PREFER this over breakdown_ranking for any question about growth, change-over-time, or trend deltas.",
      argsHelp:
        '{"metricColumn": string (required), "dimensionColumn"?: string (required for rankByGrowth), "dateColumn"?: string, "periodIsoColumn"?: string (preferred — wide-format PeriodIso or temporal facet), "grain": "yoy"|"qoq"|"mom"|"wow"|"auto" (default "auto"), "periodKind"?: "month"|"quarter"|"week"|"year" (drives YoY LAG offset), "mode": "series"|"summary"|"rankByGrowth" (default "series"), "topN"?: number (rankByGrowth only, 2–50, default 10), "aggregation"?: "sum"|"avg"|"min"|"max" (default sum), "dimensionFilters"?: [{column, op:"in"|"not_in", values:[...], match?:"case_insensitive"}]}',
    }
  );
}
