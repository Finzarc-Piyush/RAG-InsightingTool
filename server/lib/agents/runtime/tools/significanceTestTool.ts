/**
 * Wave F3 · run_significance_test tool.
 *
 * Answers "is the difference real or noise?" for three common shapes:
 *
 *   - **welch_t**: two unpaired groups → "is conversion rate higher in
 *     metro stores than rural?". Caller passes the column + dimension
 *     filters for each group.
 *
 *   - **paired_t**: paired observations → "did revenue per store improve
 *     after the redesign?". Caller passes two columns of equal length.
 *
 *   - **chi_square**: contingency table → "do product preferences differ
 *     across customer segments?". Caller passes a precomputed 2D table.
 *
 * Gated by `SIGNIFICANCE_TESTS_ENABLED=true`. Tool registered
 * unconditionally so the planner sees it; off-message inside the body
 * when the flag is unset.
 */
import { z } from "zod";
import type { ToolRegistry, ToolRunContext } from "../toolRegistry.js";
import { runSignificanceTest } from "../../../significanceTests.js";
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

export const significanceTestArgsSchema = z.discriminatedUnion("test", [
  z
    .object({
      test: z.literal("welch_t"),
      valueColumn: z.string().min(1).max(200),
      groupAFilters: z.array(dimensionFilterSchema).min(1).max(12),
      groupBFilters: z.array(dimensionFilterSchema).min(1).max(12),
      alpha: z.number().min(0.001).max(0.5).optional(),
    })
    .strict(),
  z
    .object({
      test: z.literal("paired_t"),
      columnA: z.string().min(1).max(200),
      columnB: z.string().min(1).max(200),
      dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
      alpha: z.number().min(0.001).max(0.5).optional(),
    })
    .strict(),
  z
    .object({
      test: z.literal("chi_square"),
      /** Pre-computed 2D contingency table. */
      contingencyTable: z.array(z.array(z.number())).min(2),
      alpha: z.number().min(0.001).max(0.5).optional(),
    })
    .strict(),
]);

