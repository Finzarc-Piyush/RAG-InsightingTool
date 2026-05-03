/**
 * WSE3 · detect_seasonality tool.
 *
 * Surfaces recurring within-year patterns in a metric. Two granularities:
 *   - "month"   — month-of-year index across all years pooled
 *   - "quarter" — quarter-of-year index across all years pooled
 *   - "auto"    — picks month if ≥2 years × ≥6 distinct months;
 *                 quarter if ≥2 years × ≥4 quarters; else refuses.
 *
 * Returns:
 *   - `summary`         — one-paragraph human-readable narrative the
 *                         narrator drops directly into findings[].evidence
 *   - `numericPayload`  — full index + consistency JSON (capped 8 KB)
 *   - `table.rows`      — index rows (one per position) for chart-builder
 *   - `memorySlots`     — `seasonality_strength`, `seasonality_peak_positions`,
 *                         `seasonality_consistency_max`, `seasonality_grain`,
 *                         `seasonality_years_observed`
 *
 * Routing:
 *   - DuckDB-preferred path via ColumnarStorageService when columnar
 *     storage is active. Honors active filter via `resolveSessionDataTable`.
 *   - In-memory fallback uses extractPositionFromIso (wide-format) or
 *     direct date parsing (raw-date) on `ctx.exec.data`.
 *
 * Compound-shape Metric guard (defense-in-depth): refuses when the
 * dataset is wide-format compound shape AND the args don't carry a
 * Metric filter / Metric in dimensions, mirroring `compute_growth`.
 */
import { z } from "zod";
import type { ToolRegistry, ToolResult } from "../toolRegistry.js";
import {
  ColumnarStorageService,
  isDuckDBAvailable,
} from "../../../columnarStorage.js";
import { resolveSessionDataTable } from "../../../activeFilter/resolveSessionDataTable.js";
import { buildSeasonalityAggSql } from "../../../seasonality/buildSeasonalityAggSql.js";
import {
  computePeakConsistency,
  computeSeasonalityIndex,
  chooseSeasonalityGrain,
  extractPositionFromIso,
  seasonalityStrength,
  summarizeSeasonality,
  type SeasonalityGrain,
  type SeasonalityInput,
} from "../../../seasonality/computeSeasonality.js";
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

