import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PIVOT_INLINE_MAX_BYTES,
  PIVOT_INLINE_MAX_ROWS,
  analysisMemoryEntryTypeSchema,
  analysisMemoryEntrySchema,
  messageSchema,
  pastAnalysisDocSchema,
  pastAnalysisPivotArtifactSchema,
  pastAnalysisPivotArtifactStorageSchema,
} from "../shared/schema.js";

/**
 * AMR1 · pin the schema extensions that unlock cross-session rich recall:
 *   1. PastAnalysisDoc carries answerEnvelope / businessActions /
 *      pivotArtifacts / investigationSummary optionally.
 *   2. Pre-AMR docs (no new fields) still parse cleanly — back-compat.
 *   3. Pivot artifact storage is a discriminated union (inline | blob).
 *   4. Inline cap constants are exposed.
 *   5. analysis_memory entry types include "pivot_computed" and
 *      "answer_summary".
 *   6. Message carries `recalledFromPriorAnalysis` + `pivotArtifacts` on
 *      cache-hit assistant messages.
 */

const baseDoc = () => ({
  id: "session_abc__turn_001",
  sessionId: "session_abc",
  userId: "user@example.com",
  turnId: "turn_001",
  dataVersion: 1,
  question: "Top 10 SKUs by value sales in Q3",
  normalizedQuestion: "top 10 skus by value sales in q3",
  answer: "MARICO leads at 88% of category value sales in Q3.",
  charts: [],
  toolCalls: [],
  costUsd: 0.05,
  latencyMs: 12_000,
  tokenTotals: { input: 4000, output: 800 },
  outcome: "ok" as const,
  feedback: "none" as const,
  feedbackReasons: [],
  feedbackDetails: [],
  createdAt: Date.now(),
});

describe("AMR1 · past_analyses extensions", () => {
  it("inline cap constants match the user-confirmed policy (≤2000 rows, ≤200KB)", () => {
    assert.equal(PIVOT_INLINE_MAX_ROWS, 2000);
    assert.equal(PIVOT_INLINE_MAX_BYTES, 200_000);
  });

  it("pre-AMR document still parses (no new fields → back-compat)", () => {
    const parsed = pastAnalysisDocSchema.parse(baseDoc());
    assert.equal(parsed.answerEnvelope, undefined);
    assert.equal(parsed.businessActions, undefined);
    assert.equal(parsed.pivotArtifacts, undefined);
    assert.equal(parsed.investigationSummary, undefined);
  });

  it("round-trips with full AMR payload (envelope + actions + pivot + investigation)", () => {
    const doc = {
      ...baseDoc(),
      answerEnvelope: {
        tldr: "MARICO leads at 88% of category value sales in Q3.",
        findings: [
          { headline: "MARICO 88% share", evidence: "Sums Q3 value sales by SKU" },
        ],
      },
      businessActions: [
        {
          title: "Defend MARICO shelf share in Q4",
          rationale: "88% category share is concentration risk if a competitor moves",
          horizon: "this_quarter" as const,
          confidence: "high" as const,
        },
      ],
      pivotArtifacts: [
        {
          artifactId: "abc123",
          questionContext: "Top 10 SKUs by Q3 value sales",
          plan: { groupBy: ["Products"], aggregations: [] },
          pivotDefaults: {
            rows: ["Products"],
            values: ["Value"],
            columns: [],
            filterFields: [],
          },
          columnHeaders: ["Products", "Value"],
          rowCount: 10,
          storage: { kind: "inline" as const, rows: [{ Products: "MARICO", Value: 2200 }] },
        },
      ],
      investigationSummary: {
        hypotheses: [
          { text: "MARICO concentrates Q3 share", status: "confirmed" as const, evidenceCount: 3 },
        ],
        findings: [{ label: "MARICO 88% share", significance: "anomalous" as const }],
        openQuestions: [],
      },
    };
    const parsed = pastAnalysisDocSchema.parse(doc);
    assert.equal(parsed.answerEnvelope?.tldr, doc.answerEnvelope.tldr);
    assert.equal(parsed.businessActions?.length, 1);
    assert.equal(parsed.pivotArtifacts?.length, 1);
    assert.equal(parsed.pivotArtifacts?.[0]?.storage.kind, "inline");
    assert.equal(parsed.investigationSummary?.findings?.length, 1);
  });

  it("caps pivotArtifacts at 12 entries", () => {
    const doc = {
      ...baseDoc(),
      pivotArtifacts: Array.from({ length: 13 }, (_, i) => ({
        artifactId: `id_${i}`,
        plan: {},
        pivotDefaults: { rows: [], values: [], columns: [], filterFields: [] },
        columnHeaders: [],
        rowCount: 0,
        storage: { kind: "inline" as const, rows: [] },
      })),
    };
    assert.throws(() => pastAnalysisDocSchema.parse(doc));
  });
});

