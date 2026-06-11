/**
 * Wave-FA3 · Active filter controller.
 *
 * `PUT  /api/sessions/:sessionId/active-filter` — set/replace the per-session filter spec.
 * `DELETE /api/sessions/:sessionId/active-filter` — clear the filter (back to canonical).
 *
 * Both endpoints are non-destructive: the canonical `currentDataBlob`,
 * `rawData`, `dataSummary`, and `blobInfo` are never altered. The filter is
 * applied at read time via `loadLatestData` and `resolveSessionDataTable`.
 *
 * Wave A2 · Per-session in-process mutex moved into the unified
 * `withSessionWriteLock` helper. Pre-A2 this controller held its own
 * `activeFilterLocks` map that only serialised filter-vs-filter PUT/DELETEs;
 * concurrent writes from `sessionAnalysisContext.ts` (assistant merge,
 * hierarchy updates) or `patchAssistantBusinessActions.ts` would race
 * against this controller's RMW of the chat doc. Single-instance correctness
 * only — multi-instance scaling would need Cosmos `ifMatch` / external lock.
 */
import { Request, Response } from "express";
import { z } from "zod";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import {
  getChatBySessionIdForUser,
  updateChatDocument,
  type ChatDocument,
} from "../models/chat.model.js";
import { SessionDataNotMaterializedError } from "../lib/columnarStorage.js";
import {
  activeFilterSpecSchema,
  type ActiveFilterSpec,
} from "../shared/schema.js";
import {
  applyActiveFilter,
  effectiveConditionCount,
} from "../lib/activeFilter/applyActiveFilter.js";
import { invalidateFilteredDataView } from "../lib/activeFilter/resolveSessionDataTable.js";
import { selectPreviewRows } from "../lib/activeFilter/selectPreviewRows.js";
import { loadLatestData } from "../utils/dataLoader.js";
import {
  withSessionWriteLock,
  __resetSessionWriteChainForTesting,
} from "../lib/sessionWriteLock.js";

/**
 * Body for PUT — accepts a partial spec where the server fills in `version` /
 * `updatedAt` from the prior state. Clients only send the conditions array.
 */
const putBodySchema = z.object({
  conditions: activeFilterSpecSchema.shape.conditions,
});

interface ActiveFilterResponse {
  ok: true;
  activeFilter: ActiveFilterSpec | null;
  /** Total rows in the canonical dataset (unchanged by filter). */
  totalRows: number;
  /** Rows surviving the filter (== totalRows when no filter is active). */
  filteredRows: number;
  /**
   * Filter-aware preview rows. Default depth is the first `PREVIEW_ROWS`;
   * `GET …?full=1` returns up to `FULL_PREVIEW_CAP` for the "entire dataset"
   * view. See `selectPreviewRows`.
   */
  preview: Record<string, unknown>[];
  /** True when more rows survive the filter than `preview` contains. */
  previewTruncated: boolean;
  effectiveConditionCount: number;
}

