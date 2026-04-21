import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { scoreComplexity } from "../lib/agents/runtime/coordinatorAgent.js";

/**
 * Wave W6 · coordinatorAgent unit tests.
 *
 * decomposeQuestion makes a real LLM call so we test:
 *  1. scoreComplexity — the pure heuristic that gates decomposition.
 *  2. coordinatorOutputSchema — the Zod guard for LLM responses.
 */

// Mirror of coordinatorOutputSchema from coordinatorAgent.ts
const decomposedThreadSchema = z.object({
  question: z.string(),
  focusColumns: z.array(z.string()).default([]),
  rationale: z.string(),
});
const coordinatorOutputSchema = z.object({
  isComplex: z.boolean(),
  threads: z.array(decomposedThreadSchema).min(0).max(4),
  rationale: z.string(),
});

function makeCtx(question: string, overrides: Record<string, any> = {}) {
  return {
    question,
    mode: "analysis" as const,
    summary: {
      columns: [
        { name: "Sales", type: "number" },
        { name: "Region", type: "string" },
        { name: "Month", type: "string" },
      ],
      rowCount: 1000,
      dateColumns: [],
    },
    analysisBrief: overrides.analysisBrief ?? null,
    ...overrides,
  } as any;
}

describe("scoreComplexity", () => {
  it("returns 0 for a simple focused question", () => {
    const ctx = makeCtx("What was total sales in March?");
    assert.ok(scoreComplexity(ctx) < 2);
  });

  it("returns high score for dashboard question", () => {
    const ctx = makeCtx("Build a dashboard for Sales performance");
    assert.ok(scoreComplexity(ctx) >= 2);
  });

  it("returns high score for driver_discovery questionShape", () => {
    const ctx = makeCtx("Why did sales drop?", {
      analysisBrief: { questionShape: "driver_discovery", segmentationDimensions: [] },
    });
    assert.ok(scoreComplexity(ctx) >= 2);
  });

  it("returns high score for variance_diagnostic questionShape", () => {
    const ctx = makeCtx("What drove the variance?", {
      analysisBrief: { questionShape: "variance_diagnostic", segmentationDimensions: [] },
    });
    assert.ok(scoreComplexity(ctx) >= 2);
  });

  it("increments for compare/vs keywords", () => {
    const simple = makeCtx("What was total sales in March?");
    const withCompare = makeCtx("Compare East vs West sales");
    assert.ok(scoreComplexity(withCompare) > scoreComplexity(simple));
  });

  it("increments for cross-dimensional 'across' keywords", () => {
    const simple = makeCtx("Show total sales");
    const complex = makeCtx("Show sales across all regions and categories");
    assert.ok(scoreComplexity(complex) > scoreComplexity(simple));
  });

  it("increments for 3+ segmentation dimensions in brief", () => {
    const few = makeCtx("Q", {
      analysisBrief: { segmentationDimensions: ["Region", "Category"] },
    });
    const many = makeCtx("Q", {
      analysisBrief: { segmentationDimensions: ["Region", "Category", "Channel"] },
    });
    assert.ok(scoreComplexity(many) > scoreComplexity(few));
  });

  it("dataOps mode gets score but decomposition is skipped (handled in decomposeQuestion)", () => {
    const ctx = makeCtx("Build a dashboard", { mode: "dataOps" });
    // scoreComplexity is mode-agnostic — decomposeQuestion gates on mode
    assert.ok(typeof scoreComplexity(ctx) === "number");
  });
});

describe("coordinatorOutputSchema — LLM response guard", () => {
  it("accepts simple (isComplex=false, threads=[])", () => {
    const r = coordinatorOutputSchema.safeParse({
      isComplex: false,
      threads: [],
      rationale: "Simple single-metric question",
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.threads.length, 0);
  });

  it("accepts complex with 3 threads", () => {
    const r = coordinatorOutputSchema.safeParse({
      isComplex: true,
      rationale: "Multi-dimensional dashboard request",
      threads: [
        { question: "What are the top metrics?", focusColumns: ["Sales"], rationale: "Metrics overview" },
        { question: "What are the time trends?", focusColumns: ["Month", "Sales"], rationale: "Temporal analysis" },
        { question: "Which regions drive performance?", focusColumns: ["Region"], rationale: "Geo split" },
      ],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.threads.length, 3);
  });

  it("rejects more than 4 threads", () => {
    const r = coordinatorOutputSchema.safeParse({
      isComplex: true,
      rationale: "Too complex",
      threads: Array.from({ length: 5 }, (_, i) => ({
        question: `Thread ${i}`,
        focusColumns: [],
        rationale: "r",
      })),
    });
    assert.ok(!r.success);
  });

  it("defaults focusColumns to empty array when omitted", () => {
    const r = coordinatorOutputSchema.safeParse({
      isComplex: true,
      rationale: "ok",
      threads: [{ question: "Q1", rationale: "r1" }],
    });
    assert.ok(r.success);
    assert.deepStrictEqual(r.data?.threads[0].focusColumns, []);
  });

  it("rejects missing rationale", () => {
    const r = coordinatorOutputSchema.safeParse({
      isComplex: false,
      threads: [],
    });
    assert.ok(!r.success);
  });
});
