import assert from "node:assert/strict";
import { describe, it, after, beforeEach } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { mergeSessionAnalysisContextUserLLM, mergeSessionAnalysisContextAssistantLLM } =
  await import("../lib/sessionAnalysisContext.js");
const { withImmutableUserIntentFromPrevious } = await import(
  "../lib/sessionAnalysisContextGuards.js"
);
const { LLM_PURPOSE } = await import("../lib/agents/runtime/llmCallPurpose.js");
const { installLlmStub, clearLlmStub } = await import("./helpers/llmStub.js");
import type { SessionAnalysisContext } from "../shared/schema.js";

beforeEach(() => clearLlmStub());
after(() => clearLlmStub());

const baseCtx = (): SessionAnalysisContext => ({
  version: 1,
  dataset: {
    shortDescription: "Marico-VN sales by Products and Markets.",
    columnRoles: [
      { name: "Products", role: "dimension" },
      { name: "Markets", role: "dimension" },
      { name: "Total_Sales_Value", role: "measure" },
    ],
    caveats: [],
  },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: "2026-04-29T00:00:00.000Z" },
});

describe("H2 · merge user notes extracts dimensionHierarchies", () => {
  it("populates dimensionHierarchies from a user clarification", async () => {
    installLlmStub({
      [LLM_PURPOSE.SESSION_CONTEXT]: () => ({
        version: 1,
        dataset: {
          shortDescription: "Marico-VN sales by Products and Markets.",
          columnRoles: [
            { name: "Products", role: "dimension" },
            { name: "Markets", role: "dimension" },
            { name: "Total_Sales_Value", role: "measure" },
          ],
          caveats: [],
          dimensionHierarchies: [
            {
              column: "Products",
              rollupValue: "FEMALE SHOWER GEL",
              itemValues: ["MARICO", "PURITE", "OLIV", "LASHE"],
              source: "user",
              description: "FEMALE SHOWER GEL is the category total.",
            },
          ],
        },
        userIntent: {
          verbatimNotes:
            "FEMALE SHOWER GEL is the entire category. Marico, Purite, Oliv, Lashe are products within it.",
          interpretedConstraints: ["Treat FEMALE SHOWER GEL as the category total"],
        },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "user_context", at: "2026-04-29T00:01:00.000Z" },
      }),
    });

    const merged = await mergeSessionAnalysisContextUserLLM({
      previous: baseCtx(),
      userText:
        "FEMALE SHOWER GEL is the entire category. Marico, Purite, Oliv, Lashe are products within it. Please re-do the analysis.",
    });

    assert.equal(merged.dataset.dimensionHierarchies?.length, 1);
    const h = merged.dataset.dimensionHierarchies?.[0];
    assert.equal(h?.column, "Products");
    assert.equal(h?.rollupValue, "FEMALE SHOWER GEL");
    assert.deepEqual(h?.itemValues, ["MARICO", "PURITE", "OLIV", "LASHE"]);
    assert.equal(h?.source, "user");
  });
});

describe("H2 · withImmutableUserIntentFromPrevious pins user-source hierarchies", () => {
  it("restores user-source hierarchies if assistant merge would drop them", () => {
    const prev: SessionAnalysisContext = {
      ...baseCtx(),
      dataset: {
        ...baseCtx().dataset,
        dimensionHierarchies: [
          {
            column: "Products",
            rollupValue: "FEMALE SHOWER GEL",
            source: "user",
          },
        ],
      },
      userIntent: {
        verbatimNotes: "FEMALE SHOWER GEL is the category.",
        interpretedConstraints: ["category-aware"],
      },
    };
    const assistantMerged: SessionAnalysisContext = {
      ...baseCtx(),
      dataset: {
        ...baseCtx().dataset,
        // Assistant merge accidentally drops it
        dimensionHierarchies: [],
      },
      userIntent: { interpretedConstraints: [] },
    };
    const fixed = withImmutableUserIntentFromPrevious(prev, assistantMerged);
    assert.equal(fixed.dataset.dimensionHierarchies?.length, 1);
    assert.equal(fixed.dataset.dimensionHierarchies?.[0]?.rollupValue, "FEMALE SHOWER GEL");
    assert.equal(fixed.userIntent.verbatimNotes, "FEMALE SHOWER GEL is the category.");
  });

  it("preserves ALL previous hierarchies (user + auto); ignores assistant-merge proposals", () => {
    const prev: SessionAnalysisContext = {
      ...baseCtx(),
      dataset: {
        ...baseCtx().dataset,
        dimensionHierarchies: [
          { column: "Products", rollupValue: "FEMALE SHOWER GEL", source: "user" },
          { column: "Region", rollupValue: "All Regions", source: "auto" },
        ],
      },
    };
    const assistantMerged: SessionAnalysisContext = {
      ...baseCtx(),
      dataset: {
        ...baseCtx().dataset,
        dimensionHierarchies: [
          // assistant tries to introduce a new auto entry — guard ignores it.
          // Hierarchies only change via user-merge LLM (chat-input or PATCH).
          { column: "Brand", rollupValue: "ALL BRANDS", source: "auto" },
        ],
      },
    };
    const fixed = withImmutableUserIntentFromPrevious(prev, assistantMerged);
    const cols = (fixed.dataset.dimensionHierarchies ?? []).map((h) => h.column).sort();
    assert.deepEqual(cols, ["Products", "Region"]);
  });

  it("no-op when no user-source hierarchies exist", () => {
    const prev = baseCtx();
    const assistantMerged: SessionAnalysisContext = {
      ...baseCtx(),
      dataset: {
        ...baseCtx().dataset,
        dimensionHierarchies: [
          { column: "Products", rollupValue: "AUTO_TOTAL", source: "auto" },
        ],
      },
    };
    const fixed = withImmutableUserIntentFromPrevious(prev, assistantMerged);
    // assistant's dimensionHierarchies passes through untouched
    assert.equal(fixed.dataset.dimensionHierarchies?.length, 1);
    assert.equal(fixed.dataset.dimensionHierarchies?.[0]?.source, "auto");
  });
});

describe("H2 · assistant merge cannot wipe user-declared hierarchies (end-to-end)", () => {
  it("guard restores user hierarchy when assistant LLM stub drops it", async () => {
    const prev: SessionAnalysisContext = {
      ...baseCtx(),
      dataset: {
        ...baseCtx().dataset,
        dimensionHierarchies: [
          { column: "Products", rollupValue: "FEMALE SHOWER GEL", source: "user" },
        ],
      },
      userIntent: {
        verbatimNotes: "FEMALE SHOWER GEL is the category.",
        interpretedConstraints: ["category-aware"],
      },
    };
    installLlmStub({
      [LLM_PURPOSE.SESSION_CONTEXT]: () => ({
        version: 1,
        dataset: {
          shortDescription: prev.dataset.shortDescription,
          columnRoles: prev.dataset.columnRoles,
          caveats: [],
          // assistant drops the hierarchy
          dimensionHierarchies: [],
        },
        userIntent: { interpretedConstraints: [] },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "assistant_turn", at: "2026-04-29T00:02:00.000Z" },
      }),
    });
    const merged = await mergeSessionAnalysisContextAssistantLLM({
      previous: prev,
      assistantMessage: "Some answer.",
    });
    assert.equal(merged.dataset.dimensionHierarchies?.length, 1);
    assert.equal(merged.dataset.dimensionHierarchies?.[0]?.source, "user");
    // userIntent preserved too
    assert.equal(merged.userIntent.verbatimNotes, "FEMALE SHOWER GEL is the category.");
  });
});
