import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  suggestedColumnsFromHits,
  formatHitsForPrompt,
} from "../lib/rag/retrieveHelpers.js";
import type { RagHit } from "../lib/rag/ragHit.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  rowCount: 10,
  columnCount: 3,
  columns: [
    { name: "Revenue", type: "number", sampleValues: [1] },
    { name: "Region", type: "string", sampleValues: ["East"] },
    { name: "SKU", type: "string", sampleValues: ["A"] },
  ],
  numericColumns: ["Revenue"],
  dateColumns: [],
};

describe("RAG retrieve helpers", () => {
  it("suggestedColumnsFromHits finds column names in hit text", () => {
    const hits: RagHit[] = [
      {
        chunkId: "a",
        chunkType: "sample",
        content: "Region East Revenue 100",
      },
    ];
    const cols = suggestedColumnsFromHits(hits, summary);
    assert.ok(cols.includes("Revenue"));
    assert.ok(cols.includes("Region"));
    assert.ok(!cols.includes("SKU"));
  });

  it("formatHitsForPrompt joins chunk blocks under maxChars", () => {
    const hits: RagHit[] = [
      { chunkId: "1", chunkType: "summary", content: "hello" },
      { chunkId: "2", chunkType: "row", content: "world" },
    ];
    const out = formatHitsForPrompt(hits, 500);
    assert.match(out, /summary:1/);
    assert.match(out, /row:2/);
    assert.match(out, /hello/);
  });

  it("formatHitsForPrompt returns empty for no hits", () => {
    assert.equal(formatHitsForPrompt([]), "");
  });
});
