import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildArtifactId,
  decideStorageKind,
  materializePivotArtifact,
  previewMaterializedArtifact,
  type PivotBlobUploader,
  type RawPivotArtifact,
} from "../lib/pastAnalysisPivotArtifact.js";
import {
  PIVOT_INLINE_MAX_BYTES,
  PIVOT_INLINE_MAX_ROWS,
} from "../shared/schema.js";

/**
 * AMR3 · The materialisation policy is the contract between
 * `agentLoop.service.ts` (pushes raw captures) and the cross-session cache
 * (consumes blob/inline storage on cache-hit recall). Pin:
 *   - artifactId is deterministic on (sessionId, turnId, stepId).
 *   - inline-vs-blob threshold respects BOTH PIVOT_INLINE_MAX_ROWS AND
 *     PIVOT_INLINE_MAX_BYTES — fail either, go to blob.
 *   - blob path actually fires the uploader with the JSON payload.
 *   - inline path skips the uploader entirely.
 *   - idempotency: same raw → same artifactId → same blobName.
 */

const baseRaw = (overrides: Partial<RawPivotArtifact> = {}): RawPivotArtifact => ({
  sessionId: "session_abc",
  turnId: "turn_001",
  stepId: "exec_step_0",
  plan: { groupBy: ["Products"], aggregations: [] },
  pivotDefaults: {
    rows: ["Products"],
    values: ["Value"],
    columns: [],
    filterFields: [],
  },
  columnHeaders: ["Products", "Value"],
  rows: [{ Products: "MARICO", Value: 2200 }],
  questionContext: "Top 10 SKUs by Q3 value sales",
  ...overrides,
});

describe("AMR3 · buildArtifactId", () => {
  it("is deterministic for the same (sessionId, turnId, stepId) triple", () => {
    const a = buildArtifactId("s", "t", "x");
    const b = buildArtifactId("s", "t", "x");
    assert.equal(a, b);
  });

  it("differs across distinct triples", () => {
    const ids = new Set([
      buildArtifactId("s1", "t", "x"),
      buildArtifactId("s2", "t", "x"),
      buildArtifactId("s", "t1", "x"),
      buildArtifactId("s", "t", "x1"),
    ]);
    assert.equal(ids.size, 4);
  });

  it("produces a 32-char hex string (16 bytes of entropy)", () => {
    const id = buildArtifactId("s", "t", "x");
    assert.match(id, /^[0-9a-f]{32}$/);
  });
});

describe("AMR3 · decideStorageKind", () => {
  it("inline when rows ≤ cap AND bytes ≤ cap", () => {
    const verdict = decideStorageKind([{ a: 1 }, { a: 2 }]);
    assert.equal(verdict.kind, "inline");
    assert.ok(verdict.bytes < PIVOT_INLINE_MAX_BYTES);
  });

  it("blob when rows > PIVOT_INLINE_MAX_ROWS (even if bytes tiny)", () => {
    const rows = Array.from({ length: PIVOT_INLINE_MAX_ROWS + 1 }, (_, i) => ({ i }));
    const verdict = decideStorageKind(rows);
    assert.equal(verdict.kind, "blob");
  });

  it("blob when bytes > PIVOT_INLINE_MAX_BYTES (even if row count tiny)", () => {
    // Build a single row whose serialized form exceeds the byte cap.
    const big = "x".repeat(PIVOT_INLINE_MAX_BYTES + 100);
    const rows = [{ payload: big }];
    const verdict = decideStorageKind(rows);
    assert.equal(verdict.kind, "blob");
    assert.ok(verdict.bytes > PIVOT_INLINE_MAX_BYTES);
  });

  it("inline at the exact boundary of PIVOT_INLINE_MAX_ROWS (cap is inclusive)", () => {
    const rows = Array.from({ length: PIVOT_INLINE_MAX_ROWS }, () => ({ a: 1 }));
    const verdict = decideStorageKind(rows);
    // Either inline (bytes also under cap) or blob (rare — only if bytes
    // happen to exceed). For 2000 tiny rows of `{a:1}`, bytes ≪ 200KB so
    // inline is the expected path.
    assert.equal(verdict.kind, "inline");
  });
});

