import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildChunksForSession,
  userContextChunk,
} from "../lib/rag/chunking.js";
import { shouldExtractUserHierarchies } from "../lib/sessionAnalysisContext.js";
import type { ChatDocument } from "../models/chat.model.js";
import type { DataSummary, SessionAnalysisContext } from "../shared/schema.js";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const summary: DataSummary = {
  rowCount: 100,
  columnCount: 2,
  columns: [
    { name: "Products", type: "string", sampleValues: ["MARICO"] },
    { name: "Total_Sales_Value", type: "number", sampleValues: [1000] },
  ],
  numericColumns: ["Total_Sales_Value"],
  dateColumns: [],
};

const sacWithHierarchy: SessionAnalysisContext = {
  version: 1,
  dataset: {
    shortDescription: "",
    columnRoles: [],
    caveats: [],
    dimensionHierarchies: [
      {
        column: "Products",
        rollupValue: "FEMALE SHOWER GEL",
        itemValues: ["MARICO", "PURITE", "OLIV", "LASHE"],
        source: "user",
      },
    ],
  },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "user_context", at: "2026-04-29T00:00:00.000Z" },
};

function makeDoc(opts: {
  permanentContext?: string;
  sessionAnalysisContext?: SessionAnalysisContext;
}): ChatDocument {
  return {
    id: "t",
    username: "u",
    fileName: "f.csv",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    dataSummary: summary,
    messages: [],
    charts: [],
    insights: [],
    sampleRows: [],
    permanentContext: opts.permanentContext,
    sessionAnalysisContext: opts.sessionAnalysisContext,
  } as unknown as ChatDocument;
}

describe("H5 · userContextChunk surfaces declared hierarchies", () => {
  it("includes hierarchy block when hierarchies are passed", () => {
    const chunk = userContextChunk(
      "User notes",
      sacWithHierarchy.dataset.dimensionHierarchies
    );
    assert.match(chunk.content, /Declared dimension hierarchies/);
    assert.match(chunk.content, /"Products" column: "FEMALE SHOWER GEL"/);
    assert.match(chunk.content, /children: MARICO, PURITE, OLIV, LASHE/);
  });

  it("falls back to plain user context when no hierarchies", () => {
    const chunk = userContextChunk("User notes only", []);
    assert.match(chunk.content, /User-provided analysis context/);
    assert.doesNotMatch(chunk.content, /Declared dimension hierarchies/);
  });

  it("buildChunksForSession emits a user_context chunk when only hierarchies exist (no permanentContext)", () => {
    const doc = makeDoc({ sessionAnalysisContext: sacWithHierarchy });
    const chunks = buildChunksForSession({ doc });
    const userCtx = chunks.find((c) => c.chunkType === "user_context");
    assert.ok(userCtx, "expected a user_context chunk");
    assert.match(userCtx!.content, /Declared dimension hierarchies/);
  });

  it("buildChunksForSession includes both permanentContext and hierarchies when both exist", () => {
    const doc = makeDoc({
      permanentContext: "VN region.",
      sessionAnalysisContext: sacWithHierarchy,
    });
    const chunks = buildChunksForSession({ doc });
    const userCtx = chunks.find((c) => c.chunkType === "user_context");
    assert.ok(userCtx);
    assert.match(userCtx!.content, /VN region\./);
    assert.match(userCtx!.content, /FEMALE SHOWER GEL/);
  });

  it("buildChunksForSession omits user_context chunk when neither exists", () => {
    const doc = makeDoc({});
    const chunks = buildChunksForSession({ doc });
    const userCtx = chunks.find((c) => c.chunkType === "user_context");
    assert.equal(userCtx, undefined);
  });
});

describe("H5 · shouldExtractUserHierarchies regex pre-check", () => {
  it("matches typical hierarchy declarations", () => {
    assert.equal(
      shouldExtractUserHierarchies(
        "FEMALE SHOWER GEL is the entire category. Marico is a product within it."
      ),
      true
    );
    assert.equal(
      shouldExtractUserHierarchies("All Regions is the grand total"),
      true
    );
    assert.equal(
      shouldExtractUserHierarchies("Marico, Purite, Oliv are products within FEMALE SHOWER GEL"),
      true
    );
    assert.equal(
      shouldExtractUserHierarchies("'Total' rolls up the rest of the rows"),
      true
    );
  });

  it("does not match routine analytical questions", () => {
    assert.equal(shouldExtractUserHierarchies("What are sales by region?"), false);
    assert.equal(
      shouldExtractUserHierarchies("Show me the top 5 products by revenue"),
      false
    );
    assert.equal(shouldExtractUserHierarchies("trend of monthly sales"), false);
    assert.equal(shouldExtractUserHierarchies(""), false);
    assert.equal(shouldExtractUserHierarchies(undefined), false);
  });
});
