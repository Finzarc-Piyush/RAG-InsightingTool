import { test } from "node:test";
import assert from "node:assert/strict";
import type { DataSummary, SessionAnalysisContext } from "../shared/schema.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import { createBlackboard, addDomainContext } from "../lib/agents/runtime/analyticalBlackboard.js";

// Stub Azure OpenAI env BEFORE importing anything in the runtime chain so the
// transitive openai import doesn't crash at module load outside CI.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { buildSynthesisContext, formatSynthesisContextBundle } = await import(
  "../lib/agents/runtime/buildSynthesisContext.js"
);

const baseSummary: DataSummary = {
  rowCount: 5_120,
  columnCount: 7,
  columns: [
    { name: "Month", type: "date", sampleValues: [] },
    { name: "Brand", type: "string", sampleValues: [] },
    { name: "Region", type: "string", sampleValues: [] },
    { name: "Channel", type: "string", sampleValues: [] },
    { name: "Volume_MT", type: "number", sampleValues: [] },
    { name: "Value_INR", type: "number", sampleValues: [] },
    { name: "MarketShare", type: "number", sampleValues: [] },
  ],
  numericColumns: ["Volume_MT", "Value_INR", "MarketShare"],
  dateColumns: ["Month"],
};

const baseSAC = (): SessionAnalysisContext => ({
  version: 1,
  dataset: {
    shortDescription: "Monthly brand-region-channel volume and value tracker.",
    grainGuess: "one row per Brand × Region × Channel × Month",
    columnRoles: [
      { name: "Brand", role: "dimension" },
      { name: "Region", role: "dimension", notes: "geographic split" },
      { name: "Channel", role: "dimension" },
      { name: "Volume_MT", role: "metric" },
      { name: "Value_INR", role: "metric" },
      { name: "MarketShare", role: "metric", notes: "0–1 fraction" },
    ],
    caveats: ["Vietnam rows blank for first 3 months", "MT is metric tonnes"],
  },
  userIntent: { interpretedConstraints: ["focus on Q3 2024"] },
  sessionKnowledge: {
    facts: [
      { statement: "Saffola edible oils dominates South region", source: "data", confidence: "high" },
      { statement: "Channel codes follow MT/GT/EC convention", source: "user", confidence: "medium" },
      { statement: "Distributor stockout in Mar-24", source: "assistant", confidence: "low" },
    ],
    analysesDone: [],
  },
  suggestedFollowUps: ["What drives Saffola Volume in MT?", "Margin trend by Brand?"],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
});

const baseCtx = (): AgentExecutionContext => ({
  sessionId: "sess-1",
  username: "piyush@finzarc.com",
  question: "Why did Saffola lose share in MT in Q3?",
  data: [],
  summary: baseSummary,
  chatHistory: [],
  mode: "analysis",
  permanentContext: "Always pivot by Brand first; revenue is in INR.",
  domainContext: "<<DOMAIN PACK: marico-haircare-portfolio>>\n# Marico Haircare Portfolio\nParachute, Nihar, Hair&Care…\n<</DOMAIN PACK>>",
  sessionAnalysisContext: baseSAC(),
  inferredFilters: [
    { column: "Channel", op: "in", values: ["MT"] },
    { column: "Month", op: "in", values: ["2024-07", "2024-08", "2024-09"] },
  ],
});

test("dataUnderstanding lists grain, key columns, caveats, and applied filters", () => {
  const bundle = buildSynthesisContext(baseCtx());
  const block = bundle.dataUnderstandingBlock;
  assert.match(block, /Dataset: Monthly brand-region-channel/);
  assert.match(block, /Shape: 5120 rows × 7 columns/);
  assert.match(block, /Grain: one row per Brand × Region × Channel × Month/);
  assert.match(block, /Brand \(dimension\)/);
  assert.match(block, /Region \(dimension\) — geographic split/);
  assert.match(block, /Volume_MT \(metric\)/);
  assert.match(block, /Vietnam rows blank for first 3 months/);
  assert.match(block, /Applied filters this turn: Channel in \[MT\]; Month in \[2024-07, 2024-08, 2024-09\]/);
  assert.match(block, /Saffola edible oils dominates South region/);
  // Low-confidence facts excluded.
  assert.ok(!/Distributor stockout in Mar-24/.test(block));
});

