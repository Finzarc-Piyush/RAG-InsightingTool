import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionDataNotMaterializedError } from "../lib/columnarStorage.js";
import { loadLatestData } from "../utils/dataLoader.js";
import type { ChatDocument } from "../models/chat.model.js";

test("loadLatestData authoritative mode rejects tiny row set vs large declared rowCount", async () => {
  const chat = {
    sessionId: "auth_row_test",
    username: "u@test",
    fileName: "f.csv",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    dataSummary: {
      rowCount: 50_000,
      columnCount: 2,
      columns: [
        { name: "A", type: "string" as const },
        { name: "B", type: "number" as const },
      ],
      numericColumns: ["B"],
      dateColumns: [],
    },
    messages: [],
    charts: [],
    insights: [],
    rawData: [{ A: "x", B: 1 }],
    sampleRows: [],
    columnStatistics: {},
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: "test",
      fileSize: 0,
      analysisVersion: "1",
    },
  } as unknown as ChatDocument;

  await assert.rejects(
    () =>
      loadLatestData(chat, undefined, undefined, {
        mode: "authoritativeRematerialize",
      }),
    (e: unknown) => e instanceof SessionDataNotMaterializedError
  );
});

test("loadLatestData authoritative mode returns rawData and skips sample-only when large rowCount", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: i, v: i }));
  const chat = {
    sessionId: "auth_ok_test",
    username: "u@test",
    fileName: "f.csv",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    dataSummary: {
      rowCount: 300,
      columnCount: 2,
      columns: [
        { name: "id", type: "number" as const },
        { name: "v", type: "number" as const },
      ],
      numericColumns: ["id", "v"],
      dateColumns: [],
    },
    messages: [],
    charts: [],
    insights: [],
    rawData: rows,
    sampleRows: [{ id: 0, v: 0 }],
    columnStatistics: {},
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: "test",
      fileSize: 0,
      analysisVersion: "1",
    },
  } as unknown as ChatDocument;

  const out = await loadLatestData(chat, undefined, undefined, {
    mode: "authoritativeRematerialize",
  });
  assert.equal(out.length, 300);
});
