import type { ChatDocument } from "../models/chat.model.js";
import { loadLatestData } from "../utils/dataLoader.js";
import {
  ColumnarStorageService,
  SessionDataNotMaterializedError,
} from "./columnarStorage.js";
import { metadataService } from "./metadataService.js";

const materializeLocks = new Map<string, Promise<void>>();

/**
 * Serialize rematerialization per session in-process (avoids duplicate heavy work on concurrent requests).
 */
function withSessionMaterializeLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = materializeLocks.get(sessionId) ?? Promise.resolve();
  const next = prev
    .catch(() => {
      /* keep queue moving if prior rematerialize failed */
    })
    .then(fn);
  materializeLocks.set(
    sessionId,
    next.finally(() => {
      if (materializeLocks.get(sessionId) === next) {
        materializeLocks.delete(sessionId);
      }
    })
  );
  return next;
}

/**
 * Ensures DuckDB `data` exists for this session by loading durable sources when the table is missing.
 * Caller must have called `storage.initialize()`; uses the same DB file as subsequent queries.
 */
export async function ensureAuthoritativeDataTable(
  storage: ColumnarStorageService,
  chat: ChatDocument
): Promise<void> {
  if (await storage.tableExists("data")) {
    return;
  }

  const sessionId = chat.sessionId;

  await withSessionMaterializeLock(sessionId, async () => {
    if (await storage.tableExists("data")) {
      return;
    }

    const rows = await loadLatestData(chat, undefined, undefined, {
      mode: "authoritativeRematerialize",
    });

    if (!rows.length) {
      throw new SessionDataNotMaterializedError(
        sessionId,
        "data",
        `Session ${sessionId}: rematerialization produced no rows. Re-upload the file.`
      );
    }

    await storage.materializeAuthoritativeDataTable(rows, { tableName: "data" });
    metadataService.invalidateCache(sessionId);
  });
}