test("dataUnderstanding surfaces a duration block when a column carries the duration annotation", () => {
  const ctx = baseCtx();
  ctx.summary = {
    ...baseSummary,
    columns: [
      ...baseSummary.columns,
      {
        name: "Working Hrs",
        type: "number",
        sampleValues: [3.53, 5.14],
        duration: { unit: "hours", format: "hm" },
      },
    ],
    numericColumns: [...baseSummary.numericColumns, "Working Hrs"],
  };
  const block = buildSynthesisContext(ctx).dataUnderstandingBlock;
  assert.match(block, /Duration columns: "Working Hrs"/);
  assert.match(block, /DECIMAL HOURS/);
  assert.match(block, /3h 32m/);
});

test("userBlock surfaces username, permanent notes, and suggested follow-ups", () => {
  const bundle = buildSynthesisContext(baseCtx());
  assert.match(bundle.userBlock, /Authenticated user: piyush@finzarc\.com/);
  assert.match(bundle.userBlock, /User notes \(verbatim\):\nAlways pivot by Brand first/);
  assert.match(bundle.userBlock, /What drives Saffola Volume in MT\?/);
});

test("domainBlock passes through domain packs verbatim under cap", () => {
  const bundle = buildSynthesisContext(baseCtx());
  assert.match(bundle.domainBlock, /marico-haircare-portfolio/);
  assert.match(bundle.domainBlock, /Parachute, Nihar, Hair&Care/);
});

test("ragBlock combines upfront + round-2 hits and respects 4k cap", () => {
  const bb = createBlackboard();
  addDomainContext(bb, "Hair oil category grew 4% YoY in MT channel.", "rag_round2");
  addDomainContext(bb, "Q3 typically sees festive uplift in personal care.", "rag_round2");
  const bundle = buildSynthesisContext(baseCtx(), {
    upfrontRagHitsBlock:
      "[summary:s1]\nDataset covers 24 months across MT/GT/EC channels.\n",
    blackboard: bb,
  });
  assert.match(bundle.ragBlock, /Upfront retrieval \(round 1\)/);
  assert.match(bundle.ragBlock, /Findings-driven retrieval \(round 2\)/);
  assert.match(bundle.ragBlock, /MT\/GT\/EC channels/);
  assert.match(bundle.ragBlock, /Hair oil category grew 4% YoY/);
  assert.match(bundle.ragBlock, /festive uplift/);
  assert.ok(bundle.ragBlock.length <= 4_000);
});

test("byte-stable across two calls with the same ctx (cache safety)", () => {
  const ctx = baseCtx();
  const bb = createBlackboard();
  addDomainContext(bb, "Stable round-2 hit content.", "rag_round2");
  const a = formatSynthesisContextBundle(
    buildSynthesisContext(ctx, { upfrontRagHitsBlock: "[summary:s1]\nstable.\n", blackboard: bb })
  );
  const b = formatSynthesisContextBundle(
    buildSynthesisContext(ctx, { upfrontRagHitsBlock: "[summary:s1]\nstable.\n", blackboard: bb })
  );
  assert.equal(a, b);
});

test("formatSynthesisContextBundle omits empty sections", () => {
  const ctx = baseCtx();
  ctx.domainContext = undefined;
  ctx.permanentContext = undefined;
  ctx.username = undefined;
  ctx.sessionAnalysisContext = undefined;
  ctx.inferredFilters = undefined;
  ctx.summary = { rowCount: 0, columnCount: 0, columns: [], numericColumns: [], dateColumns: [] };
  const formatted = formatSynthesisContextBundle(buildSynthesisContext(ctx));
  // Without domain/user/SAC/RAG/shape signals, every section is empty → entire bundle is "".
  assert.equal(formatted.trim(), "");
});