describe("AMR3 · previewMaterializedArtifact", () => {
  it("returns the deterministic id and computed kind without side-effects", () => {
    const preview = previewMaterializedArtifact(baseRaw());
    assert.match(preview.artifactId, /^[0-9a-f]{32}$/);
    assert.equal(preview.storageKind, "inline");
    assert.equal(
      preview.blobName,
      `past-analyses-pivots/${preview.artifactId}.json`
    );
  });

  it("flips to blob for a large row set", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i }));
    const preview = previewMaterializedArtifact(baseRaw({ rows: big }));
    assert.equal(preview.storageKind, "blob");
  });
});

describe("AMR3 · materializePivotArtifact", () => {
  it("inline path does NOT call the uploader and inlines rows verbatim", async () => {
    let uploadCalls = 0;
    const uploader: PivotBlobUploader = async () => {
      uploadCalls += 1;
      return { blobUrl: "x", blobName: "x" };
    };
    const artifact = await materializePivotArtifact(baseRaw(), uploader);
    assert.equal(uploadCalls, 0);
    assert.equal(artifact.storage.kind, "inline");
    if (artifact.storage.kind === "inline") {
      assert.equal(artifact.storage.rows.length, 1);
      assert.equal(artifact.storage.rows[0]?.Products, "MARICO");
    }
    assert.equal(artifact.rowCount, 1);
    assert.equal(artifact.questionContext, "Top 10 SKUs by Q3 value sales");
  });

  it("blob path calls the uploader once with the JSON-serialized rows", async () => {
    const calls: Array<{ blobName: string; bytes: number; preview: string }> = [];
    const uploader: PivotBlobUploader = async (buf, blobName) => {
      calls.push({
        blobName,
        bytes: buf.length,
        preview: buf.toString("utf8").slice(0, 32),
      });
      return { blobUrl: `https://x/${blobName}`, blobName };
    };
    const big = Array.from({ length: 3000 }, (_, i) => ({ i, label: `row_${i}` }));
    const artifact = await materializePivotArtifact(baseRaw({ rows: big }), uploader);
    assert.equal(calls.length, 1);
    assert.equal(artifact.storage.kind, "blob");
    if (artifact.storage.kind === "blob") {
      assert.equal(artifact.storage.blobName, calls[0]?.blobName);
      assert.ok(artifact.storage.blobName.startsWith("past-analyses-pivots/"));
      assert.equal(artifact.storage.bytes, calls[0]?.bytes);
    }
    assert.equal(artifact.rowCount, 3000);
    assert.ok(calls[0]?.preview.startsWith("["));
  });

  it("two materialisations of the same raw produce identical blob names (idempotency)", async () => {
    const calls: string[] = [];
    const uploader: PivotBlobUploader = async (_buf, blobName) => {
      calls.push(blobName);
      return { blobUrl: "x", blobName };
    };
    const big = Array.from({ length: 3000 }, (_, i) => ({ i }));
    const raw = baseRaw({ rows: big });
    const a = await materializePivotArtifact(raw, uploader);
    const b = await materializePivotArtifact(raw, uploader);
    assert.equal(a.artifactId, b.artifactId);
    if (a.storage.kind === "blob" && b.storage.kind === "blob") {
      assert.equal(a.storage.blobName, b.storage.blobName);
    }
    // Same raw → same blob name on both calls. Upload still fires both
    // times in this test because we don't dedupe at the storage layer
    // (Azure Blob upserts on the same path are idempotent in practice).
    assert.equal(calls[0], calls[1]);
  });

  it("clips questionContext at 240 chars", async () => {
    const longCtx = "x".repeat(500);
    const artifact = await materializePivotArtifact(
      baseRaw({ questionContext: longCtx })
    );
    assert.equal(artifact.questionContext?.length, 240);
  });

  it("caps columnHeaders at 64 entries", async () => {
    const headers = Array.from({ length: 100 }, (_, i) => `col_${i}`);
    const artifact = await materializePivotArtifact(
      baseRaw({ columnHeaders: headers })
    );
    assert.equal(artifact.columnHeaders.length, 64);
  });
});
