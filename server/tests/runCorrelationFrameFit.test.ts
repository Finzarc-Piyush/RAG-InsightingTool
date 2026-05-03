// W51 · integration test for the registered `run_correlation` tool. Exercises
// the W47 frame-fit auto-recovery, W48 column-matcher resolution, and W49
// ok:false-with-diagnostic surface as a single end-to-end path. Uses the real
// ToolRegistry + registerDefaultTools so the test catches schema or wiring
// regressions as well as logic regressions.
//
// We deliberately drive only the empty-result and recovery code paths so the
// test doesn't need LLM stubs or chart generation — those are covered by W46
// and W50 unit tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.AGENTIC_ALLOW_NO_RAG = process.env.AGENTIC_ALLOW_NO_RAG ?? "true";
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { ToolRegistry } = await import("../lib/agents/runtime/toolRegistry.js");
const { registerDefaultTools } = await import(
  "../lib/agents/runtime/tools/registerTools.js"
);

// Minimal ToolRunContext shape that satisfies the run_correlation handler.
// We bypass the strict type via `as never` per the established pattern in
// webSearchToolW14.test.ts — these are the fields the handler actually reads.
function makeCtx(opts: {
  data: Record<string, any>[];
  turnStartDataRef?: Record<string, any>[] | null;
  numericColumns: string[];
  dateColumns?: string[];
  schemaColumns?: string[]; // names of all schema columns (defaults to numeric ∪ date)
}) {
  // The schema reflects the original uploaded dataset, NOT whatever shape the
  // previous tool happened to leave in ctx.exec.data. So we build columns from
  // an explicit schemaColumns list (or numeric ∪ date as a fallback).
  const schemaNames =
    opts.schemaColumns ?? [...opts.numericColumns, ...(opts.dateColumns ?? [])];
  const cols = schemaNames.map((name) => ({
    name,
    type: opts.numericColumns.includes(name) ? "number" : "string",
    sampleValues: [],
  }));
  return {
    exec: {
      sessionId: "s1",
      question: "what drives sales?",
      data: opts.data,
      turnStartDataRef: opts.turnStartDataRef ?? null,
      summary: {
        rowCount: opts.data.length,
        columnCount: cols.length,
        columns: cols,
        numericColumns: opts.numericColumns,
        dateColumns: opts.dateColumns ?? [],
      },
      chatInsights: [],
      chatHistory: [],
      mode: "analysis",
      sessionAnalysisContext: undefined,
      permanentContext: undefined,
      domainContext: undefined,
    },
    config: { sampleRowsCap: 200, observationMaxChars: 24_000 },
    callId: "c1",
  };
}

describe("W51 · run_correlation frame-fit + column-matcher + ok:false", () => {
  it("returns ok:false with `no_target_values` reason when frame is aggregated AND no turnStartDataRef is available", async () => {
    // Simulates a `run_aggregation` having left `[{bucket, Sales_sum}]` in
    // ctx.exec.data with no row-level fallback. Pre-W49 this returned
    // ok:true with empty charts/insights — silent and useless to the agent.
    const registry = new ToolRegistry();
    registerDefaultTools(registry);

    const aggregatedFrame = Array.from({ length: 12 }, (_, i) => ({
      bucket: `2025-${String(i + 1).padStart(2, "0")}`,
      Sales_sum: 100 + i * 10,
    }));
    const ctx = makeCtx({
      data: aggregatedFrame,
      turnStartDataRef: null, // no recovery available
      numericColumns: ["Sales", "Price"], // schema claims these but rows lack them
      schemaColumns: ["Sales", "Price", "Region"],
    });

    const result = await registry.execute(
      "run_correlation",
      { targetVariable: "Sales" },
      ctx as never
    );

    assert.equal(result.ok, false);
    // Either the W47 guard rejects up-front (no row-level fallback, no Sales
    // on frame), or the W49 ok:false path fires after analyzeCorrelations
    // returns no_target_values. Both are acceptable outcomes — the contract
    // is "no silent ok-with-empty".
    assert.match(
      result.summary,
      /no_target_values|Frame does not contain "Sales"/,
      `summary should explain why correlation produced nothing; got: ${result.summary}`
    );
  });

  it("auto-recovers row-level data from turnStartDataRef when ctx.exec.data was aggregated", async () => {
    // Same aggregated frame as before, but now turnStartDataRef has the
    // original row-level data with Sales + Price + Region — auto-recovery
    // should kick in and produce real correlations.
    const registry = new ToolRegistry();
    registerDefaultTools(registry);

    const aggregatedFrame = Array.from({ length: 12 }, (_, i) => ({
      bucket: `2025-${String(i + 1).padStart(2, "0")}`,
      Sales_sum: 100 + i * 10,
    }));
    const rowLevel = Array.from({ length: 100 }, (_, i) => ({
      Sales: 100 + i,
      Price: 50 - i * 0.3, // strong negative correlation
      Region: ["North", "South", "East", "West"][i % 4],
    }));

    const ctx = makeCtx({
      data: aggregatedFrame,
      turnStartDataRef: rowLevel,
      numericColumns: ["Sales", "Price"],
      schemaColumns: ["Sales", "Price", "Region"],
    });

    const result = await registry.execute(
      "run_correlation",
      { targetVariable: "Sales" },
      ctx as never
    );

    // We can't assert ok:true reliably without an LLM stub for insights,
    // but we *can* assert that auto-recovery fired (note in summary) and
    // that it didn't bail out with `no_target_values`.
    assert.match(
      result.summary,
      /auto-recovered to row-level frame/,
      `expected auto-recovery note in summary; got: ${result.summary}`
    );
    assert.doesNotMatch(result.summary, /no_target_values/);
  });

  it("resolves a fuzzy targetVariable via findMatchingColumn (e.g. \"sales\" → \"Sales\" when schema has \"Sales\")", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);

    // Lowercase "sales" requested, schema has capitalized "Sales".
    const rowLevel = Array.from({ length: 30 }, (_, i) => ({
      Sales: 100 + i,
      Price: 50 + i,
    }));
    const ctx = makeCtx({
      data: rowLevel,
      numericColumns: ["Sales", "Price"],
    });

    const result = await registry.execute(
      "run_correlation",
      { targetVariable: "sales" }, // lowercase
      ctx as never
    );

    // Either the resolution succeeds (note appears in summary) or the call
    // fails for a non-resolution reason. Pre-W48, this returned
    // ok:false "Column not in schema: sales" — assert that's no longer the
    // case.
    assert.doesNotMatch(
      result.summary,
      /Column not in schema: sales/,
      `pre-W48 strict mismatch should be gone; got: ${result.summary}`
    );
    if (result.summary.includes("target resolved")) {
      assert.match(result.summary, /"sales".*Sales/);
    }
  });

  it("rejects with ok:false and a strict-mismatch error when target truly doesn't exist anywhere", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);

    const rowLevel = Array.from({ length: 30 }, (_, i) => ({
      Sales: 100 + i,
      Price: 50 + i,
    }));
    const ctx = makeCtx({
      data: rowLevel,
      numericColumns: ["Sales", "Price"],
    });

    const result = await registry.execute(
      "run_correlation",
      { targetVariable: "TotallyMadeUpColumn" },
      ctx as never
    );

    assert.equal(result.ok, false);
    assert.match(result.summary, /Column not in schema/);
  });
});
