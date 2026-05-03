import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveChartDataRowsForEnrichment } from "../lib/chartEnrichmentRows.js";
import { validateChartProposal } from "../lib/agents/runtime/chartProposalValidation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("chart / analysis alignment", () => {
  it("validateChartProposal accepts aggregated column names when lastAnalyticalTable has them", () => {
    const ctx = {
      summary: {
        columns: [
          { name: "Order Date", type: "date" },
          { name: "Sales", type: "number" },
        ],
        numericColumns: ["Sales"],
        dateColumns: ["Order Date"],
        rowCount: 1000,
      },
      data: [],
      lastAnalyticalTable: {
        rows: [{ year: "2020", total_sales: 100 }],
        columns: ["year", "total_sales"],
      },
    } as any;

    assert.strictEqual(
      validateChartProposal(ctx, { type: "bar", x: "year", y: "total_sales" }),
      true
    );
    // Schema fallback still allows raw column names when they exist on the dataset summary.
    assert.strictEqual(
      validateChartProposal(ctx, { type: "bar", x: "Order Date", y: "Sales" }),
      true
    );
    assert.strictEqual(
      validateChartProposal(ctx, { type: "bar", x: "not_a_column", y: "total_sales" }),
      false
    );
  });

  it("resolveChartDataRowsForEnrichment does not use rawData for analytical-only charts without fallback", () => {
    const huge = Array.from({ length: 50_000 }, () => ({ a: 1 }));
    const c = {
      type: "bar" as const,
      title: "t",
      x: "year",
      y: "total_sales",
      _useAnalyticalDataOnly: true,
    };
    const rows = resolveChartDataRowsForEnrichment(c, huge, []);
    assert.strictEqual(rows.length, 0);
  });

  it("resolveChartDataRowsForEnrichment uses analytical fallback rows when present", () => {
    const huge = Array.from({ length: 10_000 }, () => ({ a: 1 }));
    const fallback = [{ year: "2020", total_sales: 42 }];
    const c = {
      type: "bar" as const,
      title: "t",
      x: "year",
      y: "total_sales",
      _useAnalyticalDataOnly: true,
      keyInsight: "x",
    };
    const rows = resolveChartDataRowsForEnrichment(c, huge, [], fallback);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual((rows[0] as any).total_sales, 42);
  });

  it("runAgentTurn runs synthesis, materializes deferred build_chart, then visual planner", () => {
    const p = join(__dirname, "../lib/agents/runtime/agentLoop.service.ts");
    const src = readFileSync(p, "utf8");
    const iSynth = src.indexOf("await synthesizeFinalAnswerEnvelope(");
    const iVisual = src.indexOf("await proposeAndBuildExtraCharts");
    const needle = "materializeDeferredBuildCharts(ctx, deferredPlanCharts, mergedCharts);";
    const matAfterSynth: number[] = [];
    let from = 0;
    while (from < src.length) {
      const i = src.indexOf(needle, from);
      if (i === -1) break;
      if (i > iSynth) matAfterSynth.push(i);
      from = i + 1;
    }
    const iMat = matAfterSynth.find((pos) => pos < iVisual);
    assert.ok(iSynth !== -1 && iVisual !== -1 && iMat !== undefined && iSynth < iMat && iMat < iVisual);
  });
});