describe("AMR1 · pivot artifact storage discriminated union", () => {
  it("accepts an inline storage shape", () => {
    const parsed = pastAnalysisPivotArtifactStorageSchema.parse({
      kind: "inline",
      rows: [{ a: 1 }, { a: 2 }],
    });
    assert.equal(parsed.kind, "inline");
  });

  it("accepts a blob storage shape", () => {
    const parsed = pastAnalysisPivotArtifactStorageSchema.parse({
      kind: "blob",
      blobName: "past-analyses-pivots/abc.json",
      bytes: 320_000,
    });
    assert.equal(parsed.kind, "blob");
  });

  it("rejects a mixed shape (no inline rows AND no blob ref)", () => {
    assert.throws(() =>
      pastAnalysisPivotArtifactStorageSchema.parse({ kind: "inline" })
    );
    assert.throws(() =>
      pastAnalysisPivotArtifactStorageSchema.parse({ kind: "blob", bytes: 0 })
    );
  });

  it("rejects an unknown discriminator", () => {
    assert.throws(() =>
      pastAnalysisPivotArtifactStorageSchema.parse({ kind: "mixed", rows: [] })
    );
  });

  it("artifact-level schema requires a stable id + non-empty plan shape", () => {
    const ok = pastAnalysisPivotArtifactSchema.parse({
      artifactId: "x",
      plan: {},
      pivotDefaults: { rows: [], values: [], columns: [], filterFields: [] },
      columnHeaders: [],
      rowCount: 0,
      storage: { kind: "inline", rows: [] },
    });
    assert.equal(ok.artifactId, "x");
    assert.throws(() =>
      pastAnalysisPivotArtifactSchema.parse({
        artifactId: "",
        plan: {},
        pivotDefaults: { rows: [], values: [], columns: [], filterFields: [] },
        columnHeaders: [],
        rowCount: 0,
        storage: { kind: "inline", rows: [] },
      })
    );
  });
});

describe("AMR1 · analysis_memory entry types", () => {
  it("accepts pivot_computed", () => {
    assert.doesNotThrow(() =>
      analysisMemoryEntryTypeSchema.parse("pivot_computed")
    );
  });

  it("accepts answer_summary", () => {
    assert.doesNotThrow(() =>
      analysisMemoryEntryTypeSchema.parse("answer_summary")
    );
  });

  it("rejects an unknown entry type", () => {
    assert.throws(() => analysisMemoryEntryTypeSchema.parse("invented_type"));
  });

  it("round-trips a pivot_computed entry with a blob artifact ref body", () => {
    const entry = {
      id: "session_x__turn_y__pivot_computed__0",
      sessionId: "session_x",
      username: "user@example.com",
      createdAt: Date.now(),
      turnId: "turn_y",
      sequence: 0,
      type: "pivot_computed" as const,
      actor: "agent" as const,
      title: "Pivot: Top 10 SKUs by value sales",
      summary: "MARICO leads at 88% of category in Q3 value sales.",
      body: {
        artifactRef: {
          artifactId: "abc123",
          storage: { kind: "blob" as const, blobName: "p/abc.json", bytes: 320_000 },
        },
        columnHeaders: ["Products", "Value"],
        rowCount: 10,
      },
    };
    const parsed = analysisMemoryEntrySchema.parse(entry);
    assert.equal(parsed.type, "pivot_computed");
  });
});

describe("AMR1 · Message.recalledFromPriorAnalysis", () => {
  it("round-trips a cache-hit assistant message", () => {
    const msg = {
      role: "assistant" as const,
      content: "MARICO leads at 88% of category value sales in Q3.",
      timestamp: Date.now(),
      recalledFromPriorAnalysis: {
        originalSessionId: "session_old",
        originalTurnId: "turn_old",
        originalCreatedAt: Date.now() - 1000 * 60 * 60 * 24,
        matchKind: "exact" as const,
      },
      pivotArtifacts: [
        {
          artifactId: "abc",
          plan: {},
          pivotDefaults: { rows: ["Products"], values: ["Value"], columns: [], filterFields: [] },
          columnHeaders: ["Products", "Value"],
          rowCount: 10,
          storage: { kind: "inline" as const, rows: [{ Products: "MARICO", Value: 2200 }] },
        },
      ],
    };
    const parsed = messageSchema.parse(msg);
    assert.equal(parsed.recalledFromPriorAnalysis?.matchKind, "exact");
    assert.equal(parsed.pivotArtifacts?.length, 1);
  });

  it("fresh agent turn (no recall fields) still parses", () => {
    const parsed = messageSchema.parse({
      role: "assistant",
      content: "Fresh answer",
      timestamp: Date.now(),
    });
    assert.equal(parsed.recalledFromPriorAnalysis, undefined);
    assert.equal(parsed.pivotArtifacts, undefined);
  });

  it("rejects unknown matchKind", () => {
    assert.throws(() =>
      messageSchema.parse({
        role: "assistant",
        content: "x",
        timestamp: Date.now(),
        recalledFromPriorAnalysis: {
          originalSessionId: "s",
          originalTurnId: "t",
          originalCreatedAt: 0,
          matchKind: "fuzzy",
        },
      })
    );
  });
});
