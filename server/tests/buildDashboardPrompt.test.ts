import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ChartSpec } from "../shared/schema.js";
import {
  buildDashboardSystemPrompt,
  buildDashboardUserPrompt,
} from "../lib/agents/runtime/buildDashboardPrompt.js";

const chart = (title: string): ChartSpec =>
  ({
    type: "bar",
    title,
    x: "Region",
    y: "Sales_sum",
  }) as unknown as ChartSpec;

describe("buildDashboard prompts — cohesion contract", () => {
  it("system prompt forbids the 'How to read this dashboard', 'Methodology', and 'Original question' boilerplate tiles", () => {
    const sys = buildDashboardSystemPrompt();
    assert.ok(/do not emit/i.test(sys), "must contain a 'Do NOT emit' clause");
    assert.ok(sys.includes('"Methodology"'), "must reference Methodology by name");
    assert.ok(
      sys.includes('"How to read this'),
      "must reference How to read this dashboard by name"
    );
    assert.ok(
      sys.includes('"Original question"'),
      "must reference Original question by name"
    );
  });

  it("system prompt requires the Summary narrative to NAME each chart by title", () => {
    const sys = buildDashboardSystemPrompt();
    assert.ok(
      /NAME each .*chart by its title/i.test(sys) ||
        /reference these EXACT titles/i.test(sys) ||
        /name(ing)? the chart's title/i.test(sys),
      "system prompt must require each chart to be referenced by title"
    );
  });

  it("system prompt requires recommendations to cite chart-title or magnitude evidence", () => {
    const sys = buildDashboardSystemPrompt();
    assert.ok(
      /MUST cite either a chart title or a magnitude/i.test(sys),
      "system prompt must require recommendations to cite their evidence"
    );
  });

  it("user prompt includes intermediate analytical findings when provided", () => {
    const user = buildDashboardUserPrompt({
      question: "make me a dashboard for sales",
      answerBody: "Sales rose 18% in Q3.",
      charts: [chart("Monthly sales trend"), chart("Sales by region")],
      intermediateSummaries: [
        "execute_query_plan: monthly sums computed; 12 rows",
        "build_chart: line chart compiled on Month · Order Date / Sales_sum",
      ],
    });
    assert.ok(
      user.includes("Intermediate analytical findings"),
      "user prompt must include the intermediate-findings header when summaries are passed"
    );
    assert.ok(
      user.includes("execute_query_plan"),
      "user prompt must surface the planner's tool summaries verbatim"
    );
  });

  it("user prompt omits the intermediate block when no summaries are passed", () => {
    const user = buildDashboardUserPrompt({
      question: "make me a dashboard",
      answerBody: "answer",
      charts: [chart("Sales by region")],
    });
    assert.ok(
      !user.includes("Intermediate analytical findings"),
      "user prompt must not synthesize an empty intermediate-findings block"
    );
  });

  it("user prompt instructs the LLM to reference chart titles verbatim", () => {
    const user = buildDashboardUserPrompt({
      question: "q",
      answerBody: "a",
      charts: [chart("Sales by region")],
    });
    assert.ok(
      user.includes("EXACT titles"),
      "user prompt must remind the LLM to use exact chart titles in the narrative"
    );
    assert.ok(
      user.includes("Sales by region"),
      "user prompt must list the chart titles for the LLM to reference"
    );
  });
});