async function buildResponse(
  sessionId: string,
  username: string,
  full = false
): Promise<ActiveFilterResponse> {
  const doc = await getChatBySessionIdForUser(sessionId, username);
  if (!doc) {
    const err = new Error("Session not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  return buildResponseFromDoc(doc, full);
}

/**
 * Empty-shape response for a session whose data is not yet materialized.
 * `effectiveConditionCount` still reflects any persisted filter spec so the UI
 * can render the filter chip even before the dataset lands.
 */
function emptyResponse(spec: ActiveFilterSpec | null): ActiveFilterResponse {
  return {
    ok: true,
    activeFilter: spec,
    totalRows: 0,
    filteredRows: 0,
    preview: [],
    previewTruncated: false,
    effectiveConditionCount: effectiveConditionCount(spec),
  };
}

/**
 * Build the active-filter response from an already-fetched chat document.
 * Exported so the placeholder/not-materialized degradation is unit-testable
 * without a Cosmos round trip.
 *
 * Graceful-empty: while a session is still a placeholder (upload in flight),
 * `dataSummary.rowCount` is 0 and every data source is empty, so
 * `loadLatestData` would throw "No data found". The client polls this endpoint
 * on mount (before the upload finishes), so we must return a clean empty-shape
 * 200 instead of a 500 — mirroring the `data-summary` endpoint's empty handling
 * in sessionController.ts. The defensive try/catch additionally covers the
 * narrow window where metadata reports rows but the durable data is mid-write.
 */
export async function buildResponseFromDoc(
  doc: ChatDocument,
  full = false
): Promise<ActiveFilterResponse> {
  const spec = doc.activeFilter ?? null;
  // Canonical row count from the session metadata (cheap; doesn't trigger a
  // blob fetch). dataSummary.rowCount is authoritative post-upload.
  const totalRows = doc.dataSummary?.rowCount ?? 0;
  // Not-yet-materialized (placeholder) session — no data to load or filter.
  if (totalRows === 0) {
    return emptyResponse(spec);
  }
  // Filtered row count + preview rows. Use loadLatestData (filter-aware) for
  // the preview and a separate canonical load for the count to avoid a second
  // blob fetch — actually one round trip suffices because loadLatestData
  // returns filtered rows already.
  let filteredAll: Record<string, unknown>[];
  try {
    filteredAll = await loadLatestData(doc);
  } catch (err: unknown) {
    // Data not materialized yet (metadata present, durable rows mid-write).
    // Degrade to empty-shape rather than 500; re-throw anything unexpected.
    const notMaterialized =
      err instanceof SessionDataNotMaterializedError ||
      (err instanceof Error && err.message.startsWith("No data found"));
    if (notMaterialized) {
      return emptyResponse(spec);
    }
    throw err;
  }
  const { preview, previewTruncated } = selectPreviewRows(filteredAll, full);
  return {
    ok: true,
    activeFilter: spec,
    totalRows,
    filteredRows: filteredAll.length,
    preview,
    previewTruncated,
    effectiveConditionCount: effectiveConditionCount(spec),
  };
}

export const getActiveFilterEndpoint = async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    const username = requireUsername(req);
    // `?full=1` returns the "entire dataset" preview (up to FULL_PREVIEW_CAP)
    // instead of the default first-N rows. Used by the on-demand full-mode fetch.
    const full = req.query.full === "1" || req.query.full === "true";
    const out = await buildResponse(sessionId, username, full);
    return res.json(out);
  } catch (err: unknown) {
    return handleError(res, err, "Failed to load active filter");
  }
};

export const putActiveFilterEndpoint = async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    const username = requireUsername(req);

    const parsed = putBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid active filter payload",
        details: parsed.error.flatten(),
      });
    }
    const conditions = parsed.data.conditions;

    await withSessionWriteLock(sessionId, async () => {
      const doc = await getChatBySessionIdForUser(sessionId, username);
      if (!doc) {
        const err = new Error("Session not found") as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      const priorVersion = doc.activeFilter?.version ?? 0;
      // Even when conditions are empty, write a record (version still bumps so
      // caches invalidate). DELETE removes the field entirely.
      const next: ActiveFilterSpec = {
        conditions,
        version: priorVersion + 1,
        updatedAt: Date.now(),
      };
      doc.activeFilter = next;
      doc.lastUpdatedAt = Date.now();
      await updateChatDocument(doc);
      invalidateFilteredDataView(sessionId);
    });

    const out = await buildResponse(sessionId, username);
    return res.json(out);
  } catch (err: unknown) {
    return handleError(res, err, "Failed to set active filter");
  }
};

export const deleteActiveFilterEndpoint = async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    const username = requireUsername(req);

    await withSessionWriteLock(sessionId, async () => {
      const doc = await getChatBySessionIdForUser(sessionId, username);
      if (!doc) {
        const err = new Error("Session not found") as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      if (doc.activeFilter) {
        delete doc.activeFilter;
        doc.lastUpdatedAt = Date.now();
        await updateChatDocument(doc);
      }
      invalidateFilteredDataView(sessionId);
    });

    const out = await buildResponse(sessionId, username);
    return res.json(out);
  } catch (err: unknown) {
    return handleError(res, err, "Failed to clear active filter");
  }
};

function handleError(res: Response, err: unknown, fallback: string): Response {
  const e = err as { statusCode?: number; message?: string };
  if (err instanceof AuthenticationError) {
    return res.status(401).json({ error: err.message });
  }
  if (e?.statusCode === 404) return res.status(404).json({ error: e.message });
  if (e?.statusCode === 403) return res.status(403).json({ error: e.message });
  console.error(fallback, err);
  return res.status(500).json({
    error: err instanceof Error ? err.message : fallback,
  });
}

/**
 * Test seam — clears the per-session locks. Used by tests that rely on
 * deterministic mutex state. Wave A2 redirected the lock to the unified
 * `withSessionWriteLock` map; the reset hook now drains that shared map.
 */
export function __resetActiveFilterLocksForTests(): void {
  __resetSessionWriteChainForTesting();
}

// applyActiveFilter is exported for completeness (route tests use it).
export { applyActiveFilter };
