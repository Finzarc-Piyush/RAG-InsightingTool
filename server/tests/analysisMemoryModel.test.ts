import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analysisMemoryEntrySchema,
  analysisMemoryEntryTypeSchema,
  analysisMemoryActorSchema,
  type AnalysisMemoryEntry,
} from "../shared/schema.js";
import { buildMemoryEntryId } from "../models/analysisMemory.model.js";

const validEntry = (
  overrides: Partial<AnalysisMemoryEntry> = {}
): AnalysisMemoryEntry => ({
  id: "session_abc__turn_001__finding__0",
  sessionId: "session_abc",
  username: "user@example.com",
  createdAt: 1_773_000_000_000,
  turnId: "turn_001",
  sequence: 0,
  type: "finding",
  actor: "agent",
  title: "East region tech sales declined 23% Mar→Apr",
  summary:
    "Q1 sales drop concentrated in East tech category; magnitude exceeds the historical seasonal pattern by 11pp.",
  body: { evidence: "compute_query_plan call abc123" },
  refs: { messageTimestamp: 1_773_000_000_000 },
  dataVersion: 1,
  significance: "anomalous",
  ...overrides,
});

describe("analysisMemoryEntrySchema", () => {
  it("accepts a fully-populated valid entry", () => {
    const r = analysisMemoryEntrySchema.safeParse(validEntry());
    assert.strictEqual(r.success, true);
  });

  it("accepts a lifecycle entry without turnId", () => {
    const { turnId: _drop, ...rest } = validEntry();
    const r = analysisMemoryEntrySchema.safeParse({
      ...rest,
      type: "analysis_created",
      title: "Dataset uploaded",
      summary: "Q1 sales.csv • 12,503 rows • 18 columns",
    });
    assert.strictEqual(r.success, true);
  });

  it("rejects negative sequence", () => {
    const r = analysisMemoryEntrySchema.safeParse(validEntry({ sequence: -1 }));
    assert.strictEqual(r.success, false);
  });

  it("rejects fractional sequence", () => {
    const r = analysisMemoryEntrySchema.safeParse(validEntry({ sequence: 1.5 }));
    assert.strictEqual(r.success, false);
  });

  it("rejects empty title", () => {
    const r = analysisMemoryEntrySchema.safeParse(validEntry({ title: "" }));
    assert.strictEqual(r.success, false);
  });

  it("caps title at 200 chars", () => {
    const r = analysisMemoryEntrySchema.safeParse(
      validEntry({ title: "x".repeat(201) })
    );
    assert.strictEqual(r.success, false);
  });

  it("caps summary at 1500 chars", () => {
    const r = analysisMemoryEntrySchema.safeParse(
      validEntry({ summary: "x".repeat(1501) })
    );
    assert.strictEqual(r.success, false);
  });

  it("rejects unknown entry type", () => {
    const r = analysisMemoryEntrySchema.safeParse(
      validEntry({ type: "mystery" as never })
    );
    assert.strictEqual(r.success, false);
  });

  it("rejects unknown actor", () => {
    const r = analysisMemoryEntrySchema.safeParse(
      validEntry({ actor: "robot" as never })
    );
    assert.strictEqual(r.success, false);
  });

  it("rejects negative dataVersion", () => {
    const r = analysisMemoryEntrySchema.safeParse(
      validEntry({ dataVersion: -1 })
    );
    assert.strictEqual(r.success, false);
  });

  it("rejects missing required fields", () => {
    for (const field of [
      "id",
      "sessionId",
      "username",
      "createdAt",
      "sequence",
      "type",
      "actor",
      "title",
    ] as const) {
      const doc = validEntry();
      // @ts-expect-error — deliberately removing a required key
      delete doc[field];
      assert.strictEqual(
        analysisMemoryEntrySchema.safeParse(doc).success,
        false,
        `expected missing ${field} to fail validation`
      );
    }
  });

  it("entry-type enum is exhaustive (W56 / W65 design)", () => {
    const all = [...analysisMemoryEntryTypeSchema.options].sort();
    assert.deepStrictEqual(all, [
      "analysis_created",
      "chart_created",
      "computed_column_added",
      "conclusion",
      "dashboard_drafted",
      "dashboard_patched",
      "dashboard_promoted",
      "data_op",
      "enrichment_complete",
      "filter_applied",
      "finding",
      "hypothesis",
      "question_asked",
      "user_note",
    ]);
  });

  it("actor enum is exhaustive", () => {
    assert.deepStrictEqual(
      [...analysisMemoryActorSchema.options].sort(),
      ["agent", "system", "user"]
    );
  });
});

describe("buildMemoryEntryId", () => {
  it("produces deterministic ids for the same tuple — replays upsert cleanly", () => {
    const a = buildMemoryEntryId("sess_1", "finding", 3, "turn_a");
    const b = buildMemoryEntryId("sess_1", "finding", 3, "turn_a");
    assert.strictEqual(a, b);
    assert.strictEqual(a, "sess_1__turn_a__finding__3");
  });

  it("uses 'lifecycle' bucket when turnId is omitted", () => {
    const id = buildMemoryEntryId("sess_1", "analysis_created", 0);
    assert.strictEqual(id, "sess_1__lifecycle__analysis_created__0");
  });

  it("differentiates by sequence so multiple findings in one turn don't collide", () => {
    const a = buildMemoryEntryId("sess_1", "finding", 0, "turn_a");
    const b = buildMemoryEntryId("sess_1", "finding", 1, "turn_a");
    assert.notStrictEqual(a, b);
  });

  it("differentiates by type so a hypothesis and a finding don't collide on the same sequence", () => {
    const a = buildMemoryEntryId("sess_1", "hypothesis", 0, "turn_a");
    const b = buildMemoryEntryId("sess_1", "finding", 0, "turn_a");
    assert.notStrictEqual(a, b);
  });
});
