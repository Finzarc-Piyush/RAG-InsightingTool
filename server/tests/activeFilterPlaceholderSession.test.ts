/**
 * Regression: GET /api/sessions/:id/active-filter must NOT 500 while a session
 * is still a placeholder (upload in flight). The client polls this endpoint on
 * mount before the upload finishes materializing data; at that point the doc has
 * `dataSummary.rowCount: 0` and every data source is empty, so `loadLatestData`
 * would throw "No data found". `buildResponseFromDoc` short-circuits on
 * `rowCount === 0` and returns a clean empty-shape response instead.
 *
 * Because the short-circuit runs before `loadLatestData`, these assertions need
 * no blob/Cosmos mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatDocument } from "../models/chat.model.js";
import { buildResponseFromDoc } from "../controllers/activeFilterController.js";
import type { ActiveFilterSpec } from "../shared/schema.js";

/** Minimal placeholder doc, mirroring createPlaceholderSession's output. */
function placeholderDoc(
  overrides: Partial<ChatDocument> = {}
): ChatDocument {
  return {
    id: "chat_placeholder",
    username: "tester@example.com",
    fileName: "pending.xlsx",
    uploadedAt: 0,
    createdAt: 0,
    lastUpdatedAt: 0,
    sessionId: "session_placeholder",
    dataSummary: {
      rowCount: 0,
      columnCount: 0,
      columns: [],
      numericColumns: [],
      dateColumns: [],
    },
    messages: [],
    charts: [],
    insights: [],
    rawData: [],
    sampleRows: [],
    columnStatistics: {},
    collaborators: ["tester@example.com"],
    enrichmentStatus: "pending",
    ...overrides,
  } as ChatDocument;
}

test("placeholder session (rowCount 0) → empty-shape response, no throw", async () => {
  const out = await buildResponseFromDoc(placeholderDoc());
  assert.deepEqual(out, {
    ok: true,
    activeFilter: null,
    totalRows: 0,
    filteredRows: 0,
    preview: [],
    previewTruncated: false,
    effectiveConditionCount: 0,
  });
});

test("placeholder session with an active filter → spec echoed, conditions counted", async () => {
  const spec: ActiveFilterSpec = {
    conditions: [
      { kind: "in", column: "Region", values: ["North"] },
    ],
    version: 3,
    updatedAt: 1234,
  };
  const out = await buildResponseFromDoc(placeholderDoc({ activeFilter: spec }));
  assert.equal(out.ok, true);
  assert.equal(out.totalRows, 0);
  assert.equal(out.filteredRows, 0);
  assert.deepEqual(out.preview, []);
  assert.equal(out.previewTruncated, false);
  assert.deepEqual(out.activeFilter, spec);
  assert.equal(out.effectiveConditionCount, 1);
});
