/**
 * ============================================================================
 * forecastTool.ts — predict where a number is heading (the `run_forecast` tool)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Registers the `run_forecast` tool the AI agent calls to project a numeric
 *   series into the future. "Forecasting" here means: take historical values
 *   bucketed by month / quarter / year (e.g. monthly revenue), fit a straight-
 *   line trend plus an optional repeating "seasonal" pattern (regular ups and
 *   downs, like a holiday spike), and extend that line `horizon` periods ahead.
 *   It also returns a confidence band (a low/high range around each predicted
 *   point) so the user sees how uncertain the forecast is. The result table
 *   contains both the historical "actual" rows and the future "forecast" rows
 *   so a chart can draw one continuous curve.
 *
 * WHY IT MATTERS
 *   Answers "what does next quarter look like?", "where will revenue be in 6
 *   months?". It's a simple pure-JavaScript fit (no Python round-trip) —
 *   deliberately "good enough for a directional estimate", NOT a full ARIMA /
 *   Prophet model. The tool surface is stable so the math can later be swapped
 *   for the Python statsmodels service without changing callers.
 *
 * KEY PIECES
 *   - forecastArgsSchema — validates the request (timeColumn, valueColumn,
 *     granularity, horizon, optional seasonality hint).
 *   - bucketKey / bucketComparator — group raw dates into period buckets and
 *     keep them in calendar order.
 *   - registerForecastTool — registers the tool; aggregates rows into buckets,
 *     calls the forecaster, builds the actual+forecast table.
 *
 * HOW IT CONNECTS
 *   Called by the agent act loop via the tool registry. The actual math lives
 *   in `forecastSeries` (../../../forecasting/forecastSeries.js). Gated by the
 *   `FORECAST_ENABLED=true` env flag — the tool always registers (so the
 *   planner can see it) but returns a clear "disabled" message when the flag
 *   is off, so production stays opt-in.
 */
import { z } from "zod";
import type { ToolRegistry, ToolRunContext } from "../toolRegistry.js";
import {
  forecastSeries,
  type ForecastSeasonality,
} from "../../../forecasting/forecastSeries.js";

export const forecastArgsSchema = z
  .object({
    /** Date column to bucket by (auto-resolved from session schema). */
    timeColumn: z.string().min(1).max(200),
    /** Numeric column to forecast. */
    valueColumn: z.string().min(1).max(200),
    /** Bucket size for the series. Default monthly. */
    granularity: z
      .enum(["month", "quarter", "year"])
      .default("month"),
    /** How many future periods to predict. */
    horizon: z.number().int().min(1).max(120).default(4),
    /** Seasonal-pattern hint. "auto" tries 4/7/12/52 and picks the best fit. */
    seasonality: z
      .union([z.enum(["auto", "none"]), z.literal(4), z.literal(7), z.literal(12), z.literal(52)])
      .optional(),
  })
  .strict();

type ForecastArgs = z.infer<typeof forecastArgsSchema>;

/**
 * Bucket key for a row's date value at the chosen granularity.
 * Returns null when the value can't be parsed as a date.
 */
