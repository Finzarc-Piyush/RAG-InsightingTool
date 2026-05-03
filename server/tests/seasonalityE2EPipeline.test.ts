// WSE6 · End-to-end pipeline test that pins the full seasonality
// contract on a Marico-VN-style 5-year × 12-month wide-format CSV.
//
// Pipeline traversed:
//   parseFile → classifyDataset → meltDataset →
//   applyWideFormatTransformToSummary → growthAnalysisSkill.plan() →
//   detectSeasonalityTool execution → assert recurring-peak surfacing
//
// Pins:
//   (a) The wide-format CSV is detected as compound shape and melted.
//   (b) The growthAnalysis skill emits a detect_seasonality step on this
//       multi-year monthly fixture, in the same parallelGroup as
//       compute_growth (so they run concurrently).
//   (c) The detect_seasonality tool returns memorySlots with Oct/Nov/Dec
//       as the consistent peak positions and consistency 1.00 (top
//       month appeared in top-3 in every one of 5 years).
//   (d) summary line names the recurring peak window AND the
//       consistency fraction (the user's complaint: "Nov 2018 was the
//       peak" missed the Q4 pattern — assert that the framing now
//       cites multi-year recurrence, not a single-year max).
//   (e) On the parallel single-year-only fixture, the skill SKIPS the
//       seasonality step (insufficient temporal coverage).
//   (f) On a "fastest growing market" question, the skill skips
//       seasonality (rank-by-growth flow doesn't surface it).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFile, createDataSummary } from "../lib/fileParser.js";
import { classifyDataset } from "../lib/wideFormat/classifyDataset.js";
import { meltDataset } from "../lib/wideFormat/meltDataset.js";
import { applyWideFormatTransformToSummary } from "../lib/wideFormat/applyWideFormatToSummary.js";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerDetectSeasonalityTool } from "../lib/agents/runtime/tools/detectSeasonalityTool.js";
import { growthAnalysisSkill } from "../lib/agents/runtime/skills/growthAnalysis.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";

function csv(rows: string[]): Buffer {
  return Buffer.from(rows.join("\n"), "utf-8");
}

// 1 market × 5 years × 12 months × 1 metric (Value Sales) = 60 long rows.
// Q4 spike: Nov +50%, Oct/Dec +25%, others = 100.
function buildFixtureCsv(): Buffer {
  const periods: string[] = [];
  for (let yi = 0; yi < 5; yi++) {
    const yyShort = String(2018 + yi).slice(2);
    for (let m = 1; m <= 12; m++) {
      const monthAbbr = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1];
      periods.push(`${monthAbbr} ${yyShort} Value Sales`);
    }
  }
  const header = `"Markets",${periods.map((p) => `"${p}"`).join(",")}`;
  const cells: string[] = [`"VN"`];
  const spike: Record<number, number> = { 10: 1.25, 11: 1.5, 12: 1.25 };
  for (let yi = 0; yi < 5; yi++) {
    for (let m = 1; m <= 12; m++) {
      const v = (100 * (spike[m] ?? 1)).toFixed(2);
      cells.push(`"đ${v}"`);
    }
  }
  const lines = [header, cells.join(",")];
  return csv(lines);
}

function buildSingleYearCsv(): Buffer {
  const periods: string[] = [];
  for (let m = 1; m <= 12; m++) {
    const monthAbbr = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1];
    periods.push(`${monthAbbr} 24 Value Sales`);
  }
  const header = `"Markets",${periods.map((p) => `"${p}"`).join(",")}`;
  const cells: string[] = [`"VN"`];
  for (let m = 1; m <= 12; m++) cells.push(`"đ100"`);
  return csv([header, cells.join(",")]);
}

function makeCtx(
  question: string,
  data: Record<string, unknown>[],
  summary: DataSummary
): AgentExecutionContext {
  return {
    sessionId: "wse6-e2e",
    question,
    data,
    summary,
    chatHistory: [],
    mode: "analysis",
  } as unknown as AgentExecutionContext;
}

function brief(partial?: Partial<AnalysisBrief>): AnalysisBrief {
  return {
    version: 1,
    questionShape: "trend",
    outcomeMetricColumn: "Value",
    segmentationDimensions: ["Markets"],
    candidateDriverDimensions: [],
    clarifyingQuestions: [],
    epistemicNotes: [],
    ...partial,
  };
}