test("formatSynthesisContextBundle emits all four section headers when populated", () => {
  const bb = createBlackboard();
  addDomainContext(bb, "Round-2 context.", "rag_round2");
  const formatted = formatSynthesisContextBundle(
    buildSynthesisContext(baseCtx(), {
      upfrontRagHitsBlock: "[summary:s1]\nupfront.\n",
      blackboard: bb,
    })
  );
  assert.match(formatted, /## DATA UNDERSTANDING/);
  assert.match(formatted, /## USER CONTEXT/);
  // W16 · label now reads `RELATED CONTEXT (RAG / web)`.
  assert.match(formatted, /## RELATED CONTEXT \(RAG \/ web\)/);
  assert.match(formatted, /## DOMAIN KNOWLEDGE \(FMCG \/ Marico\)/);
  assert.match(formatted, /Cite the pack id/);
});

test("W1 · surfaces COMPLETE rows for a small aggregated result (full 24-row ASM ranking, no partial-snippet hedging)", () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    ASM: `ASM_${i}`,
    pjp_adherence_rate: Number((0.5 + i * 0.01).toFixed(2)),
  }));
  const block = buildSynthesisContext(baseCtx(), {
    structuredObservations: [
      {
        stepId: "s1",
        tool: "execute_query_plan",
        args: { plan: { groupBy: ["ASM"] } },
        metrics: { outputRowCount: 24, appliedAggregation: true },
        result: { table: { rows, columns: ["ASM", "pjp_adherence_rate"], rowCount: 24 } },
      },
    ],
  }).dataUnderstandingBlock;
  assert.match(block, /Complete results for small aggregated steps/);
  assert.match(block, /24 rows, COMPLETE/);
  // All 24 ASMs reach the writer — the full ranking is stateable, not "partially shown".
  for (let i = 0; i < 24; i++) {
    assert.ok(block.includes(`ASM_${i}`), `ASM_${i} missing from synthesis context`);
  }
});

test("W1 · does NOT surface full rows for a LARGE result (prompt stays bounded)", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ TSOE: `T_${i}`, n: i }));
  const block = buildSynthesisContext(baseCtx(), {
    structuredObservations: [
      {
        stepId: "s1",
        tool: "execute_query_plan",
        args: { plan: { groupBy: ["TSO_TSE Code"] } },
        metrics: { outputRowCount: 200, appliedAggregation: true },
        result: { table: { rows, columns: ["TSOE", "n"], rowCount: 200 } },
      },
    ],
  }).dataUnderstandingBlock;
  assert.ok(!/Complete results for small aggregated steps/.test(block));
});

test("W1 · does NOT surface full rows for an un-aggregated (raw) result", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ASM: `ASM_${i}`, x: i }));
  const block = buildSynthesisContext(baseCtx(), {
    structuredObservations: [
      {
        stepId: "s1",
        tool: "execute_query_plan",
        args: {},
        metrics: { outputRowCount: 10, appliedAggregation: false },
        result: { table: { rows, columns: ["ASM", "x"], rowCount: 10 } },
      },
    ],
  }).dataUnderstandingBlock;
  assert.ok(!/Complete results for small aggregated steps/.test(block));
});

test("dataUnderstandingBlock truncates columnRoles to 20 with overflow note", () => {
  const ctx = baseCtx();
  const sac = ctx.sessionAnalysisContext!;
  sac.dataset.columnRoles = Array.from({ length: 25 }, (_, i) => ({
    name: `col_${i}`,
    role: "dimension",
  }));
  const block = buildSynthesisContext(ctx).dataUnderstandingBlock;
  const matches = block.match(/col_\d+/g) ?? [];
  assert.equal(matches.length, 20);
  assert.match(block, /…and 5 more\./);
});
