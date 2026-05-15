/**
 * AMR3 · Pivot-artifact materialisation policy.
 *
 * Given a raw pivot capture from the agent loop ({plan, rows, headers,
 * pivotDefaults, ...}), return a `PastAnalysisPivotArtifact` whose `storage`
 * field is either:
 *   - `{ kind: "inline", rows }` when the dataset fits inside both
 *     `PIVOT_INLINE_MAX_ROWS` AND `PIVOT_INLINE_MAX_BYTES` (the user-
 *     confirmed AMR1 caps: 2000 rows / 200KB serialized), OR
 *   - `{ kind: "blob", blobName, bytes }` when larger; rows are JSON-stream
 *     uploaded to Azure Blob under `past-analyses-pivots/<artifactId>.json`
 *     via the existing `uploadBufferToBlobAtExactPath` helper.
 *
 * `artifactId` is deterministic — `sha256(sessionId|turnId|stepId)` —
 * so a turn replay or regeneration overwrites the same blob and skips
 * re-upload when the row buffer hashes identically to a prior write.
 * Mirrors the idempotency contract of `upsertPastAnalysisDoc` (same `id`
 * for `${sessionId}__${turnId}`).
 *
 * Blob fetch on recall is in AMR3c (the `/api/past-analyses/:artifactId/
 * pivot-rows` endpoint) — this module only writes.
 */

import crypto from "node:crypto";
import {
  PIVOT_INLINE_MAX_BYTES,
  PIVOT_INLINE_MAX_ROWS,
  type PastAnalysisPivotArtifact,
  type PastAnalysisPivotArtifactStorage,
  type PivotDefaults,
} from "../shared/schema.js";
import { uploadBufferToBlobAtExactPath } from "./blobStorage.js";

export interface RawPivotArtifact {
  sessionId: string;
  turnId: string;
  stepId: string;
  /** Loose plan body — re-validated against `queryPlanBodySchema` at replay time. */
  plan: Record<string, unknown>;
  /** Pivot defaults derived for this step (rows, values, columns, filters). */
  pivotDefaults: PivotDefaults;
  /** Headers in the aggregated result, in display order. */
  columnHeaders: string[];
  /** The actual aggregated rows the executor produced. */
  rows: Record<string, unknown>[];
  /** Short narratorisable label for the pivot (optional). */
  questionContext?: string;
}

/**
 * Storage uploader signature — injectable for tests so we can verify the
 * blob upload fires without touching Azure. Default forwards to the real
 * `uploadBufferToBlobAtExactPath`.
 */
export type PivotBlobUploader = (
  buffer: Buffer,
  blobName: string,
  contentType: string
) => Promise<{ blobUrl: string; blobName: string }>;

const defaultUploader: PivotBlobUploader = uploadBufferToBlobAtExactPath;

/**
 * Deterministic artifact id: keeps re-uploads idempotent across turn
 * replays. SHA-256 truncated to 32 hex chars (16 bytes of entropy — plenty
 * for the (sessionId, turnId, stepId) triple's collision space).
 */
export function buildArtifactId(
  sessionId: string,
  turnId: string,
  stepId: string
): string {
  return crypto
    .createHash("sha256")
    .update(`${sessionId}|${turnId}|${stepId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Inline-vs-blob predicate. Inline iff BOTH caps respected. Returns the
 * serialized byte count alongside the verdict so the caller doesn't
 * re-stringify.
 */
export function decideStorageKind(rows: Record<string, unknown>[]): {
  kind: "inline" | "blob";
  serialized: string;
  bytes: number;
} {
  if (rows.length > PIVOT_INLINE_MAX_ROWS) {
    const serialized = JSON.stringify(rows);
    return { kind: "blob", serialized, bytes: Buffer.byteLength(serialized) };
  }
  const serialized = JSON.stringify(rows);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > PIVOT_INLINE_MAX_BYTES) {
    return { kind: "blob", serialized, bytes };
  }
  return { kind: "inline", serialized, bytes };
}

/**
 * Pure-fn shape of the materialised artifact, separated from the
 * side-effect blob upload so unit tests can pin the policy without mocking
 * Azure SDK calls. The async wrapper below performs the upload when
 * `storage.kind === 'blob'`.
 */
export function previewMaterializedArtifact(
  raw: RawPivotArtifact
): {
  artifactId: string;
  storageKind: "inline" | "blob";
  bytes: number;
  blobName: string;
} {
  const artifactId = buildArtifactId(raw.sessionId, raw.turnId, raw.stepId);
  const { kind, bytes } = decideStorageKind(raw.rows);
  const blobName = `past-analyses-pivots/${artifactId}.json`;
  return { artifactId, storageKind: kind, bytes, blobName };
}

/**
 * Materialise a raw capture into a persistable `PastAnalysisPivotArtifact`.
 * Side-effect: uploads to Azure Blob when the row set exceeds inline caps.
 * Errors on upload propagate to the caller (the chatStream-side patch path
 * is fire-and-forget at the call site, so a failed upload simply means the
 * cache-hit will fall back to plain-markdown render — never a user-visible
 * crash).
 */
export async function materializePivotArtifact(
  raw: RawPivotArtifact,
  uploader: PivotBlobUploader = defaultUploader
): Promise<PastAnalysisPivotArtifact> {
  const artifactId = buildArtifactId(raw.sessionId, raw.turnId, raw.stepId);
  const { kind, serialized, bytes } = decideStorageKind(raw.rows);
  let storage: PastAnalysisPivotArtifactStorage;
  if (kind === "inline") {
    storage = { kind: "inline", rows: raw.rows };
  } else {
    const blobName = `past-analyses-pivots/${artifactId}.json`;
    const buffer = Buffer.from(serialized, "utf8");
    const result = await uploader(buffer, blobName, "application/json");
    storage = { kind: "blob", blobName: result.blobName, bytes };
  }
  return {
    artifactId,
    ...(raw.questionContext ? { questionContext: raw.questionContext.slice(0, 240) } : {}),
    plan: raw.plan,
    pivotDefaults: raw.pivotDefaults,
    columnHeaders: raw.columnHeaders.slice(0, 64),
    rowCount: raw.rows.length,
    storage,
  };
}
