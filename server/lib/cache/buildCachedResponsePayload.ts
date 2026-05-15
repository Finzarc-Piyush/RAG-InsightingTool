/**
 * AMR4 · Pure-fn assembly of the cache-hit SSE `response` payload + the
 * persisted assistant message body.
 *
 * Inputs:
 *   - `richDoc` — full `PastAnalysisDoc` fetched from Cosmos by id (carries
 *     `answerEnvelope`, `businessActions`, `charts`, `pivotArtifacts`,
 *     `investigationSummary`). May be null when the AI-Search-side hit is
 *     stale w.r.t. Cosmos (rare; graceful degrade to text-only render).
 *   - `matchKind` — `"exact"` or `"semantic"` from `CacheHit.source`.
 *   - `fallbackAnswer` — the answer text from the AI Search projection,
 *     used when `richDoc` is unavailable (degrade path).
 *   - `fallbackCreatedAt` — same idea for `originalCreatedAt`.
 *
 * Outputs:
 *   - `pivotArtifactsForClient` — blob-shape preserved as metadata only
 *     (rows omitted for blob storage; client fetches via AMR3c endpoint).
 *     Inline storage rows ship as-is so the pivot mounts instantly.
 *   - `pivotDefaults` — derived from the primary (largest by rowCount,
 *     ties broken by first emitted) pivot artifact so `DataPreviewTable`
 *     mounts the same shape as the original turn.
 *   - `recalledMeta` — the chip / persistence provenance.
 *   - `responsePayload` — exactly what to send on the `response` SSE event.
 *   - `assistantMessageExtras` — sparse object spread onto the persisted
 *     assistant message so a reload shows the same rich card.
 */

import type {
  Message,
  PastAnalysisDoc,
  PastAnalysisPivotArtifact,
} from "../../shared/schema.js";

export interface CachedResponseInputs {
  richDoc: PastAnalysisDoc | null;
  matchKind: "exact" | "semantic";
  originalSessionId: string;
  originalTurnId: string;
  fallbackAnswer: string;
  fallbackCreatedAt: number;
  cachedAgeMs: number;
}

export interface CachedResponseOutputs {
  pivotArtifactsForClient: PastAnalysisPivotArtifact[];
  pivotDefaults: Message["pivotDefaults"] | undefined;
  recalledMeta: NonNullable<Message["recalledFromPriorAnalysis"]>;
  responsePayload: Record<string, unknown>;
  assistantMessageExtras: Partial<Message>;
}

function selectPrimaryPivot(
  artifacts: PastAnalysisPivotArtifact[]
): PastAnalysisPivotArtifact | undefined {
  if (!artifacts.length) return undefined;
  // Largest by rowCount; ties broken by first-emitted (array order).
  let best = artifacts[0];
  for (const a of artifacts) {
    if (a.rowCount > (best?.rowCount ?? -1)) best = a;
  }
  return best;
}

export function buildCachedResponsePayload(
  inputs: CachedResponseInputs
): CachedResponseOutputs {
  const {
    richDoc,
    matchKind,
    originalSessionId,
    originalTurnId,
    fallbackAnswer,
    fallbackCreatedAt,
    cachedAgeMs,
  } = inputs;

  // Strip raw blob payloads from pivotArtifacts before sending — client
  // fetches rows on demand via the AMR3c endpoint. Inline rows pass
  // through (the pivot mounts instantly).
  const pivotArtifactsForClient: PastAnalysisPivotArtifact[] = (
    richDoc?.pivotArtifacts ?? []
  ).map((a) => ({
    artifactId: a.artifactId,
    ...(a.questionContext ? { questionContext: a.questionContext } : {}),
    plan: a.plan,
    pivotDefaults: a.pivotDefaults,
    columnHeaders: a.columnHeaders,
    rowCount: a.rowCount,
    storage:
      a.storage.kind === "inline"
        ? { kind: "inline", rows: a.storage.rows }
        : {
            kind: "blob",
            blobName: a.storage.blobName,
            bytes: a.storage.bytes,
          },
  }));

  const primary = selectPrimaryPivot(pivotArtifactsForClient);
  const pivotDefaults = primary?.pivotDefaults;

  const recalledMeta: NonNullable<Message["recalledFromPriorAnalysis"]> = {
    originalSessionId,
    originalTurnId,
    originalCreatedAt: richDoc?.createdAt ?? fallbackCreatedAt,
    matchKind,
  };

  const answer = richDoc?.answer ?? fallbackAnswer;

  const responsePayload: Record<string, unknown> = {
    answer,
    charts: richDoc?.charts ?? [],
    suggestions: [],
    cached: true,
    cachedAgeMs,
    cachedSourceTurnId: originalTurnId,
    recalledFromPriorAnalysis: recalledMeta,
  };
  if (richDoc?.answerEnvelope) {
    responsePayload.answerEnvelope = richDoc.answerEnvelope;
  }
  if (richDoc?.businessActions?.length) {
    responsePayload.businessActions = richDoc.businessActions;
  }
  if (richDoc?.investigationSummary) {
    responsePayload.investigationSummary = richDoc.investigationSummary;
  }
  if (pivotDefaults) {
    responsePayload.pivotDefaults = pivotDefaults;
  }
  if (pivotArtifactsForClient.length > 0) {
    responsePayload.pivotArtifacts = pivotArtifactsForClient;
  }

  const assistantMessageExtras: Partial<Message> = {
    recalledFromPriorAnalysis: recalledMeta,
  };
  if (richDoc?.charts?.length) {
    assistantMessageExtras.charts = richDoc.charts;
  }
  if (richDoc?.answerEnvelope) {
    assistantMessageExtras.answerEnvelope = richDoc.answerEnvelope;
  }
  if (richDoc?.businessActions?.length) {
    assistantMessageExtras.businessActions = richDoc.businessActions;
  }
  if (richDoc?.investigationSummary) {
    assistantMessageExtras.investigationSummary = richDoc.investigationSummary;
  }
  if (pivotDefaults) {
    assistantMessageExtras.pivotDefaults = pivotDefaults;
  }
  if (pivotArtifactsForClient.length > 0) {
    assistantMessageExtras.pivotArtifacts = pivotArtifactsForClient;
  }

  return {
    pivotArtifactsForClient,
    pivotDefaults,
    recalledMeta,
    responsePayload,
    assistantMessageExtras,
  };
}
