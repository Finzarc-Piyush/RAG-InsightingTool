/**
 * Wave QL5 · `validateAndEnrichResponse` strips raw `pivotArtifacts` before
 * Zod validation and re-attaches them after.
 *
 * The agent loop emits RAW pivot artifacts (with `rows`) into
 * `loopResult.pivotArtifacts`. The schema in `chatResponseSchema` expects
 * the materialized form (with `artifactId` / `rowCount` / `storage`) that
 * the async materializer downstream produces. Pre-QL5 this mismatch crashed
 * the chat-response validation with a Zod error, blocking dashboard creation
 * and surfacing as 7+ "invalid_type Required" errors in the SSE error event.
 *
 * Behaviour-neutral for legacy turns that don't carry pivotArtifacts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAndEnrichResponse } from "../services/chat/chatResponse.service.js";
import type { ChatDocument } from "../shared/schema.js";

const chatDoc = {
  id: "ql5-fixture",
  sessionId: "ql5-fixture",
  dataSummary: {
    rowCount: 8,
    columnCount: 2,
    columns: [
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: [],
  },
} as unknown as ChatDocument;

function baseResponse() {
  return {
    answer:
      "Cluster 1 EAST averages 4.2 daily compliance visits, leading the cohort.",
    charts: [],
    insights: [],
  };
}

describe("Wave QL5 · validateAndEnrichResponse pivotArtifacts strip", () => {
  it("does not crash when the response carries RAW pivotArtifacts (the failing scenario)", () => {
    const rawArtifacts = [
      {
        // Raw shape — matches RawPivotArtifact, NOT
        // pastAnalysisPivotArtifactSchema. Pre-QL5 this would fail with
        // "Required artifactId / rowCount / storage".
        sessionId: "ql5-fixture",
        turnId: "tn1",
        stepId: "ql2_synth_abc",
        plan: { groupBy: ["Cluster Name"], aggregations: [] },
        pivotDefaults: { rows: ["Cluster Name"], values: ["Compliance Visit"] },
        columnHeaders: ["Cluster Name", "Compliance Visit"],
        rows: [
          { "Cluster Name": "Cluster 1 EAST", "Compliance Visit": 4.2 },
          { "Cluster Name": "Bengal North", "Compliance Visit": 3.8 },
        ],
      },
    ];
    const response = { ...baseResponse(), pivotArtifacts: rawArtifacts };
    // Pre-QL5: this throws a ZodError. Post-QL5: passes, raw artifacts
    // pass through as a sidecar for the downstream materializer.
    const result = validateAndEnrichResponse(response, chatDoc);
    assert.ok(result, "should return a validated response");
    assert.deepEqual(
      (result as { pivotArtifacts?: unknown }).pivotArtifacts,
      rawArtifacts,
      "raw artifacts should be preserved on the validated result"
    );
  });

  it("does not crash when the response carries 7 raw pivotArtifacts (Marico-VN error reproduction)", () => {
    const sevenArtifacts = Array.from({ length: 7 }, (_, i) => ({
      sessionId: "ql5-fixture",
      turnId: "tn1",
      stepId: `s${i}`,
      plan: {},
      pivotDefaults: { rows: [], values: [] },
      columnHeaders: ["a"],
      rows: [],
    }));
    const response = { ...baseResponse(), pivotArtifacts: sevenArtifacts };
    const result = validateAndEnrichResponse(response, chatDoc);
    assert.equal(
      (result as { pivotArtifacts?: unknown[] }).pivotArtifacts?.length,
      7
    );
  });

  it("is a no-op when the response carries no pivotArtifacts", () => {
    const result = validateAndEnrichResponse(baseResponse(), chatDoc);
    assert.ok(result);
    assert.equal(
      (result as { pivotArtifacts?: unknown }).pivotArtifacts,
      undefined
    );
  });

  it("preserves materialized-shape pivotArtifacts unchanged when the producer DID materialize", () => {
    const materialized = [
      {
        artifactId: "ses-tn-s1",
        plan: {},
        pivotDefaults: { rows: ["x"], values: ["y"] },
        columnHeaders: ["x", "y"],
        rowCount: 5,
        storage: { kind: "inline", rows: [{ x: 1, y: 2 }] },
      },
    ];
    const response = { ...baseResponse(), pivotArtifacts: materialized };
    const result = validateAndEnrichResponse(response, chatDoc);
    assert.deepEqual(
      (result as { pivotArtifacts?: unknown }).pivotArtifacts,
      materialized
    );
  });
});
