import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAnalysisCreatedEntry,
  buildEnrichmentCompleteEntry,
  buildDashboardPromotedEntry,
  buildComputedColumnEntry,
  buildDataOpEntry,
  buildUserNoteEntry,
} from "../lib/agents/runtime/memoryLifecycleBuilders.js";

describe("W59 · lifecycle builders", () => {
  it("analysis_created: stable id and human-readable summary", () => {
    const e = buildAnalysisCreatedEntry({
      sessionId: "s1",
      username: "u@example.com",
      fileName: "Q1.csv",
      fileSize: 2 * 1024 * 1024,
      createdAt: 1_773_000_000_000,
    });
    assert.strictEqual(e.type, "analysis_created");
    assert.strictEqual(e.actor, "system");
    assert.strictEqual(e.id, "s1__lifecycle__analysis_created__0");
    assert.match(e.summary, /Q1\.csv \(2\.00 MB\)/);
  });

  it("enrichment_complete: row/col count surfaces in the title", () => {
    const e = buildEnrichmentCompleteEntry({
      sessionId: "s1",
      username: "u@example.com",
      rowCount: 12_503,
      columnCount: 18,
      suggestedQuestions: ["What drove the Q1 dip?", "Which region grew?"],
      createdAt: 1_773_000_000_000,
    });
    assert.strictEqual(e.type, "enrichment_complete");
    assert.match(e.title, /12,503 rows × 18 cols/);
    assert.match(e.summary, /Starter prompts/);
  });

  it("dashboard_promoted: refs.dashboardId is set so the user can navigate back", () => {
    const e = buildDashboardPromotedEntry({
      sessionId: "s1",
      username: "u@example.com",
      dashboardId: "Q1_Sales_Review_1773000000000",
      dashboardName: "Q1 Sales Review",
      sheetCount: 3,
      chartCount: 7,
      createdAt: 1_773_000_000_000,
    });
    assert.strictEqual(e.type, "dashboard_promoted");
    assert.strictEqual(e.refs?.dashboardId, "Q1_Sales_Review_1773000000000");
    assert.match(e.title, /Q1 Sales Review/);
    assert.match(e.summary, /3 sheet/);
    assert.match(e.summary, /7 chart/);
  });

  it("computed_column_added: persistedToBlob flag flows into the summary", () => {
    const persisted = buildComputedColumnEntry({
      sessionId: "s1",
      username: "u@example.com",
      columns: [
        {
          name: "days_to_close",
          def: {
            type: "date_diff_days",
            startColumn: "Open",
            endColumn: "Close",
          },
        },
      ],
      persistedToBlob: true,
      createdAt: 1_773_000_000_000,
      turnId: "turn_1",
    });
    assert.match(persisted.summary, /Persisted/);
    assert.match(persisted.title, /days_to_close/);

    const inMemory = buildComputedColumnEntry({
      sessionId: "s1",
      username: "u@example.com",
      columns: [
        {
          name: "ratio",
          def: {
            type: "numeric_binary",
            op: "divide",
            leftColumn: "Sales",
            rightColumn: "Cost",
          },
        },
      ],
      persistedToBlob: false,
      createdAt: 1_773_000_000_001,
      turnId: "turn_1",
    });
    assert.match(inMemory.summary, /in-memory/);
    assert.match(inMemory.summary, /Sales divide Cost/);
  });

  it("data_op: reports row delta with sign and version", () => {
    const e = buildDataOpEntry({
      sessionId: "s1",
      username: "u@example.com",
      operation: "filter",
      description: "Filter Region in [East, West]",
      dataVersion: 4,
      rowsBefore: 12_503,
      rowsAfter: 8_211,
      createdAt: 1_773_000_000_000,
    });
    assert.strictEqual(e.type, "data_op");
    assert.match(e.title, /filter → v4/);
    assert.match(e.summary, /12,503 → 8,211/);
    assert.match(e.summary, /-4292/);
    assert.strictEqual(e.dataVersion, 4);
  });

  it("user_note: returns null on empty text, builds entry with quoted preview otherwise", () => {
    assert.strictEqual(
      buildUserNoteEntry({
        sessionId: "s1",
        username: "u@example.com",
        noteText: "   ",
        createdAt: 1_773_000_000_000,
      }),
      null
    );
    const e = buildUserNoteEntry({
      sessionId: "s1",
      username: "u@example.com",
      noteText: "Focus on Q1 anomalies.",
      createdAt: 1_773_000_000_000,
    });
    assert.ok(e);
    assert.strictEqual(e!.type, "user_note");
    assert.match(e!.summary, /"Focus on Q1 anomalies\."/);
  });
});
