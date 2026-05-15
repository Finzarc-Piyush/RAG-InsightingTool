import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCachedResponsePayload } from "../lib/cache/buildCachedResponsePayload.js";
import type { PastAnalysisDoc, PastAnalysisPivotArtifact } from "../shared/schema.js";

/**
 * AMR4 · The cache-hit response payload assembly is the contract between
 * `serveCachedExactAnswer` and the client `useHomeMutations` cache-hit
 * branch. Pin the shape so a future refactor can't silently regress to
 * the pre-AMR4 plain-text rendering.
 */

const baseDoc = (
  overrides: Partial<PastAnalysisDoc> = {}
): PastAnalysisDoc => ({
  id: "s_old__t_old",
  sessionId: "s_old",
  userId: "user@example.com",
  turnId: "t_old",
  dataVersion: 1,
  question: "Top 10 SKUs by Q3 value sales",
  normalizedQuestion: "top 10 skus by q3 value sales",
  answer: "MARICO leads at 88% of category value sales in Q3.",
  charts: [],
  toolCalls: [],
  costUsd: 0.05,
  latencyMs: 12_000,
  tokenTotals: { input: 4000, output: 800 },
  outcome: "ok",
  feedback: "none",
  feedbackReasons: [],
  feedbackDetails: [],
  createdAt: 1_700_000_000_000,
  ...overrides,
});

const inlinePivot = (
  overrides: Partial<PastAnalysisPivotArtifact> = {}
): PastAnalysisPivotArtifact => ({
  artifactId: "a_inline",
  plan: { groupBy: ["Products"], aggregations: [] },
  pivotDefaults: { rows: ["Products"], values: ["Value"] },
  columnHeaders: ["Products", "Value"],
  rowCount: 2,
  storage: {
    kind: "inline",
    rows: [
      { Products: "MARICO", Value: 2200 },
      { Products: "PURITE", Value: 1700 },
    ],
  },
  ...overrides,
});

const blobPivot = (
  overrides: Partial<PastAnalysisPivotArtifact> = {}
): PastAnalysisPivotArtifact => ({
  artifactId: "a_blob",
  plan: { groupBy: ["Markets"], aggregations: [] },
  pivotDefaults: { rows: ["Markets"], values: ["Value"] },
  columnHeaders: ["Markets", "Value"],
  rowCount: 3500,
  storage: {
    kind: "blob",
    blobName: "past-analyses-pivots/abc.json",
    bytes: 420_000,
  },
  ...overrides,
});

