// RNK1 · Unit tests for `extractRankingIntent` — the deterministic parser
// that turns "top N salespeople" / "who has the highest leaves" /
// "list the products" question shapes into a structured `RankingIntent`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractRankingIntent } from "../lib/agents/runtime/planArgRepairs.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  columns: [
    { name: "Salesperson", type: "string", sampleValues: ["Alice", "Bob"] },
    { name: "Region", type: "string", sampleValues: ["North", "South"] },
    { name: "Product", type: "string", sampleValues: ["Hair Oil", "Shampoo"] },
    { name: "Employee", type: "string", sampleValues: ["E001", "E002"] },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
    { name: "Leaves", type: "number", sampleValues: [3, 5] },
    { name: "Absenteeism", type: "number", sampleValues: [0.1, 0.4] },
  ],
  numericColumns: ["Sales", "Leaves", "Absenteeism"],
  dateColumns: [],
};

describe("RNK1 · extractRankingIntent", () => {
  it("returns null for non-ranking questions", () => {
    assert.equal(extractRankingIntent("trend of sales over time", summary), null);
    assert.equal(extractRankingIntent("compare Q1 vs Q2", summary), null);
    assert.equal(extractRankingIntent("what drives churn", summary), null);
    assert.equal(extractRankingIntent("", summary), null);
    assert.equal(extractRankingIntent(undefined, summary), null);
  });

  it("parses 'top 300 salespeople by sales'", () => {
    const intent = extractRankingIntent("who are the top 300 salespeople by sales", summary);
    assert.ok(intent, "expected intent");
    assert.equal(intent!.kind, "topN");
    assert.equal(intent!.n, 300);
    assert.equal(intent!.direction, "desc");
    assert.equal(intent!.entityColumn, "Salesperson");
    assert.equal(intent!.metricColumn, "Sales");
  });

  it("parses 'best 50 products'", () => {
    const intent = extractRankingIntent("show me the best 50 products by sales", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "topN");
    assert.equal(intent!.n, 50);
    assert.equal(intent!.direction, "desc");
    assert.equal(intent!.entityColumn, "Product");
  });

  it("parses 'bottom 5 salespeople' as topN with asc direction", () => {
    const intent = extractRankingIntent("show me the bottom 5 salespeople by sales", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "topN");
    assert.equal(intent!.n, 5);
    assert.equal(intent!.direction, "asc");
  });

  it("parses 'who has the highest absenteeism' as extremum max with n=1", () => {
    const intent = extractRankingIntent("who has the highest absenteeism", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "extremum");
    assert.equal(intent!.n, 1);
    assert.equal(intent!.direction, "desc");
    assert.equal(intent!.agg, "max");
    assert.equal(intent!.metricColumn, "Absenteeism");
  });

  it("parses 'who has the maximum leaves this month' (ignores temporal qualifier)", () => {
    const intent = extractRankingIntent("who has the maximum leaves this month", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "extremum");
    assert.equal(intent!.metricColumn, "Leaves");
  });

  it("parses 'who has the lowest absenteeism' as extremum min with asc direction", () => {
    const intent = extractRankingIntent("who has the lowest absenteeism", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "extremum");
    assert.equal(intent!.n, 1);
    assert.equal(intent!.direction, "asc");
    assert.equal(intent!.agg, "min");
  });

  it("parses 'who has the most leaves' (most → max → desc)", () => {
    const intent = extractRankingIntent("who has the most leaves", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "extremum");
    assert.equal(intent!.direction, "desc");
  });

  it("parses 'who has the fewest absences' style as extremum min", () => {
    const intent = extractRankingIntent("who has the fewest leaves", summary);
    assert.ok(intent);
    assert.equal(intent!.direction, "asc");
  });

  it("parses 'list the products' as entityList intent (no metric needed)", () => {
    const intent = extractRankingIntent("list the products", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "entityList");
    assert.equal(intent!.entityColumn, "Product");
    assert.equal(intent!.metricColumn, undefined);
    assert.equal(intent!.n, undefined);
  });

  it("parses 'who are the salespeople' as entityList intent", () => {
    const intent = extractRankingIntent("who are the salespeople", summary);
    assert.ok(intent);
    assert.equal(intent!.kind, "entityList");
    assert.equal(intent!.entityColumn, "Salesperson");
  });

  it("returns null when no entity column matches the question nouns", () => {
    // "rocket scientists" — no matching column in this dataset
    assert.equal(
      extractRankingIntent("who are the top 10 rocket scientists", summary),
      null
    );
  });

  it("returns null when no numeric metric can be resolved for top-N", () => {
    const noNumericSummary: DataSummary = {
      ...summary,
      numericColumns: [],
    };
    assert.equal(
      extractRankingIntent("top 300 salespeople by something", noNumericSummary),
      null
    );
  });

  it("does not cap N — accepts 5000", () => {
    const intent = extractRankingIntent("top 5000 salespeople by sales", summary);
    assert.ok(intent);
    assert.equal(intent!.n, 5000);
  });

  it("recognises plural-stripped entity nouns ('employees' → 'Employee')", () => {
    const intent = extractRankingIntent("top 10 employees by leaves", summary);
    assert.ok(intent);
    assert.equal(intent!.entityColumn, "Employee");
  });

  it("does not match 'top' as a substring of unrelated words ('topple', 'topic')", () => {
    assert.equal(extractRankingIntent("topple the leaderboard", summary), null);
    assert.equal(extractRankingIntent("topic of leaves", summary), null);
  });
});