describe("WSE6 · golden e2e — seasonality on Marico-VN-style wide-format CSV", () => {
  it("upload pipeline detects compound shape and melts to 60 long rows", async () => {
    const buf = buildFixtureCsv();
    const wideRows = await parseFile(buf, "marico-vn-seasonal.csv");
    assert.equal(wideRows.length, 1);
    const headers = Object.keys(wideRows[0] ?? {});
    const classification = classifyDataset(headers);
    assert.equal(classification.isWide, true);
    assert.equal(classification.shape, "compound");
    const melted = meltDataset(wideRows, classification);
    assert.equal(melted.rows.length, 60);
  });

  it("growthAnalysis skill emits detect_seasonality on this fixture, in parallelGroup", async () => {
    const buf = buildFixtureCsv();
    let data = await parseFile(buf, "marico-vn-seasonal.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    });

    const plan = growthAnalysisSkill.plan(
      brief(),
      makeCtx("how is value sales trending over the years?", data, summary)
    );
    assert.ok(plan);
    const seasonality = plan!.steps.find((s) => s.tool === "detect_seasonality");
    assert.ok(seasonality, "skill must emit detect_seasonality on multi-year monthly data");
    const growth = plan!.steps.find((s) => s.tool === "compute_growth");
    assert.equal(seasonality!.parallelGroup, growth!.parallelGroup);
  });

  it("detectSeasonality returns Oct/Nov/Dec as consistent peaks (5 of 5 years) and frames the headline as recurring", async () => {
    const buf = buildFixtureCsv();
    let data = await parseFile(buf, "marico-vn-seasonal.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    });

    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx: any = {
      exec: {
        mode: "analysis",
        sessionId: "wse6",
        summary,
        data,
      },
      config: {},
    };
    const out = await reg.execute(
      "detect_seasonality",
      {
        metricColumn: "Value",
        periodIsoColumn: "PeriodIso",
        granularity: "month",
        // Compound-shape Metric guard requires this filter.
        dimensionFilters: [
          { column: "Metric", op: "in", values: ["Value Sales"] },
        ],
      },
      ctx
    );
    assert.equal(out.ok, true, `tool failed: ${out.summary}`);

    // (1) consistency = 1.00 (Nov in top-3 every year of 5)
    assert.equal(Number(out.memorySlots!.seasonality_consistency_max), 1);
    // (2) years observed = 5
    assert.equal(out.memorySlots!.seasonality_years_observed, "5");
    // (3) named peaks include Oct/Nov/Dec in some order
    const peaks = out.memorySlots!.seasonality_peak_positions;
    assert.match(peaks, /Oct/);
    assert.match(peaks, /Nov/);
    assert.match(peaks, /Dec/);
    // (4) strength is moderate or strong
    assert.match(out.memorySlots!.seasonality_strength, /moderate|strong/);
    // (5) summary line frames as recurring AND cites consistency fraction
    assert.match(out.summary, /5 of 5/, "summary must cite consistency fraction");
    // (6) summary mentions a peak month/window (not "Nov 2018")
    assert.doesNotMatch(out.summary, /\b201[89]\b|\b202[0-9]\b/, "summary must NOT pin to a specific year — that's the bug");
  });

  it("on single-year-only data the skill SKIPS the seasonality step", async () => {
    const buf = buildSingleYearCsv();
    let data = await parseFile(buf, "marico-vn-1y.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    });

    const plan = growthAnalysisSkill.plan(
      brief(),
      makeCtx("trend?", data, summary)
    );
    const seasonality = plan!.steps.find((s) => s.tool === "detect_seasonality");
    assert.equal(seasonality, undefined, "single-year data must NOT trigger seasonality");
  });

  it("on a 'fastest growing market' question the skill SKIPS seasonality", async () => {
    const buf = buildFixtureCsv();
    let data = await parseFile(buf, "marico-vn-seasonal.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    });

    const plan = growthAnalysisSkill.plan(
      brief(),
      makeCtx("which is the fastest growing market?", data, summary)
    );
    const seasonality = plan!.steps.find((s) => s.tool === "detect_seasonality");
    assert.equal(seasonality, undefined, "rank-by-growth flow must skip seasonality");
  });
});