describe("AMR4 · buildCachedResponsePayload · happy path with full rich doc", () => {
  it("populates envelope / charts / pivot / business actions on the response payload", () => {
    const doc = baseDoc({
      answerEnvelope: { tldr: "MARICO leads Q3" },
      businessActions: [
        {
          title: "Defend MARICO shelf share in Q4",
          rationale: "88% category concentration is a risk",
          horizon: "this_quarter",
          confidence: "high",
        },
      ],
      investigationSummary: {
        findings: [{ label: "MARICO 88% share", significance: "anomalous" }],
      },
      pivotArtifacts: [inlinePivot()],
    });
    const out = buildCachedResponsePayload({
      richDoc: doc,
      matchKind: "exact",
      originalSessionId: "s_old",
      originalTurnId: "t_old",
      fallbackAnswer: "fallback",
      fallbackCreatedAt: 0,
      cachedAgeMs: 12345,
    });
    assert.equal(out.responsePayload.cached, true);
    assert.equal(out.responsePayload.cachedAgeMs, 12345);
    assert.equal(out.responsePayload.answer, doc.answer);
    assert.deepEqual(out.responsePayload.answerEnvelope, doc.answerEnvelope);
    assert.deepEqual(out.responsePayload.businessActions, doc.businessActions);
    assert.deepEqual(
      out.responsePayload.investigationSummary,
      doc.investigationSummary
    );
    assert.deepEqual(out.responsePayload.pivotDefaults, {
      rows: ["Products"],
      values: ["Value"],
    });
    assert.equal(
      (out.responsePayload.pivotArtifacts as PastAnalysisPivotArtifact[])
        .length,
      1
    );
    assert.equal(
      (out.responsePayload.recalledFromPriorAnalysis as { matchKind: string })
        .matchKind,
      "exact"
    );
  });

  it("inline pivot artifacts ship their rows on the response (no on-demand fetch needed)", () => {
    const out = buildCachedResponsePayload({
      richDoc: baseDoc({ pivotArtifacts: [inlinePivot()] }),
      matchKind: "exact",
      originalSessionId: "s_old",
      originalTurnId: "t_old",
      fallbackAnswer: "x",
      fallbackCreatedAt: 0,
      cachedAgeMs: 0,
    });
    const artifacts = out.responsePayload.pivotArtifacts as PastAnalysisPivotArtifact[];
    assert.equal(artifacts[0]?.storage.kind, "inline");
    if (artifacts[0]?.storage.kind === "inline") {
      assert.equal(artifacts[0].storage.rows.length, 2);
    }
  });

  it("blob pivot artifacts ship metadata only — rows excluded; client fetches via AMR3c", () => {
    const out = buildCachedResponsePayload({
      richDoc: baseDoc({ pivotArtifacts: [blobPivot()] }),
      matchKind: "exact",
      originalSessionId: "s_old",
      originalTurnId: "t_old",
      fallbackAnswer: "x",
      fallbackCreatedAt: 0,
      cachedAgeMs: 0,
    });
    const artifacts = out.responsePayload.pivotArtifacts as PastAnalysisPivotArtifact[];
    assert.equal(artifacts[0]?.storage.kind, "blob");
    if (artifacts[0]?.storage.kind === "blob") {
      assert.equal(
        artifacts[0].storage.blobName,
        "past-analyses-pivots/abc.json"
      );
      assert.equal(artifacts[0].storage.bytes, 420_000);
      assert.equal(
        Object.prototype.hasOwnProperty.call(artifacts[0].storage, "rows"),
        false
      );
    }
  });

  it("primary pivot for pivotDefaults is the largest by rowCount when multiple captured", () => {
    const out = buildCachedResponsePayload({
      richDoc: baseDoc({
        pivotArtifacts: [
          inlinePivot({ artifactId: "small", rowCount: 5 }),
          blobPivot({ artifactId: "large", rowCount: 3500 }),
          inlinePivot({ artifactId: "tiny", rowCount: 2 }),
        ],
      }),
      matchKind: "exact",
      originalSessionId: "s_old",
      originalTurnId: "t_old",
      fallbackAnswer: "x",
      fallbackCreatedAt: 0,
      cachedAgeMs: 0,
    });
    // pivotDefaults should come from the LARGE (blob) pivot.
    assert.deepEqual(out.responsePayload.pivotDefaults, {
      rows: ["Markets"],
      values: ["Value"],
    });
  });
});

describe("AMR4 · buildCachedResponsePayload · null richDoc degrade", () => {
  it("falls back to text-only when richDoc is null", () => {
    const out = buildCachedResponsePayload({
      richDoc: null,
      matchKind: "semantic",
      originalSessionId: "s",
      originalTurnId: "t",
      fallbackAnswer: "plain text",
      fallbackCreatedAt: 999_000,
      cachedAgeMs: 42,
    });
    assert.equal(out.responsePayload.answer, "plain text");
    assert.deepEqual(out.responsePayload.charts, []);
    assert.equal(out.responsePayload.answerEnvelope, undefined);
    assert.equal(out.responsePayload.businessActions, undefined);
    assert.equal(out.responsePayload.investigationSummary, undefined);
    assert.equal(out.responsePayload.pivotDefaults, undefined);
    assert.equal(out.responsePayload.pivotArtifacts, undefined);
    assert.equal(
      (out.responsePayload.recalledFromPriorAnalysis as { matchKind: string })
        .matchKind,
      "semantic"
    );
    assert.equal(
      (out.responsePayload.recalledFromPriorAnalysis as { originalCreatedAt: number })
        .originalCreatedAt,
      999_000
    );
  });
});

describe("AMR4 · assistantMessageExtras mirror what the response carries", () => {
  it("only includes fields the rich doc actually had", () => {
    const out = buildCachedResponsePayload({
      richDoc: baseDoc({
        answerEnvelope: { tldr: "yes" },
        pivotArtifacts: [inlinePivot()],
        // no businessActions, no investigationSummary
      }),
      matchKind: "exact",
      originalSessionId: "s",
      originalTurnId: "t",
      fallbackAnswer: "x",
      fallbackCreatedAt: 0,
      cachedAgeMs: 0,
    });
    assert.equal(out.assistantMessageExtras.answerEnvelope?.tldr, "yes");
    assert.equal(out.assistantMessageExtras.businessActions, undefined);
    assert.equal(out.assistantMessageExtras.investigationSummary, undefined);
    assert.deepEqual(out.assistantMessageExtras.pivotDefaults, {
      rows: ["Products"],
      values: ["Value"],
    });
    assert.equal(out.assistantMessageExtras.pivotArtifacts?.length, 1);
    assert.equal(
      out.assistantMessageExtras.recalledFromPriorAnalysis?.matchKind,
      "exact"
    );
  });
});