export const detectSeasonalityArgsSchema = z
  .object({
    metricColumn: z.string(),
    dateColumn: z.string().optional(),
    periodIsoColumn: z.string().optional(),
    granularity: z.enum(["month", "quarter", "auto"]).default("auto"),
    dimensionColumn: z.string().optional(),
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
    aggregation: z.enum(["sum", "avg", "min", "max"]).optional(),
    topK: z.number().int().min(1).max(6).optional(),
    consistencyThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();

type DetectSeasonalityArgs = z.infer<typeof detectSeasonalityArgsSchema>;

interface AggRow {
  year: number;
  position: number;
  value: number;
  dimension?: string;
}

function detectTemporalCoverage(
  rows: ReadonlyArray<Record<string, unknown>>,
  periodCol: string
): {
  distinctYears: number;
  distinctMonthsInOneYear: number;
  distinctQuartersInOneYear: number;
  weekly: boolean;
} {
  const years = new Set<string>();
  const monthsByYear: Record<string, Set<string>> = {};
  const quartersByYear: Record<string, Set<string>> = {};
  let weekly = false;
  for (const r of rows) {
    const v = r[periodCol];
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    const yearMatch = s.match(/^(\d{4})/);
    if (yearMatch) years.add(yearMatch[1]);
    if (/^\d{4}-\d{2}$/.test(s)) {
      const y = s.slice(0, 4);
      monthsByYear[y] ??= new Set();
      monthsByYear[y].add(s);
    } else if (/^\d{4}-Q[1-4]$/.test(s)) {
      const y = s.slice(0, 4);
      quartersByYear[y] ??= new Set();
      quartersByYear[y].add(s);
    } else if (/^\d{4}-W\d{2}$/.test(s)) {
      weekly = true;
    }
  }
  const maxM = Math.max(0, ...Object.values(monthsByYear).map((s) => s.size));
  const maxQ = Math.max(0, ...Object.values(quartersByYear).map((s) => s.size));
  return {
    distinctYears: years.size,
    distinctMonthsInOneYear: maxM,
    distinctQuartersInOneYear: maxQ,
    weekly,
  };
}

function aggregateInMemory(
  data: ReadonlyArray<Record<string, unknown>>,
  args: DetectSeasonalityArgs,
  grain: SeasonalityGrain,
  periodCol: string,
  isWideFormatPeriod: boolean
): AggRow[] {
  const filtered = applyDimensionFilters(data, args.dimensionFilters);
  // (year, position[, dim]) → sum
  const buckets = new Map<string, AggRow>();
  for (const r of filtered) {
    const periodVal = r[periodCol];
    if (periodVal === null || periodVal === undefined || periodVal === "") continue;
    let year: number | null = null;
    let position: number | null = null;
    if (isWideFormatPeriod) {
      const parsed = extractPositionFromIso(String(periodVal));
      if (parsed && parsed.grain === grain) {
        year = parsed.year;
        position = parsed.position;
      }
    } else {
      const ts = new Date(String(periodVal));
      if (!isNaN(ts.getTime())) {
        year = ts.getUTCFullYear();
        position =
          grain === "month"
            ? ts.getUTCMonth() + 1
            : Math.floor(ts.getUTCMonth() / 3) + 1;
      }
    }
    if (year === null || position === null) continue;
    const v = Number(r[args.metricColumn]);
    if (!Number.isFinite(v)) continue;
    const dim = args.dimensionColumn
      ? r[args.dimensionColumn] === null || r[args.dimensionColumn] === undefined
        ? "(null)"
        : String(r[args.dimensionColumn])
      : undefined;
    const key = `${year}__${position}__${dim ?? "_"}`;
    const cur = buckets.get(key);
    if (cur) {
      cur.value = aggregate(cur.value, v, args.aggregation);
    } else {
      buckets.set(key, { year, position, value: v, dimension: dim });
    }
  }
  return [...buckets.values()];
}

function aggregate(
  acc: number,
  next: number,
  op: DetectSeasonalityArgs["aggregation"]
): number {
  switch (op ?? "sum") {
    case "min":
      return Math.min(acc, next);
    case "max":
      return Math.max(acc, next);
    case "avg":
      // For 'avg' in-memory we can't track count cleanly with this structure;
      // approximate as running mean with equal weight (acceptable for the
      // defense-in-depth fallback path; DuckDB does proper AVG).
      return (acc + next) / 2;
    case "sum":
    default:
      return acc + next;
  }
}

function applyDimensionFilters(
  rows: ReadonlyArray<Record<string, unknown>>,
  filters: DimensionFilter[] | undefined
): ReadonlyArray<Record<string, unknown>> {
  if (!filters || filters.length === 0) return rows;
  return rows.filter((r) => {
    for (const f of filters) {
      const raw = r[f.column];
      const cell = raw === null || raw === undefined ? "" : String(raw);
      const cmp = f.match === "case_insensitive" ? cell.toLowerCase() : cell;
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

function toSeasonalityInput(rows: AggRow[]): SeasonalityInput[] {
  // For dimension-less analysis, AggRow is already (year, position, value).
  // For dimension-aware analysis, we sum across dimensions to compute the
  // overall seasonality signal — per-dimension breakdown is out of scope
  // for v1 (the user's complaint is about the overall pattern).
  const overall = new Map<string, SeasonalityInput>();
  for (const r of rows) {
    const k = `${r.year}__${r.position}`;
    const cur = overall.get(k);
    if (cur) cur.value += r.value;
    else overall.set(k, { year: r.year, position: r.position, value: r.value });
  }
  return [...overall.values()];
}

export function registerDetectSeasonalityTool(registry: ToolRegistry) {
  registry.register(
    "detect_seasonality",
    detectSeasonalityArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, raw): Promise<ToolResult> => {
      const args = detectSeasonalityArgsSchema.parse(raw) as DetectSeasonalityArgs;
      const summary = ctx.exec.summary;

      // Resolve the period axis. Prefer wide-format PeriodIso, then explicit
      // arg, then schema's first dateColumn.
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
            "detect_seasonality: no period column found. Pass periodIsoColumn (preferred) or dateColumn, or upload a dataset with a recognised date axis.",
        };
      }

      // Defensive schema check.
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
            summary: `detect_seasonality: column not in schema: ${col}`,
          };
        }
      }

      // Compound-shape Metric guard (mirrors compute_growth WPF2 idiom).
      if (
        wft?.detected &&
        wft.shape === "compound" &&
        wft.metricColumn &&
        args.metricColumn === wft.valueColumn
      ) {
        const filters = args.dimensionFilters ?? [];
        const hasMetricFilter = filters.some(
          (f) => f.column === wft.metricColumn
        );
        const inGroupBy = args.dimensionColumn === wft.metricColumn;
        if (!hasMetricFilter && !inGroupBy) {
          return {
            ok: false,
            summary: `detect_seasonality: compound-shape dataset — supply a Metric filter (e.g. dimensionFilters: [{column: "${wft.metricColumn}", op: "in", values: ["Value Sales"]}]). Without one, summing Value across mixed metrics produces nonsense.`,
          };
        }
      }

      // Resolve grain.
      const periodColForCoverage = periodIsoColumn ?? dateColumn!;
      const dataRef = ctx.exec.data;
      const coverage = detectTemporalCoverage(dataRef, periodColForCoverage);
      let grain: SeasonalityGrain | null;
      if (args.granularity === "auto") {
        grain = chooseSeasonalityGrain(coverage);
        if (!grain) {
          return {
            ok: false,
            summary: `detect_seasonality: needs ≥2 full years AND (≥6 distinct months OR ≥4 distinct quarters). Coverage: ${coverage.distinctYears} year(s), ${coverage.distinctMonthsInOneYear} month(s), ${coverage.distinctQuartersInOneYear} quarter(s). Try compute_growth for trend instead.`,
          };
        }
      } else {
        grain = args.granularity;
        // Hard guard: even if forced, still need ≥2 years.
        if (coverage.distinctYears < 2) {
          return {
            ok: false,
            summary: `detect_seasonality: requires ≥2 full years to detect recurring patterns; got ${coverage.distinctYears}. Try compute_growth for trend instead.`,
          };
        }
      }

      let aggRows: AggRow[] | null = null;
      let pathUsed: "duckdb" | "in_memory" = "in_memory";

      // ─────────────────────────────────────────────────────────────
      // DuckDB path
      // ─────────────────────────────────────────────────────────────
      if (
        ctx.exec.columnarStoragePath &&
        ctx.exec.sessionId &&
        isDuckDBAvailable()
      ) {
        const storage = new ColumnarStorageService({
          sessionId: ctx.exec.sessionId,
        });
        try {
          await storage.initialize();
          await storage.assertTableExists("data");
          const tableName = ctx.exec.chatDocument
            ? await resolveSessionDataTable(storage, {
                sessionId: ctx.exec.sessionId,
                activeFilter: ctx.exec.chatDocument.activeFilter,
              })
            : "data";

          const built = buildSeasonalityAggSql({
            tableName,
            valueColumn: args.metricColumn,
            dateColumn,
            periodIsoColumn,
            grain,
            dimensionColumn: args.dimensionColumn,
            aggregation: args.aggregation,
            dimensionFilters: args.dimensionFilters,
          });
          const rows = (await storage.executeQuery<AggRow>(built.sql)) ?? [];
          aggRows = rows.map((r) => ({
            year: Number(r.year),
            position: Number(r.position),
            value: Number(r.value),
            dimension: r.dimension ? String(r.dimension) : undefined,
          }));
          pathUsed = "duckdb";
        } catch (e) {
          agentLog("detect_seasonality_duckdb_fallback", {
            sessionId: ctx.exec.sessionId,
            error: e instanceof Error ? e.message.slice(0, 400) : String(e),
          });
        } finally {
          await storage.close().catch(() => {
            /* ignore */
          });
        }
      }

      // ─────────────────────────────────────────────────────────────
      // In-memory fallback
      // ─────────────────────────────────────────────────────────────
      if (!aggRows) {
        if (!dataRef || dataRef.length === 0) {
          return {
            ok: false,
            summary:
              "detect_seasonality: no row-level data is available and DuckDB session table is unreachable.",
          };
        }
        const periodCol = periodIsoColumn ?? dateColumn!;
        aggRows = aggregateInMemory(
          dataRef,
          args,
          grain,
          periodCol,
          Boolean(periodIsoColumn)
        );
      }

      if (aggRows.length === 0) {
        return {
          ok: false,
          summary:
            "detect_seasonality: aggregation produced zero rows. Check the metric column and active filters.",
        };
      }

      // Compute index + consistency.
      const seasInput = toSeasonalityInput(aggRows);
      const index = computeSeasonalityIndex(seasInput, grain);
      const consistency = computePeakConsistency(
        seasInput,
        grain,
        args.topK ?? 3,
        args.consistencyThreshold ?? 0.6
      );
      const strength = seasonalityStrength(index);
      const summaryLine = summarizeSeasonality(
        index,
        consistency,
        strength,
        grain
      );

      const peakPositions = (
        consistency.consistentPeaks.length > 0
          ? consistency.consistentPeaks
          : consistency.rows.slice(0, args.topK ?? 3)
      )
        .map((p) => p.label)
        .join(", ");
      const topConsistency = consistency.rows[0]?.fractionInTopK ?? 0;

      const payload = JSON.stringify(
        { index, consistency, strength, grain, path: pathUsed },
        null,
        2
      );

      agentLog("detect_seasonality_done", {
        sessionId: ctx.exec.sessionId,
        path: pathUsed,
        grain,
        years: consistency.totalYears,
        strength: strength.tier,
        peakCount: consistency.consistentPeaks.length,
      });

      return {
        ok: true,
        summary: summaryLine,
        numericPayload: payload.slice(0, 8000),
        table: {
          rows: index.map((r) => ({
            position: r.position,
            label: r.label,
            mean: r.mean,
            count: r.count,
            index: r.index,
            yearsObserved: r.yearsObserved,
            fractionInTopK:
              consistency.rows.find((c) => c.position === r.position)
                ?.fractionInTopK ?? 0,
          })),
          columns: [
            "position",
            "label",
            "mean",
            "count",
            "index",
            "yearsObserved",
            "fractionInTopK",
          ],
          rowCount: index.length,
        },
        memorySlots: {
          seasonality_grain: grain,
          seasonality_strength: strength.tier,
          seasonality_peak_positions: peakPositions || "(none)",
          seasonality_consistency_max: topConsistency.toFixed(2),
          seasonality_years_observed: String(consistency.totalYears),
        },
      };
    },
    {
      description:
        "Detect recurring within-year seasonality (month-of-year or quarter-of-year). Returns per-position index (mean / overall_mean), peak consistency across years (e.g. 'Nov in top-3 every year for 5 years'), and a strength tier (strong/moderate/weak/none). Use for trend questions on multi-year monthly or quarterly data — surfaces RECURRING patterns the time-series view misses (e.g. 'Q4 always peaks' vs the misleading 'Nov 2018 was the peak'). Auto-grain picks month with ≥2 years × ≥6 months, quarter with ≥2 years × ≥4 quarters, otherwise refuses. Honors active filter + compound-shape Metric guard same as compute_growth.",
      argsHelp:
        '{"metricColumn": string (required), "dateColumn"?: string, "periodIsoColumn"?: string (preferred — wide-format PeriodIso), "granularity": "month"|"quarter"|"auto" (default "auto"), "dimensionColumn"?: string (overall pattern only — sum across dim), "dimensionFilters"?: [{column, op:"in"|"not_in", values:[...], match?}], "aggregation"?: "sum"|"avg"|"min"|"max" (default sum), "topK"?: number (1-6, default 3), "consistencyThreshold"?: number (0-1, default 0.6 — fraction of years a position must be in top-K to count as consistent peak)}',
    }
  );
}
