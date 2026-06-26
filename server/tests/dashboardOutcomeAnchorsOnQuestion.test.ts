/**
 * Dashboards must follow the metric the user NAMED, not a column-order default.
 *
 * Wave 1 — `ensureDashboardOutcomeMetric` / `resolveBreadthOutcomeMetric` anchor
 *   the outcome on the question (via `findMetricMentionedInQuestion`) so a "PJP
 *   dashboard" picks the PJP column even when a "Compliance" column sorts first,
 *   and even when an LLM brief mis-extracted an unrelated metric.
 * Wave 2 — `ensureDashboardOutlineMetrics` only fans out to OTHER indicators for
 *   a BROAD, un-named dashboard; a pointed "PJP dashboard" stays single-anchor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureDashboardOutcomeMetric,
} from "../lib/agents/runtime/analysisBrief.js";
import { resolveBreadthOutcomeMetric } from "../lib/agents/runtime/dashboardFeatureSweep.js";
import { findMetricMentionedInQuestion } from "../lib/agents/utils/columnMatcher.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { AnalysisBrief, DataSummary } from "../shared/schema.js";

type Col = DataSummary["columns"][number];

function numCol(name: string): Col {
  return { name, type: "number", sampleValues: [1, 2] } as Col;
}
function boolCol(name: string, pos = "Yes", neg = "No"): Col {
  return {
    name,
    type: "string",
    sampleValues: [pos],
    indicator: {
      kind: "boolean",
      positiveValues: [pos],
      negativeValues: [neg],
      sentinelValues: [],
      source: "auto",
    },
  } as Col;
}

function ctxOf(question: string, cols: Col[]): AgentExecutionContext {
  return {
    question,
    summary: {
      rowCount: 100,
      columnCount: cols.length,
      columns: cols,
      numericColumns: cols.filter((c) => c.type === "number").map((c) => c.name),
      dateColumns: cols.filter((c) => c.type === "date").map((c) => c.name),
    },
  } as unknown as AgentExecutionContext;
}

const brief = (over: Partial<AnalysisBrief> = {}): AnalysisBrief =>
  ({ version: 1, requestsDashboard: true, ...over }) as AnalysisBrief;

describe("findMetricMentionedInQuestion", () => {
  it("matches the named metric and ignores a first-sorting unrelated one", () => {
    assert.strictEqual(
      findMetricMentionedInQuestion("build a PJP dashboard", [
        "Compliance Visit",
        "PJP Adherence",
      ]),
      "PJP Adherence"
    );
  });
  it("returns null for a broad request that names no metric", () => {
    assert.strictEqual(
      findMetricMentionedInQuestion("build me a dashboard", ["Sales", "PJP Adherence"]),
      null
    );
  });
  it("does not treat temporal words as a metric mention", () => {
    // "Time to Resolution" shares only the temporal stopword 'time' with the Q.
    assert.strictEqual(
      findMetricMentionedInQuestion("show sales over time", ["Time to Resolution"]),
      null
    );
  });
});

describe("Wave 1 · ensureDashboardOutcomeMetric anchors on the question", () => {
  it("picks the NAMED indicator over one that sorts first (empty brief)", () => {
    const ctx = ctxOf("build a PJP dashboard", [
      boolCol("Compliance Visit"),
      boolCol("PJP Adherence"),
      { name: "Region", type: "string", sampleValues: ["West"] } as Col,
    ]);
    const out = ensureDashboardOutcomeMetric(brief(), ctx);
    assert.strictEqual(out.outcomeMetricColumn, "PJP Adherence");
  });

  it("picks the NAMED numeric metric over a first-sorting one (empty brief)", () => {
    const ctx = ctxOf("show me a PJP dashboard", [
      numCol("Compliance Rate"),
      numCol("PJP Adherence Rate"),
    ]);
    const out = ensureDashboardOutcomeMetric(brief(), ctx);
    assert.strictEqual(out.outcomeMetricColumn, "PJP Adherence Rate");
  });

  it("overrides a brief that mis-extracted a metric the user never named", () => {
    const ctx = ctxOf("build a PJP dashboard", [
      boolCol("Compliance Visit"),
      boolCol("PJP Adherence"),
    ]);
    const out = ensureDashboardOutcomeMetric(
      brief({ outcomeMetricColumn: "Compliance Visit" }),
      ctx
    );
    assert.strictEqual(out.outcomeMetricColumn, "PJP Adherence");
  });

  it("does NOT override a brief whose metric the user actually named", () => {
    const ctx = ctxOf("build a compliance dashboard", [
      boolCol("Compliance Visit"),
      boolCol("PJP Adherence"),
    ]);
    const out = ensureDashboardOutcomeMetric(
      brief({ outcomeMetricColumn: "Compliance Visit" }),
      ctx
    );
    assert.strictEqual(out.outcomeMetricColumn, "Compliance Visit");
  });

  it("broad request still falls back to the first numeric measure", () => {
    const ctx = ctxOf("build me a dashboard", [
      numCol("Sales"),
      { name: "Region", type: "string", sampleValues: ["West"] } as Col,
    ]);
    const out = ensureDashboardOutcomeMetric(brief(), ctx);
    assert.strictEqual(out.outcomeMetricColumn, "Sales");
  });
});

describe("Wave 1 · resolveBreadthOutcomeMetric anchors on the question", () => {
  it("prefers the named numeric metric over the rate-regex last resort", () => {
    const ctx = ctxOf("how is PJP doing?", [
      numCol("compliance_rate"),
      numCol("pjp_adherence_rate"),
    ]);
    assert.strictEqual(resolveBreadthOutcomeMetric(ctx, []), "pjp_adherence_rate");
  });
});

describe("Wave 2 · ensureDashboardOutlineMetrics stays pointed when a metric is named", () => {
  const cols = [
    boolCol("PJP Adherence"),
    boolCol("Compliance Visit"),
    boolCol("Attendance Status", "Present", "Absent"),
  ];

  it("a pointed 'PJP dashboard' seeds NO unrelated secondary indicators", () => {
    const ctx = ctxOf("build a PJP dashboard", cols);
    const out = ensureDashboardOutcomeMetric(brief(), ctx);
    assert.strictEqual(out.outcomeMetricColumn, "PJP Adherence");
    assert.strictEqual(out.outlineMetrics, undefined);
  });

  it("a multi-named ask keeps both named metrics but excludes the unnamed one", () => {
    const ctx = ctxOf("PJP and attendance dashboard", cols);
    const out = ensureDashboardOutcomeMetric(brief(), ctx);
    const involved = [out.outcomeMetricColumn, ...(out.outlineMetrics ?? [])];
    assert.ok(involved.includes("PJP Adherence"));
    assert.ok(involved.includes("Attendance Status"));
    assert.ok(!involved.includes("Compliance Visit"), "Compliance was never named");
  });

  it("a BROAD 'build a dashboard' still fans out to every other indicator", () => {
    const ctx = ctxOf("build me a dashboard", cols);
    const out = ensureDashboardOutcomeMetric(brief(), ctx);
    // Anchor is the first indicator; the rest become multi-KPI secondaries.
    assert.strictEqual(out.outcomeMetricColumn, "PJP Adherence");
    assert.deepStrictEqual(
      (out.outlineMetrics ?? []).slice().sort(),
      ["Attendance Status", "Compliance Visit"]
    );
  });
});
