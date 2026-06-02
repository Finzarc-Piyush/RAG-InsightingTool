/**
 * ============================================================================
 * anomalyDetectionTool.ts — the "detect_anomalies" analytical tool
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines a tool the AI agent can call to find unusual values ("outliers")
 *   in one numeric column of the uploaded dataset — e.g. a sales week that is
 *   way higher or lower than normal. It uses two classic statistics tricks:
 *     • IQR (Inter-Quartile Range): sort the numbers, look at the middle 50%,
 *       and flag anything far outside that band. The "1.5×" multiplier
 *       (Tukey's fence) is the textbook default.
 *     • z-score: how many standard deviations a value sits from the average;
 *       big z-score = far from typical.
 *   "both" flags anything either test catches. Each flagged row gets a
 *   "severity" so the most extreme outliers sort to the top. This all runs in
 *   plain Node.js (no call out to the Python service), so it is fast.
 *
 * WHY IT MATTERS
 *   Spotting spikes and dips is a core analytical question ("which weeks were
 *   unusual?"). Returning severity-ranked rows lets the answer-writer say
 *   things like "Q3 2024 sales spike (3.2x the median)" directly.
 *
 * KEY PIECES
 *   - anomalyDetectionArgsSchema — Zod schema validating the tool's arguments
 *     (which column, which test, thresholds, optional row filters, how many to
 *     return).
 *   - registerAnomalyDetectionTool — registers the tool under the name
 *     "detect_anomalies" so the agent's plan/act loop can invoke it.
 *
 * HOW IT CONNECTS
 *   Registered into the shared ToolRegistry (../toolRegistry.js) via
 *   registerTools.ts. The heavy lifting lives in ../../../anomalyDetection.js
 *   (detectAnomalies). Optional row pre-filtering uses
 *   filterRowsByDimensionFilters from ../../../dataTransform.js.
 *
 * NOTE ON THE FEATURE GATE
 *   Controlled by env var ANOMALY_DETECTION_ENABLED=true. The tool is ALWAYS
 *   registered (so the planner can see it exists), but the body returns an
 *   "off" message when the flag is not set — same pattern as web_search and
 *   run_forecast.
 */
import { z } from "zod";
import type { ToolRegistry, ToolRunContext } from "../toolRegistry.js";
import { detectAnomalies } from "../../../anomalyDetection.js";
import type { DimensionFilter } from "../../../../shared/queryTypes.js";
import { filterRowsByDimensionFilters } from "../../../dataTransform.js";

const dimensionFilterSchema = z
  .object({
    column: z.string(),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

export const anomalyDetectionArgsSchema = z
  .object({
    valueColumn: z.string().min(1).max(200),
    /** Optional time / segment column. When set, each row's label is the value of this column. */
    labelColumn: z.string().min(1).max(200).optional(),
    /** Statistical test. "both" flags the union of IQR and z-score outliers. */
    method: z.enum(["iqr", "zscore", "both"]).default("both"),
    /** IQR multiplier (default 1.5 — Tukey's classic). */
    iqrK: z.number().min(0.5).max(5).optional(),
    /** Z-score threshold (default 2.5). */
    zK: z.number().min(1).max(5).optional(),
    /** Optional row-level filters applied before scanning. */
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
    /** Cap the number of anomalies returned (default 20, severity-sorted). */
    topN: z.number().int().min(1).max(200).default(20),
  })
  .strict();

export function registerAnomalyDetectionTool(registry: ToolRegistry) {
  registry.register(
    "detect_anomalies",
    anomalyDetectionArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (process.env.ANOMALY_DETECTION_ENABLED !== "true") {
        return {
          ok: false,
          summary:
            "detect_anomalies is disabled (ANOMALY_DETECTION_ENABLED is not 'true'). Enable in server.env to activate anomaly detection.",
        };
      }
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "detect_anomalies is only available in analysis mode.",
        };
      }
      const parsed = anomalyDetectionArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for detect_anomalies: ${parsed.error.message}`,
        };
      }
      const {
        valueColumn,
        labelColumn,
        method,
        iqrK,
        zK,
        dimensionFilters,
        topN,
      } = parsed.data;
      const allow = new Set(ctx.exec.summary.columns.map((c) => c.name));
      if (!allow.has(valueColumn)) {
        return {
          ok: false,
          summary: `valueColumn '${valueColumn}' not in schema.`,
        };
      }
      if (labelColumn && !allow.has(labelColumn)) {
        return {
          ok: false,
          summary: `labelColumn '${labelColumn}' not in schema.`,
        };
      }
      const base =
        ctx.exec.turnStartDataRef && ctx.exec.turnStartDataRef.length > 0
          ? ctx.exec.turnStartDataRef
          : ctx.exec.data;
      let frame = base;
      if (dimensionFilters?.length) {
        frame = filterRowsByDimensionFilters(
          frame as Record<string, any>[],
          dimensionFilters as DimensionFilter[]
        );
      }
      const values: number[] = [];
      const labels: string[] = [];
      for (const row of frame as Record<string, unknown>[]) {
        const v = Number(row[valueColumn]);
        if (!Number.isFinite(v)) continue;
        values.push(v);
        labels.push(labelColumn ? String(row[labelColumn] ?? "") : "");
      }
      const result = detectAnomalies({ values, labels, method, iqrK, zK });
      if (!result.ok) {
        return {
          ok: false,
          summary: `detect_anomalies: ${result.error}`,
        };
      }
      const top = result.anomalies.slice(0, topN);
      const rows = top.map((a) => ({
        ...(a.label ? { [labelColumn || "label"]: a.label } : {}),
        index: a.index,
        value: a.value,
        direction: a.direction,
        flagged_by: a.flaggedBy.join("+"),
        severity: Math.round(a.severity * 100) / 100,
      }));
      const sample = JSON.stringify(rows.slice(0, 10), null, 2);
      return {
        ok: true,
        summary: `detect_anomalies: ${result.anomalies.length} outliers (method=${method}) over ${result.stats.n} obs. Median=${result.stats.median.toFixed(2)}, IQR=${result.stats.iqr.toFixed(2)}, upper-fence=${result.stats.upperBoundIqr.toFixed(2)}, lower-fence=${result.stats.lowerBoundIqr.toFixed(2)}.\n${sample.slice(0, 4000)}`,
        table: {
          rows,
          columns:
            rows[0] !== undefined ? Object.keys(rows[0]) : ["value", "severity"],
          rowCount: rows.length,
        },
        memorySlots: {
          anomaly_count: String(result.anomalies.length),
          anomaly_method: method,
          anomaly_median: result.stats.median.toFixed(2),
        },
      };
    },
    {
      description:
        "Flag unusual / outlier observations in a numeric column. Use for 'which weeks had unusual spikes', 'any anomalies in last quarter', 'where are the outliers in price'. IQR + z-score; returns severity-ranked rows with the triggering method (iqr / zscore / both). Pair with labelColumn to get human-readable row labels (e.g. labelColumn='Week' for time-series outliers). Gated by ANOMALY_DETECTION_ENABLED=true.",
      argsHelp:
        '{"valueColumn": string, "labelColumn"?: string, "method"?: "iqr"|"zscore"|"both", "iqrK"?: number, "zK"?: number, "dimensionFilters"?: [{"column","op":"in"|"not_in","values":[]}], "topN"?: number}',
    }
  );
}