function bucketKey(
  rawDate: unknown,
  granularity: ForecastArgs["granularity"]
): string | null {
  if (rawDate == null) return null;
  let d: Date;
  if (rawDate instanceof Date) {
    d = rawDate;
  } else {
    d = new Date(String(rawDate));
  }
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (granularity === "year") return `${y}`;
  if (granularity === "quarter") {
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    return `${y}-Q${q}`;
  }
  // month
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function bucketComparator(a: string, b: string): number {
  // YYYY, YYYY-Qn, YYYY-MM all sort lexicographically by year, then suffix.
  // YYYY-Qn vs YYYY-MM is mixed: in practice all rows share the same
  // granularity so the comparator stays consistent.
  return a.localeCompare(b);
}

export function registerForecastTool(registry: ToolRegistry) {
  registry.register(
    "run_forecast",
    forecastArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (process.env.FORECAST_ENABLED !== "true") {
        return {
          ok: false,
          summary:
            "run_forecast is disabled (FORECAST_ENABLED is not 'true'). Enable in server.env to activate forecasting.",
        };
      }
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_forecast is only available in analysis mode.",
        };
      }
      const parsed = forecastArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_forecast: ${parsed.error.message}`,
        };
      }
      const { timeColumn, valueColumn, granularity, horizon, seasonality } =
        parsed.data;
      const allow = new Set(ctx.exec.summary.columns.map((c) => c.name));
      if (!allow.has(timeColumn) || !allow.has(valueColumn)) {
        return {
          ok: false,
          summary: `timeColumn and valueColumn must exist in schema. Got ${timeColumn}, ${valueColumn}.`,
        };
      }

      // Aggregate row-level data into buckets at the requested granularity.
      const base =
        ctx.exec.turnStartDataRef && ctx.exec.turnStartDataRef.length > 0
          ? ctx.exec.turnStartDataRef
          : ctx.exec.data;
      const sums = new Map<string, { sum: number; n: number }>();
      for (const row of base) {
        const key = bucketKey((row as Record<string, unknown>)[timeColumn], granularity);
        if (!key) continue;
        const v = Number((row as Record<string, unknown>)[valueColumn]);
        if (!Number.isFinite(v)) continue;
        const cur = sums.get(key) ?? { sum: 0, n: 0 };
        cur.sum += v;
        cur.n += 1;
        sums.set(key, cur);
      }
      if (sums.size < 4) {
        return {
          ok: false,
          summary: `run_forecast: need ≥ 4 historical periods after bucketing; got ${sums.size}.`,
        };
      }
      const orderedKeys = [...sums.keys()].sort(bucketComparator);
      const history = orderedKeys.map((k) => ({
        label: k,
        value: sums.get(k)!.sum,
      }));

      const result = forecastSeries({
        history,
        horizon,
        seasonality: seasonality as ForecastSeasonality | undefined,
      });
      if (!result.ok) {
        return {
          ok: false,
          summary: `run_forecast: ${result.error}`,
        };
      }

      // Build result table: historical + forecast rows so the chart
      // builder + pivot can render the full curve.
      const rows: Record<string, unknown>[] = [];
      for (const h of history) {
        rows.push({
          period: h.label,
          actual: h.value,
          forecast: null,
          lower_ci: null,
          upper_ci: null,
        });
      }
      for (const f of result.forecast) {
        rows.push({
          period: f.label,
          actual: null,
          forecast: Math.round(f.pointForecast * 100) / 100,
          lower_ci: Math.round(f.lowerCI * 100) / 100,
          upper_ci: Math.round(f.upperCI * 100) / 100,
        });
      }
      const sample = JSON.stringify(
        rows.slice(rows.length - Math.min(rows.length, 8)),
        null,
        2
      );
      const seasonalNote =
        result.method === "linear_trend_plus_seasonal"
          ? ` + seasonal (period=${result.seasonalPeriod})`
          : "";
      const r2Note = ` (trend R²=${result.trendR2.toFixed(2)})`;
      return {
        ok: true,
        summary: `run_forecast: ${horizon}-${granularity} forecast for ${valueColumn} by ${timeColumn} via linear trend${seasonalNote}${r2Note}.\n${sample.slice(0, 4500)}`,
        table: {
          rows,
          columns: ["period", "actual", "forecast", "lower_ci", "upper_ci"],
          rowCount: rows.length,
        },
        memorySlots: {
          forecast_method: result.method,
          forecast_horizon: String(horizon),
          forecast_r2: result.trendR2.toFixed(3),
          ...(result.seasonalPeriod
            ? { forecast_seasonal_period: String(result.seasonalPeriod) }
            : {}),
        },
      };
    },
    {
      description:
        "Forecast a numeric series N periods into the future. Use for 'predict next quarter', 'where will revenue be in 6 months', 'project sales through year-end'. Linear-trend + auto-detected seasonal pattern with 95% confidence intervals. Gated by FORECAST_ENABLED=true (disabled by default; surfaces a clear off-message when called while disabled). For categorical breakdowns (forecast by region), the caller should pre-filter via execute_query_plan to one segment per call.",
      argsHelp:
        '{"timeColumn": string, "valueColumn": string, "granularity"?: "month"|"quarter"|"year", "horizon"?: number, "seasonality"?: "auto"|"none"|4|7|12|52}',
    }
  );
}
