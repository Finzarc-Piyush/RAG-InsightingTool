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
 * Per-session in-process mutex (W40 pattern) prevents concurrent PUT/DELETEs
 * from clobbering each other. Single-instance correctness only — multi-instance
 * scaling would need Cosmos `ifMatch` / external lock.
 */
import { Request, Response } from "express";
import { z } from "zod";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import {
  getChatBySessionIdForUser,
  updateChatDocument,
} from "../models/chat.model.js";
import {
  activeFilterSpecSchema,
  type ActiveFilterSpec,
} from "../shared/schema.js";
import {
  applyActiveFilter,
  effectiveConditionCount,
} from "../lib/activeFilter/applyActiveFilter.js";
import { invalidateFilteredDataView } from "../lib/activeFilter/resolveSessionDataTable.js";
import { loadLatestData } from "../utils/dataLoader.js";

/** Per-session mutex — see W40 / `messagePivotStateLocks` for the pattern. */
const activeFilterLocks = new Map<string, Promise<unknown>>();

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
  /** First N filtered rows for the data preview. */
  preview: Record<string, unknown>[];
  effectiveConditionCount: number;
}

const PREVIEW_ROWS = 50;

async function buildResponse(
  sessionId: string,
  username: string
): Promise<ActiveFilterResponse> {
  const doc = await getChatBySessionIdForUser(sessionId, username);
  if (!doc) {
    const err = new Error("Session not found") as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }
  const spec = doc.activeFilter ?? null;
  // Canonical row count from the session metadata (cheap; doesn't trigger a
  // blob fetch). dataSummary.rowCount is authoritative post-upload.
  const totalRows = doc.dataSummary?.rowCount ?? 0;
  // Filtered row count + preview rows. Use loadLatestData (filter-aware) for
  // the preview and a separate canonical load for the count to avoid a second
  // blob fetch — actually one round trip suffices because loadLatestData
  // returns filtered rows already.
  const filteredAll = await loadLatestData(doc);
  return {
    ok: true,
    activeFilter: spec,
    totalRows,
    filteredRows: filteredAll.length,
    preview: filteredAll.slice(0, PREVIEW_ROWS),
    effectiveConditionCount: effectiveConditionCount(spec),
  };
}

export const getActiveFilterEndpoint = async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    if (!sessionId) return res.status(400).json({ error: "Session ID is required" });
    const username = requireUsername(req);
    const out = await buildResponse(sessionId, username);
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

    const previous = activeFilterLocks.get(sessionId);
    const work = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          /* ignore prior failure */
        }
      }
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
    })();

    activeFilterLocks.set(sessionId, work);
    try {
      await work;
    } finally {
      if (activeFilterLocks.get(sessionId) === work) {
        activeFilterLocks.delete(sessionId);
      }
    }

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

    const previous = activeFilterLocks.get(sessionId);
    const work = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          /* ignore */
        }
      }
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
    })();

    activeFilterLocks.set(sessionId, work);
    try {
      await work;
    } finally {
      if (activeFilterLocks.get(sessionId) === work) {
        activeFilterLocks.delete(sessionId);
      }
    }

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
 * deterministic mutex state.
 */
export function __resetActiveFilterLocksForTests(): void {
  activeFilterLocks.clear();
}

// applyActiveFilter is exported for completeness (route tests use it).
export { applyActiveFilter };
