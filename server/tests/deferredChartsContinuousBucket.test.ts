import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeDeferredBuildCharts } from "../lib/agents/runtime/agentLoopDeferredCharts.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { ChartSpec, DataSummary } from "../shared/schema.js";

function clock(secondsOfDay: number): string {
  const h = Math.floor(secondsOfDay / 3600);
  const m = Math.floor((secondsOfDay % 3600) / 60);
  const s = secondsOfDay % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function makeCtx(data: Record<string, unknown>[]): AgentExecutionContext {
  const summary: DataSummary = {
    rowCount: data.length,
    columnCount: 2,
    columns: [
      { name: "Clock-In Time", type: "string", sampleValues: [], timeOfDay: {} },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: [],
  } as unknown as DataSummary;
  return {
    sessionId: "s",
    question: "compliance by clock-in time",
    data: data as Record<string, any>[],
    summary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

// The deferred build_chart path (materializeDeferredBuildCharts) is the most self-contained
// of the B5-wired LLM/explicit builders; visualPlanner and build_chart reuse the identical
// bucketContinuousXForSpec one-liner, guarded on spec.type === "bar".
test("deferred build_chart: per-second Clock-In Time bar is binned to hour-of-day bands", () => {
  const data = Array.from({ length: 240 }, (_, i) => ({
    "Clock-In Time": clock(8 * 3600 + i * 60), // 08:00 … 11:59, all distinct
    "Compliance Visit": 40 + (i % 50),
  }));
  const ctx = makeCtx(data);
  const merged: ChartSpec[] = [];
  materializeDeferredBuildCharts(
    ctx,
    [
      {
        type: "bar",
        title: "Compliance Visit by Clock-In Time",
        x: "Clock-In Time",
        y: "Compliance Visit",
        aggregate: "mean",
      },
    ],
    merged,
  );
  assert.equal(merged.length, 1, "one chart materialized");
  const xs = (merged[0]!.data as Record<string, unknown>[]).map((r) => String(r["Clock-In Time"]));
  assert.ok(xs.length >= 3 && xs.length <= 24, `bucketed to ${xs.length} bars`);
  for (const x of xs) assert.match(x, /^\d\d:\d\d–\d\d:\d\d$/, `bucket label: ${x}`);
});
