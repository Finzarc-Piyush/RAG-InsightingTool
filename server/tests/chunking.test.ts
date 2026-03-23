import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChunksForSession } from "../lib/rag/chunking.js";
import type { ChatDocument } from "../models/chat.model.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  rowCount: 100,
  columnCount: 2,
  columns: [
    { name: "A", type: "number", sampleValues: [1] },
    { name: "B", type: "string", sampleValues: ["x"] },
  ],
  numericColumns: ["A"],
  dateColumns: [],
};

describe("RAG chunking", () => {
  it("buildChunksForSession always includes summary chunk", () => {
    const doc = {
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
      sessionId: "s",
      rawData: [],
      sampleRows: [],
      columnStatistics: {},
      analysisMetadata: {
        totalProcessingTime: 0,
        aiModelUsed: "x",
        fileSize: 0,
        analysisVersion: "1",
      },
    } as ChatDocument;

    const chunks = buildChunksForSession({ doc });
    assert.ok(chunks.some((c) => c.chunkType === "summary"));
    assert.ok(chunks[0].content.includes("A"));
  });

  it("buildChunksForSession adds sample and row windows for in-memory data", () => {
    const doc = {
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
      sessionId: "s",
      rawData: [],
      sampleRows: [{ A: 1, B: "z" }],
      columnStatistics: {},
      analysisMetadata: {
        totalProcessingTime: 0,
        aiModelUsed: "x",
        fileSize: 0,
        analysisVersion: "1",
      },
    } as ChatDocument;

    const dataRows = Array.from({ length: 120 }, (_, i) => ({ A: i, B: `r${i}` }));
    const chunks = buildChunksForSession({ doc, dataRows });
    assert.ok(chunks.some((c) => c.chunkType === "sample"));
    assert.ok(chunks.some((c) => c.chunkType === "rows"));
  });
});
