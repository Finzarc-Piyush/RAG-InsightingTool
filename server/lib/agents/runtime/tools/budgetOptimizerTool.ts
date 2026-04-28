/**
 * W53 · run_budget_optimizer tool.
 *
 * Wraps the W47–W51 stack (transforms + fit + optimize + Python bridge) behind
 * a single planner-callable tool. When args are omitted the heuristic
 * tagMarketingColumns fills them — so the planner can call this tool without
 * knowing column semantics ahead of time.
 *
 * Returns:
 *   - charts:  current-vs-optimal allocation bar + per-channel response
 *              curves (with current + optimal reference lines)
 *   - insights: elasticity ranking + lift headline + caveats
 *   - operationResult: full payload for downstream tools (W54 narrator
 *              consumes this to populate answerEnvelope.recommendations)
 */
import { z } from "zod";
import type { ToolRegistry } from "../toolRegistry.js";
import {
  runBudgetRedistribute,
  type BudgetRedistributeResponse,
  type ChannelFitOut,
  type MmmFetcher,
} from "../../../dataOps/mmmService.js";
import { tagMarketingColumns } from "../../../marketingColumnTags.js";
import type { ChartSpec, Insight } from "../../../../shared/schema.js";

const argsSchema = z
  .object({
    outcomeColumn: z.string().optional(),
    spendColumns: z.array(z.string()).max(20).optional(),
    timeColumn: z.string().optional(),
    totalBudget: z.number().positive().optional(),
    perChannelBounds: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
    boundMultipliers: z.tuple([z.number(), z.number()]).optional(),
    bootstrapIters: z.number().int().min(0).max(500).optional(),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

export interface BudgetOptimizerToolDeps {
  fetcher?: MmmFetcher;
}

export function registerBudgetOptimizerTool(
  registry: ToolRegistry,
  deps: BudgetOptimizerToolDeps = {}
) {
  registry.register(
    "run_budget_optimizer",
    argsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, raw) => {
      const args = argsSchema.parse(raw) as Args;
      const summary = ctx.exec.summary;
      const data = ctx.exec.data;
      if (!data || data.length === 0) {
        return { ok: false, summary: "run_budget_optimizer: no row-level data is available." };
      }

      const tagged = tagMarketingColumns(summary);
      const spendColumns = args.spendColumns ?? tagged.spendColumns;
      const outcomeColumn = args.outcomeColumn ?? tagged.outcomeColumn;
      const timeColumn = args.timeColumn ?? tagged.timeColumn;

      if (!spendColumns || spendColumns.length === 0) {
        return {
          ok: false,
          summary:
            "run_budget_optimizer: could not identify channel-spend columns. Re-run with spendColumns: [...] explicitly.",
        };
      }
      if (!outcomeColumn) {
        return {
          ok: false,
          summary:
            "run_budget_optimizer: could not identify an outcome metric (revenue / sales / conversions). Re-run with outcomeColumn.",
        };
      }
      if (!timeColumn) {
        return {
          ok: false,
          summary:
            "run_budget_optimizer: no time column detected. Budget reallocation requires a date axis.",
        };
      }

      const allow = new Set(summary.columns.map((c) => c.name));
      for (const c of [...spendColumns, outcomeColumn, timeColumn]) {
        if (!allow.has(c)) {
          return { ok: false, summary: `run_budget_optimizer: column '${c}' not found in dataset.` };
        }
      }

      let result: BudgetRedistributeResponse;
      try {
        result = await runBudgetRedistribute(
          {
            data: data as Record<string, unknown>[],
            spendColumns,
            outcomeColumn,
            timeColumn,
            totalBudget: args.totalBudget,
            perChannelBounds: args.perChannelBounds as Record<string, [number, number]> | undefined,
            boundMultipliers: args.boundMultipliers as [number, number] | undefined,
            bootstrapIters: args.bootstrapIters ?? 50,
          },
          deps.fetcher
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, summary: `run_budget_optimizer failed: ${msg}` };
      }

      const charts: ChartSpec[] = [
        buildAllocationChart(result),
        ...result.channels.map((c) => buildResponseCurveChart(c, result.response_curves[c.name])),
      ];
      const insights = buildInsightCards(result);

      const summaryText = buildSummaryText(result);

      return {
        ok: true,
        summary: summaryText,
        charts,
        insights,
        operationResult: { kind: "budget_redistribute" as const, payload: result },
        memorySlots: {
          budget_optimizer_lift_pct: result.projected_lift_pct.toFixed(2),
          budget_optimizer_total_budget: result.total_budget_used.toFixed(0),
          budget_optimizer_top_channel: topShiftChannel(result),
        },
      };
    },
    {
      description:
        "Fit a marketing-mix model (geometric adstock + Hill saturation + ridge regression on spend × outcome × time) and run a constrained SLSQP optimizer over the fitted response surface to produce an optimal per-channel budget allocation. Returns current-vs-optimal allocation bar, per-channel response curves with reference lines at current and optimal spend, and elasticities. Trigger this when the user asks how to redistribute / reallocate / optimize their marketing budget across channels.",
      argsHelp:
        '{"outcomeColumn"?: string, "spendColumns"?: string[], "timeColumn"?: string, "totalBudget"?: number (default = sum of current spend), "perChannelBounds"?: {channel: [min, max]} (default 0.5×–2× current), "boundMultipliers"?: [low, high] (overrides per-channel default), "bootstrapIters"?: number (default 50; set 0 to skip CIs for speed)}',
    }
  );
}

function buildAllocationChart(r: BudgetRedistributeResponse): ChartSpec {
  const data: Array<Record<string, string | number | null>> = [];
  for (const ch of r.channels) {
    data.push({ channel: ch.name, scenario: "current", spend: round(ch.current_total_spend) });
    data.push({ channel: ch.name, scenario: "optimal", spend: round(ch.optimal_total_spend) });
  }
  return {
    type: "bar",
    title: "Current vs optimal budget allocation",
    x: "channel",
    y: "spend",
    seriesColumn: "scenario",
    barLayout: "grouped",
    seriesKeys: ["current", "optimal"],
    data,
    aggregate: "none",
    keyInsight: `Optimal allocation projects a ${r.projected_lift_pct.toFixed(1)}% lift in outcome.`,
    _useAnalyticalDataOnly: true,
  };
}

function buildResponseCurveChart(
  ch: ChannelFitOut,
  curve: BudgetRedistributeResponse["response_curves"][string]
): ChartSpec {
  const points = curve.x.map((x, i) => ({ spend: round(x), predicted_outcome: round(curve.y[i]) }));
  return {
    type: "line",
    title: `Response curve — ${ch.name}`,
    x: "spend",
    y: "predicted_outcome",
    data: points,
    aggregate: "none",
    keyInsight: `Elasticity ${ch.elasticity.toFixed(3)} (CI95 [${ch.elasticity_ci95[0].toFixed(3)}, ${ch.elasticity_ci95[1].toFixed(3)}]). Optimal spend: ${round(curve.optimal_x).toLocaleString()} (${signedPct(ch.delta_pct)} vs current).`,
    _useAnalyticalDataOnly: true,
    _autoLayers: [
      { type: "reference-line", on: "x", value: round(curve.current_x), label: "current" },
      { type: "reference-line", on: "x", value: round(curve.optimal_x), label: "optimal" },
    ],
  };
}

function buildInsightCards(r: BudgetRedistributeResponse): Insight[] {
  const out: Insight[] = [];
  let id = 1;
  out.push({ id: id++, text: `Projected outcome lift: ${r.projected_lift_pct.toFixed(2)}% under the SLSQP-optimal allocation, holding total budget at ${round(r.total_budget_used).toLocaleString()}.` });
  const rankedAbs = [...r.channels].sort((a, b) => Math.abs(b.elasticity) - Math.abs(a.elasticity));
  out.push({
    id: id++,
    text: `Elasticity ranking: ${rankedAbs.slice(0, 5).map((c) => `${c.name} (${c.elasticity.toFixed(3)})`).join(", ")}. Channels at the top respond most to incremental spend; those at the bottom face diminishing returns first.`,
  });
  const shifts = r.channels
    .map((c) => ({ name: c.name, delta: c.optimal_total_spend - c.current_total_spend, pct: c.delta_pct }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (shifts.length) {
    out.push({
      id: id++,
      text: `Recommended shifts: ${shifts.slice(0, 4).map((s) => `${s.name} ${signedPct(s.pct)} (${s.delta >= 0 ? "+" : "−"}${round(Math.abs(s.delta)).toLocaleString()})`).join(", ")}.`,
    });
  }
  if (r.model_caveats.length) {
    out.push({ id: id++, text: `Model caveats: ${r.model_caveats.join(", ")}.` });
  }
  if (r.fit_metrics.r_squared < 0.5) {
    out.push({
      id: id++,
      text: `Fit quality: R²=${r.fit_metrics.r_squared.toFixed(3)} on ${r.fit_metrics.n_observations} weeks — interpret reallocation as directional, not exact.`,
    });
  }
  return out;
}

function buildSummaryText(r: BudgetRedistributeResponse): string {
  const top = r.channels
    .map((c) => ({ name: c.name, pct: c.delta_pct }))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 3)
    .map((s) => `${s.name} ${signedPct(s.pct)}`)
    .join(", ");
  return [
    `run_budget_optimizer: fit R²=${r.fit_metrics.r_squared.toFixed(3)} on ${r.fit_metrics.n_observations} weekly observations.`,
    `Projected lift: ${r.projected_lift_pct.toFixed(2)}% within current bounds (converged=${r.converged}).`,
    `Top reallocation: ${top}.`,
    r.model_caveats.length ? `Caveats: ${r.model_caveats.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function topShiftChannel(r: BudgetRedistributeResponse): string {
  if (!r.channels.length) return "";
  const top = [...r.channels].sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct))[0];
  return `${top.name}:${top.delta_pct.toFixed(1)}%`;
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
function signedPct(x: number): string {
  const sign = x >= 0 ? "+" : "";
  return `${sign}${x.toFixed(1)}%`;
}
