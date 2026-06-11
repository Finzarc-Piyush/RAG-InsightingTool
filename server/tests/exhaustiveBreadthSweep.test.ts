import { test } from "node:test";
import assert from "node:assert/strict";

import {
  enumerateMissingDashboardCharts,
  resolveBreadthOutcomeMetric,
  computeDimensionLeaders,
  isOrdinalLikeColumnName,
} from "../lib/agents/runtime/dashboardFeatureSweep.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

/**
 * Exhaustive breadth: a plain analysis turn must get one "outcome by <dim>"
 * chart for EVERY categorical column (not just the LLM brief's lists), the
 * outcome resolved deterministically (never an ordinal like "Day"), and a
 * best/worst leader pair per dimension.
 */
function makeCtx(
  data: Record<string, unknown>[],
  numericColumns: string[],
  dateColumns: string[] = []
): AgentExecutionContext {
  const colNames = Object.keys(data[0] ?? {});
  const summary: DataSummary = {
    rowCount: data.length,
    columnCount: colNames.length,
    columns: colNames.map((name) => ({
      name,
      type: numericColumns.includes(name)
        ? "number"
        : dateColumns.includes(name)
          ? "date"
          : "string",
      sampleValues: [],
    })),
    numericColumns,
    dateColumns,
  };
  return {
    sessionId: "s",
    question: "how is adherence doing?", // NOT a dashboard ask
    data: data as Record<string, any>[],
    turnStartDataRef: data as Record<string, any>[],
    analysisBrief: undefined, // plain analysis turn — no brief
    summary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

const ROWS = [
  { Cluster: "North", "Android./iOS": "iOS", "TSO_TSE Name": "A", Day: 1, pjp_adherence_rate: 0.2 },
  { Cluster: "North", "Android./iOS": "Android", "TSO_TSE Name": "B", Day: 2, pjp_adherence_rate: 0.6 },
  { Cluster: "South", "Android./iOS": "iOS", "TSO_TSE Name": "C", Day: 1, pjp_adherence_rate: 0.1 },
  { Cluster: "South", "Android./iOS": "Android", "TSO_TSE Name": "D", Day: 2, pjp_adherence_rate: 0.3 },
];

test("isOrdinalLikeColumnName flags temporal ordinals, not real dimensions", () => {
  for (const n of ["Day", "Auto- Day", "Week", "Month", "Year", "Qtr"]) {
    assert.equal(isOrdinalLikeColumnName(n), true, `${n} should be ordinal-like`);
  }
  for (const n of ["Cluster", "ASM", "Android./iOS", "pjp_adherence_rate", "TSO_TSE Name"]) {
    assert.equal(isOrdinalLikeColumnName(n), false, `${n} should NOT be ordinal-like`);
  }
});

test("resolveBreadthOutcomeMetric prefers the charted metric and never an ordinal", () => {
  const ctx = makeCtx(ROWS, ["Day", "pjp_adherence_rate"]);
  // The turn already charted the rate metric.
  const built = [{ y: "pjp_adherence_rate" }, { y: "pjp_adherence_rate" }, { y: "Day" }];
  assert.equal(resolveBreadthOutcomeMetric(ctx, built), "pjp_adherence_rate");
});

test("resolveBreadthOutcomeMetric falls back to a rate-shaped column when no charts exist", () => {
  const ctx = makeCtx(ROWS, ["Day", "pjp_adherence_rate"]);
  assert.equal(resolveBreadthOutcomeMetric(ctx, []), "pjp_adherence_rate");
});

test("resolveBreadthOutcomeMetric returns null when only ordinals are numeric", () => {
  const ctx = makeCtx(
    [{ Cluster: "N", Day: 1 }, { Cluster: "S", Day: 2 }],
    ["Day"]
  );
  assert.equal(resolveBreadthOutcomeMetric(ctx, [{ y: "Day" }]), null);
});

test("exhaustive sweep charts EVERY categorical dim with NO brief (Android/iOS not ignored)", () => {
  const ctx = makeCtx(ROWS, ["Day", "pjp_adherence_rate"]);
  const charts = enumerateMissingDashboardCharts(
    ctx,
    [],
    { maxAdds: 20, exhaustiveDimensions: true, outcomeOverride: "pjp_adherence_rate" }
  );
  const xs = new Set(charts.map((c) => c.x));
  assert.ok(xs.has("Cluster"), "Cluster charted");
  assert.ok(xs.has("Android./iOS"), "Android./iOS charted (was being ignored)");
  // The ordinal numeric "Day" is never a breakdown axis, and never the metric.
  assert.ok(!xs.has("Day"), "Day is not a dimension");
  for (const c of charts) assert.equal(c.y, "pjp_adherence_rate", "every chart breaks down the rate metric");
});

test("bucketHighCardinality surfaces a leaderboard for a high-card name column", () => {
  // 600 distinct names → above MEDIUM_CARDINALITY_MAX (500).
  const rows = Array.from({ length: 600 }, (_, i) => ({
    Name: `tse_${i}`,
    pjp_adherence_rate: (i % 10) / 10,
  }));
  const ctx = makeCtx(rows, ["pjp_adherence_rate"]);
  const report = { skippedHighCardinality: [] as any[], bucketedDimensions: [] as any[] };
  const charts = enumerateMissingDashboardCharts(
    ctx,
    [],
    { maxAdds: 5, exhaustiveDimensions: true, bucketHighCardinality: true, outcomeOverride: "pjp_adherence_rate" },
    report
  );
  assert.ok(charts.some((c) => c.x === "Name"), "high-card name column still gets a (bucketed) chart");
  assert.ok(report.bucketedDimensions.some((b) => b.dimension === "Name"), "reported as bucketed");
});

test("computeDimensionLeaders ranks best/worst by MEAN of the outcome", () => {
  const leaders = computeDimensionLeaders(ROWS, "Cluster", "pjp_adherence_rate");
  assert.ok(leaders, "leaders computed");
  // North mean = (0.2+0.6)/2 = 0.4; South mean = (0.1+0.3)/2 = 0.2.
  assert.equal(leaders!.best.key, "North");
  assert.equal(leaders!.worst.key, "South");
  assert.equal(leaders!.groupCount, 2);
});

test("computeDimensionLeaders returns null with fewer than 2 groups", () => {
  const rows = [{ X: "only", m: 1 }, { X: "only", m: 2 }];
  assert.equal(computeDimensionLeaders(rows, "X", "m"), null);
});
