import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPeriodFromQuery } from "../lib/dateUtils.js";
import { patchExecuteQueryPlanDateAggregation } from "../lib/queryPlanTemporalPatch.js";
import type { PlanStep } from "../lib/agents/runtime/types.js";
import { processChartData } from "../lib/chartGenerator.js";
import { summarizeContextForPrompt } from "../lib/agents/runtime/context.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

describe("detectPeriodFromQuery", () => {
  it("maps over the years / yearly phrasing to year", () => {
    assert.equal(detectPeriodFromQuery("sales trend over the years"), "year");
    assert.equal(detectPeriodFromQuery("yearly revenue"), "year");
    assert.equal(detectPeriodFromQuery("annual report"), "year");
  });

  it("prefers month before year when monthly appears", () => {
    assert.equal(detectPeriodFromQuery("monthly trend over 5 years"), "month");
  });

  it("maps daily phrasing to day", () => {
    assert.equal(detectPeriodFromQuery("sales by day"), "day");
    assert.equal(detectPeriodFromQuery("daily average"), "day");
  });
});

describe("patchExecuteQueryPlanDateAggregation", () => {
  it("sets dateAggregationPeriod from question when missing and groupBy uses a date column", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Order Date"],
          aggregations: [{ column: "Sales", operation: "sum", alias: "t" }],
        },
      },
    };
    patchExecuteQueryPlanDateAggregation(step, "revenue over the years", ["Order Date"]);
    const plan = step.args.plan as Record<string, unknown>;
    assert.equal(plan.dateAggregationPeriod, "year");
  });

  it("does not overwrite an explicit dateAggregationPeriod", () => {
    const step: PlanStep = {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Order Date"],
          dateAggregationPeriod: "month",
          aggregations: [],
        },
      },
    };
    patchExecuteQueryPlanDateAggregation(step, "revenue over the years", ["Order Date"]);
    const plan = step.args.plan as Record<string, unknown>;
    assert.equal(plan.dateAggregationPeriod, "month");
  });
});

describe("summarizeContextForPrompt temporal intent", () => {
  it("includes Temporal intent when detectPeriodFromQuery matches", () => {
    const summary: DataSummary = {
      rowCount: 1,
      columnCount: 1,
      columns: [{ name: "Order Date", type: "date", sampleValues: [] }],
      numericColumns: [],
      dateColumns: ["Order Date"],
    };
    const ctx = {
      sessionId: "s1",
      question: "How did sales change over the years?",
      data: [],
      summary,
      chatHistory: [],
      mode: "analysis" as const,
    } satisfies AgentExecutionContext;

    const text = summarizeContextForPrompt(ctx);
    assert.match(text, /Temporal intent from question: use dateAggregationPeriod=year/i);
  });
});

describe("processChartData year bucketing", () => {
  const lineSpec = {
    type: "line" as const,
    title: "Sales",
    x: "Order Date",
    y: "Sales",
    aggregate: "none" as const,
  };

  function multiYearDailyIsoRows(): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    for (let y = 2020; y <= 2022; y++) {
      const start = Date.UTC(y, 0, 1);
      const end = Date.UTC(y + 1, 0, 1);
      for (let t = start; t < end; t += 86400000) {
        const d = new Date(t);
        rows.push({
          "Order Date": d.toISOString().slice(0, 10),
          Sales: 1,
        });
      }
    }
    return rows;
  }

  it("buckets multi-year ISO string dates to a small number of year points (not one per day)", () => {
    const data = multiYearDailyIsoRows();
    assert.ok(data.length > 1000);
    const out = processChartData(data, lineSpec, ["Order Date"], {
      chartQuestion: "trend over the years",
    });
    assert.equal(out.length, 3);
    const xs = out.map((r) => String(r["Order Date"])).sort();
    assert.deepEqual(xs, ["2020", "2021", "2022"]);
    const leap2020 = 366;
    const y2021 = 365;
    const y2022 = 365;
    const byYear = Object.fromEntries(out.map((r) => [String(r["Order Date"]), r.Sales as number]));
    assert.equal(byYear["2020"], leap2020);
    assert.equal(byYear["2021"], y2021);
    assert.equal(byYear["2022"], y2022);
  });

  it("uses question hint to bucket by year even when span is short", () => {
    const rows: Record<string, unknown>[] = [];
    for (let d = 1; d <= 30; d++) {
      rows.push({
        "Order Date": `2024-01-${String(d).padStart(2, "0")}`,
        Sales: 1,
      });
    }
    const out = processChartData(rows, lineSpec, ["Order Date"], {
      chartQuestion: "yearly revenue snapshot",
    });
    assert.equal(out.length, 1);
    assert.equal(String(out[0]!["Order Date"]), "2024");
    assert.equal(out[0]!.Sales, 30);
  });
});
