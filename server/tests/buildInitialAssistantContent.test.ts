import { test } from "node:test";
import assert from "node:assert/strict";
import type { DataSummary, SessionAnalysisContext } from "../shared/schema.js";

// Stub Azure OpenAI env BEFORE the dynamic import so the import chain
// (sessionAnalysisContext → completeJson → openai) doesn't crash at module load
// when running outside CI. `buildInitialAssistantContentFromContext` is pure and
// never touches the network.
process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { buildInitialAssistantContentFromContext } = await import(
  "../lib/sessionAnalysisContext.js"
);

const baseSummary: DataSummary = {
  rowCount: 1234,
  columnCount: 5,
  columns: [
    {
      name: "order_date",
      type: "date",
      sampleValues: ["2024-01-04", "2024-06-30", "2024-12-30"],
    },
    {
      name: "region",
      type: "string",
      sampleValues: ["West", "East"],
      topValues: [
        { value: "West", count: 600 },
        { value: "East", count: 400 },
        { value: "South", count: 234 },
      ],
    },
    {
      name: "product",
      type: "string",
      sampleValues: ["A", "B"],
      topValues: [
        { value: "A", count: 100 },
        { value: "B", count: 80 },
      ],
    },
    { name: "revenue", type: "number", sampleValues: [] },
    { name: "units", type: "number", sampleValues: [] },
  ],
  numericColumns: ["revenue", "units"],
  dateColumns: ["order_date"],
};

const heuristicCtx = (): SessionAnalysisContext => ({
  version: 1,
  dataset: { shortDescription: "", columnRoles: [], caveats: [] },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
});

test("includes the row/column overview line without column-type breakdown", () => {
  const out = buildInitialAssistantContentFromContext(baseSummary, heuristicCtx());
  assert.match(out, /\*\*1,234 rows · 5 columns\*\*/);
  // The old "(N numeric, N date)" technical breakdown is gone — manager
  // audience does not care about column types on the welcome card.
  assert.doesNotMatch(out, /numeric, \d+ date/);
});

test("renders 'What's in this data' with deterministic bullets in the heuristic-only state", () => {
  const out = buildInitialAssistantContentFromContext(baseSummary, heuristicCtx());
  assert.match(out, /\*\*What's in this data:\*\*/);
  assert.match(out, /3 regions/);
  assert.match(out, /records in scope/);
});

test("renders 'What you can analyze' with deterministic themes in the heuristic-only state", () => {
  const out = buildInitialAssistantContentFromContext(baseSummary, heuristicCtx());
  assert.match(out, /\*\*What you can analyze:\*\*/);
  assert.match(out, /Track revenue over time/);
});

test("LLM-seeded keyHighlights / whatYouCanAnalyze override the deterministic fallback", () => {
  const ctx = heuristicCtx();
  ctx.dataset.keyHighlights = [
    "4 years of US retail sales (2015 → 2018)",
    "$2.3M total sales across 9.8K orders",
  ];
  ctx.dataset.whatYouCanAnalyze = [
    "Compare regional sales performance",
    "Profile high-value customer segments",
  ];
  const out = buildInitialAssistantContentFromContext(baseSummary, ctx);
  assert.match(out, /4 years of US retail sales \(2015 → 2018\)/);
  assert.match(out, /\$2\.3M total sales across 9\.8K orders/);
  assert.match(out, /Compare regional sales performance/);
  assert.match(out, /Profile high-value customer segments/);
  // Deterministic bullets must be replaced when LLM-seeded ones are present.
  assert.doesNotMatch(out, /Track revenue over time/);
  assert.doesNotMatch(out, /records in scope/);
});

test("renders dataset description and grain guess when the LLM seeded them", () => {
  const ctx = heuristicCtx();
  ctx.dataset.shortDescription = "Daily retail sales by region.";
  ctx.dataset.grainGuess = "one row per order line";
  const out = buildInitialAssistantContentFromContext(baseSummary, ctx);
  assert.match(out, /Daily retail sales by region\./);
  assert.match(out, /\*\*Row grain:\*\* one row per order line/);
});

test("the technical 'Columns at a glance' and 'Data caveats' headers are gone", () => {
  const ctx = heuristicCtx();
  ctx.dataset.caveats = ["mixed currency in revenue", "PII removed"];
  const out = buildInitialAssistantContentFromContext(baseSummary, ctx);
  assert.doesNotMatch(out, /Columns at a glance/);
  assert.doesNotMatch(out, /Data caveats/);
  assert.doesNotMatch(out, /Column roles understood/);
});

test("never returns just the row/column line when summary has columns", () => {
  const out = buildInitialAssistantContentFromContext(baseSummary, heuristicCtx());
  const lines = out.split("\n").filter((l) => l.trim().length > 0);
  assert.ok(lines.length > 1, `expected more than just the stats line, got: ${out}`);
});

test("partial LLM seed (only keyHighlights, not whatYouCanAnalyze) still falls back per-section", () => {
  const ctx = heuristicCtx();
  ctx.dataset.keyHighlights = ["Custom highlight one", "Custom highlight two"];
  // whatYouCanAnalyze deliberately undefined.
  const out = buildInitialAssistantContentFromContext(baseSummary, ctx);
  assert.match(out, /Custom highlight one/);
  // analyze section still renders deterministic themes since LLM didn't seed them.
  assert.match(out, /\*\*What you can analyze:\*\*/);
  assert.match(out, /Track revenue over time/);
});

// Regression — Marico-VN wide-format columns are already-plural English
// nouns ("Facts", "Markets", "Products"). The pre-fix pluraliser produced
// "factses / marketses / productses" in both the highlights and the
// analyze themes. Now that singularize-then-pluralise is in, the fallback
// must never emit those gibberish tokens — this is the worst-case render
// the user actually saw on screen before the fix.
test("wide-format already-plural column names never produce double-pluralised gibberish", () => {
  const wideMaricoSummary: DataSummary = {
    rowCount: 13_500,
    columnCount: 7,
    columns: [
      {
        name: "Facts",
        type: "string",
        sampleValues: [],
        topValues: Array.from({ length: 24 }, (_, i) => ({ value: `m${i}`, count: 10 })),
      },
      {
        name: "Markets",
        type: "string",
        sampleValues: [],
        topValues: Array.from({ length: 5 }, (_, i) => ({ value: `mk${i}`, count: 10 })),
      },
      {
        name: "Products",
        type: "string",
        sampleValues: [],
        topValues: Array.from({ length: 5 }, (_, i) => ({ value: `pr${i}`, count: 10 })),
      },
      { name: "Value", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Value"],
    dateColumns: [],
  };
  const out = buildInitialAssistantContentFromContext(wideMaricoSummary, heuristicCtx());
  assert.doesNotMatch(out, /factses|marketses|productses/, out);
  assert.match(out, /24 facts/);
  assert.match(out, /5 markets/);
  assert.match(out, /5 products/);
  assert.match(out, /Compare Value across markets/);
});