export function registerSignificanceTestTool(registry: ToolRegistry) {
  registry.register(
    "run_significance_test",
    significanceTestArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx: ToolRunContext, args: Record<string, unknown>) => {
      if (process.env.SIGNIFICANCE_TESTS_ENABLED !== "true") {
        return {
          ok: false,
          summary:
            "run_significance_test is disabled (SIGNIFICANCE_TESTS_ENABLED is not 'true'). Enable in server.env to activate statistical tests.",
        };
      }
      if (ctx.exec.mode !== "analysis") {
        return {
          ok: false,
          summary: "run_significance_test is only available in analysis mode.",
        };
      }
      const parsed = significanceTestArgsSchema.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          summary: `Invalid args for run_significance_test: ${parsed.error.message}`,
        };
      }
      const allow = new Set(ctx.exec.summary.columns.map((c) => c.name));
      const base =
        ctx.exec.turnStartDataRef && ctx.exec.turnStartDataRef.length > 0
          ? ctx.exec.turnStartDataRef
          : ctx.exec.data;

      if (parsed.data.test === "welch_t") {
        const { valueColumn, groupAFilters, groupBFilters, alpha } =
          parsed.data;
        if (!allow.has(valueColumn)) {
          return {
            ok: false,
            summary: `valueColumn '${valueColumn}' not in schema.`,
          };
        }
        const a = filterRowsByDimensionFilters(
          base as Record<string, any>[],
          groupAFilters as DimensionFilter[]
        );
        const b = filterRowsByDimensionFilters(
          base as Record<string, any>[],
          groupBFilters as DimensionFilter[]
        );
        const sampleA = (a as Record<string, unknown>[])
          .map((r) => Number(r[valueColumn]))
          .filter((v) => Number.isFinite(v));
        const sampleB = (b as Record<string, unknown>[])
          .map((r) => Number(r[valueColumn]))
          .filter((v) => Number.isFinite(v));
        const result = runSignificanceTest({
          test: "welch_t",
          sampleA,
          sampleB,
          alpha,
        });
        if (!result.ok) {
          return { ok: false, summary: `run_significance_test: ${result.error}` };
        }
        return {
          ok: true,
          summary: result.interpretation,
          table: {
            rows: [
              {
                test: "welch_t",
                t_statistic: Math.round(result.statistic * 1000) / 1000,
                p_value: Math.round(result.pValue * 10000) / 10000,
                df: Math.round(result.df * 10) / 10,
                cohen_d: Math.round(result.effectSize.value * 1000) / 1000,
                effect_magnitude: result.effectSize.magnitude,
                significant: result.significant,
                n_a: result.n.sampleA,
                n_b: result.n.sampleB,
              },
            ],
            columns: [
              "test",
              "t_statistic",
              "p_value",
              "df",
              "cohen_d",
              "effect_magnitude",
              "significant",
              "n_a",
              "n_b",
            ],
            rowCount: 1,
          },
          memorySlots: {
            sig_test_result: result.significant ? "significant" : "not_significant",
            sig_test_p_value: result.pValue.toFixed(4),
            sig_test_effect: result.effectSize.magnitude,
          },
        };
      }

      if (parsed.data.test === "paired_t") {
        const { columnA, columnB, dimensionFilters, alpha } = parsed.data;
        if (!allow.has(columnA) || !allow.has(columnB)) {
          return {
            ok: false,
            summary: `columnA and columnB must be in schema. Got ${columnA}, ${columnB}.`,
          };
        }
        let frame = base;
        if (dimensionFilters?.length) {
          frame = filterRowsByDimensionFilters(
            frame as Record<string, any>[],
            dimensionFilters as DimensionFilter[]
          );
        }
        const sampleA: number[] = [];
        const sampleB: number[] = [];
        for (const row of frame as Record<string, unknown>[]) {
          const va = Number(row[columnA]);
          const vb = Number(row[columnB]);
          if (Number.isFinite(va) && Number.isFinite(vb)) {
            sampleA.push(va);
            sampleB.push(vb);
          }
        }
        const result = runSignificanceTest({
          test: "paired_t",
          sampleA,
          sampleB,
          alpha,
        });
        if (!result.ok) {
          return { ok: false, summary: `run_significance_test: ${result.error}` };
        }
        return {
          ok: true,
          summary: result.interpretation,
          table: {
            rows: [
              {
                test: "paired_t",
                t_statistic: Math.round(result.statistic * 1000) / 1000,
                p_value: Math.round(result.pValue * 10000) / 10000,
                df: result.df,
                cohen_d: Math.round(result.effectSize.value * 1000) / 1000,
                effect_magnitude: result.effectSize.magnitude,
                significant: result.significant,
                n_pairs: result.n.sampleA,
              },
            ],
            columns: [
              "test",
              "t_statistic",
              "p_value",
              "df",
              "cohen_d",
              "effect_magnitude",
              "significant",
              "n_pairs",
            ],
            rowCount: 1,
          },
          memorySlots: {
            sig_test_result: result.significant ? "significant" : "not_significant",
            sig_test_p_value: result.pValue.toFixed(4),
            sig_test_effect: result.effectSize.magnitude,
          },
        };
      }

      // chi_square
      const { contingencyTable, alpha } = parsed.data;
      const result = runSignificanceTest({
        test: "chi_square",
        contingencyTable,
        alpha,
      });
      if (!result.ok) {
        return { ok: false, summary: `run_significance_test: ${result.error}` };
      }
      return {
        ok: true,
        summary: result.interpretation,
        table: {
          rows: [
            {
              test: "chi_square",
              chi2_statistic: Math.round(result.statistic * 1000) / 1000,
              p_value: Math.round(result.pValue * 10000) / 10000,
              df: result.df,
              cramers_v: Math.round(result.effectSize.value * 1000) / 1000,
              effect_magnitude: result.effectSize.magnitude,
              significant: result.significant,
              n_total: result.n.sampleA,
            },
          ],
          columns: [
            "test",
            "chi2_statistic",
            "p_value",
            "df",
            "cramers_v",
            "effect_magnitude",
            "significant",
            "n_total",
          ],
          rowCount: 1,
        },
        memorySlots: {
          sig_test_result: result.significant ? "significant" : "not_significant",
          sig_test_p_value: result.pValue.toFixed(4),
          sig_test_effect: result.effectSize.magnitude,
        },
      };
    },
    {
      description:
        "Statistical significance test for analytical claims. Use for 'is the difference between A and B significant?', 'did the Q3 drop persist into Q4 significantly?', 'do customer segments differ in product preference?'. Three test shapes: welch_t (two unpaired groups), paired_t (paired observations), chi_square (contingency table). Returns p-value + effect-size magnitude + interpretation. Gated by SIGNIFICANCE_TESTS_ENABLED=true.",
      argsHelp:
        '{"test": "welch_t", "valueColumn": string, "groupAFilters": [...], "groupBFilters": [...]} OR {"test": "paired_t", "columnA", "columnB", "dimensionFilters"?: [...]} OR {"test": "chi_square", "contingencyTable": [[..], [..]]}',
    }
  );
}
