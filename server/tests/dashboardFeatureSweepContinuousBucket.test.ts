import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateMissingDashboardCharts } from "../lib/agents/runtime/dashboardFeatureSweep.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";

const DASH = "–";

function clock(secondsOfDay: number): string {
  const h = Math.floor(secondsOfDay / 3600);
  const m = Math.floor((secondsOfDay % 3600) / 60);
  const s = secondsOfDay % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function makeCtx(
  data: Record<string, unknown>[],
  columns: DataSummary["columns"],
  numericColumns: string[],
  brief: Partial<AnalysisBrief>,
): AgentExecutionContext {
  const summary: DataSummary = {
    rowCount: data.length,
    columnCount: columns.length,
    columns,
    numericColumns,
    dateColumns: [],
  } as unknown as DataSummary;
  return {
    sessionId: "s",
    question: "build a compliance dashboard",
    data: data as Record<string, any>[],
    turnStartDataRef: data as Record<string, any>[],
    analysisBrief: { version: 1, clarifyingQuestions: [], epistemicNotes: [], ...brief } as AnalysisBrief,
    summary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

test("feature sweep: per-second Clock-In Time driver dim → hour-of-day bar", () => {
  // 240 distinct per-second clock-ins spread across 08:00–11:59.
  const data = Array.from({ length: 240 }, (_, i) => ({
    "Clock-In Time": clock(8 * 3600 + i * 60),
    "Compliance Visit": 40 + (i % 50),
  }));
  const ctx = makeCtx(
    data,
    [
      { name: "Clock-In Time", type: "string", sampleValues: [], timeOfDay: {} },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ] as never,
    ["Compliance Visit"],
    { requestsDashboard: true, outcomeMetricColumn: "Compliance Visit", candidateDriverDimensions: ["Clock-In Time"] },
  );

  const charts = enumerateMissingDashboardCharts(ctx, []);
  const chart = charts.find((c) => c.x === "Clock-In Time");
  assert.ok(chart, "a Clock-In Time chart was produced");
  assert.equal(chart!.type, "bar");
  const xs = (chart!.data as Record<string, unknown>[]).map((r) => String(r["Clock-In Time"]));
  assert.ok(xs.length >= 3 && xs.length <= 24, `bucketed to ${xs.length} bars`);
  for (const x of xs) assert.match(x, /^\d\d:\d\d–\d\d:\d\d$/, `bucket label: ${x}`);
});

test("feature sweep: high-cardinality Working Hrs duration dim is BINNED, not skipped", () => {
  // 600 distinct durations (3h..~13h) → exceeds MEDIUM_CARDINALITY_MAX (500). Without
  // continuous bucketing this dim is hard-skipped; with it, it becomes a duration-range bar.
  const data = Array.from({ length: 600 }, (_, i) => ({
    "Working Hrs": 3 + i * (10 / 600), // 3.00 .. 12.98, all distinct
    "Compliance Visit": 40 + (i % 50),
  }));
  const ctx = makeCtx(
    data,
    [
      { name: "Working Hrs", type: "number", sampleValues: [], duration: { unit: "hours", format: "hm" } },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ] as never,
    ["Working Hrs", "Compliance Visit"],
    { requestsDashboard: true, outcomeMetricColumn: "Compliance Visit", candidateDriverDimensions: ["Working Hrs"] },
  );

  const charts = enumerateMissingDashboardCharts(ctx, []);
  const chart = charts.find((c) => c.x === "Working Hrs");
  assert.ok(chart, "Working Hrs chart NOT skipped as high-cardinality");
  assert.equal(chart!.type, "bar");
  const xs = (chart!.data as Record<string, unknown>[]).map((r) => String(r["Working Hrs"]));
  assert.ok(xs.length >= 3 && xs.length <= 24, `bucketed to ${xs.length} duration ranges`);
  for (const x of xs) assert.match(x, /h–\d/, `duration range label: ${x}`);
  assert.equal(xs[0], `3h${DASH}4h`);
});
