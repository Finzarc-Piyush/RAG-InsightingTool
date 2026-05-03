import { getChatBySessionIdEfficient, updateChatDocument, type ChatDocument } from "../../models/chat.model.js";
import { isRagEnabled, getEmbeddingDimensions } from "./config.js";
import { buildChunksForSession, userContextChunk, USER_CONTEXT_CHUNK_ID } from "./chunking.js";
import { embedTexts } from "./embeddings.js";
import {
  upsertRagDocuments,
  deleteRagDocumentsBySessionId,
  type RagSearchDocument,
} from "./aiSearchStore.js";
import { getSampleFromDuckDB } from "../duckdbPlanExecutor.js";
import type { AnalysisMemoryEntry } from "../../shared/schema.js";

/**
 * W57 · Single chunkType used for every Memory Entry indexed into the
 * per-session AI Search index. Distinct from data-chunk types
 * ("data_sample", "column_metadata", "user_context", "suggested_question") so
 * data-RAG callers can exclude memory entries with `excludeChunkTypes` and
 * memory-recall callers (W60) can include only this type.
 */
export const MEMORY_ENTRY_CHUNK_TYPE = "memory_entry";

function memoryEntryChunkId(entry: AnalysisMemoryEntry): string {
  const turn = entry.turnId ?? "lifecycle";
  return `mem__${turn}__${entry.type}__${entry.sequence}`;
}

function memoryEntryEmbeddingText(entry: AnalysisMemoryEntry): string {
  return `[${entry.type}] ${entry.title}\n${entry.summary}`.slice(0, 32000);
}

function dataVersion(doc: ChatDocument): number {
  return doc.currentDataBlob?.version ?? 1;
}

/**
 * Index or reindex all RAG chunks for a session. Non-fatal on failure (logs + Cosmos error status).
 */
export async function indexSessionRag(sessionId: string): Promise<void> {
  if (!isRagEnabled()) {
    return;
  }

  let doc: ChatDocument | null = null;
  try {
    doc = await getChatBySessionIdEfficient(sessionId);
    if (!doc?.dataSummary) {
      return;
    }

    doc.ragIndex = {
      ...(doc.ragIndex || {}),
      status: "indexing",
      lastError: undefined,
    };
    await updateChatDocument(doc);

    const ver = dataVersion(doc);
    await deleteRagDocumentsBySessionId(sessionId);

    const columnar = Boolean(doc.columnarStoragePath);
    let dataRows: Record<string, any>[] | undefined;
    let duckdbSample: Record<string, any>[] | undefined;

    if (!columnar && doc.rawData?.length) {
      dataRows = doc.rawData;
    } else if (columnar) {
      try {
        duckdbSample = await getSampleFromDuckDB(sessionId, 3000, doc);
      } catch (e) {
        console.warn("⚠️ RAG: DuckDB sample failed for columnar session:", e);
      }
    }

    const chunks = buildChunksForSession({
      doc,
      dataRows,
      duckdbSampleRows: duckdbSample,
    });

    const texts = chunks.map((c) => c.content);
    const vectors = await embedTexts(texts);
    const dim = getEmbeddingDimensions();

    const docs: RagSearchDocument[] = chunks.map((c, i) => {
      let v = vectors[i];
      if (!v || v.length !== dim) {
        v = v?.length ? v : new Array(dim).fill(0);
      }
      return {
        id: `${sessionId}__${c.chunkId}`.replace(/[^\w-]/g, "_"),
        sessionId,
        chunkId: c.chunkId,
        chunkType: c.chunkType,
        dataVersion: ver,
        rowStart: c.rowStart,
        rowEnd: c.rowEnd,
        content: c.content.slice(0, 32000),
        contentVector: v,
      };
    });

    await upsertRagDocuments(docs);

    doc.ragIndex = {
      status: "ready",
      indexedAt: Date.now(),
      chunkCount: docs.length,
      dataVersion: ver,
    };
    await updateChatDocument(doc);
    console.log(`✅ RAG indexed session ${sessionId}: ${docs.length} chunks`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("❌ RAG indexSession failed:", e);
    if (doc) {
      doc.ragIndex = {
        ...(doc.ragIndex || {}),
        status: "error",
        lastError: msg.slice(0, 500),
      };
      try {
        await updateChatDocument(doc);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Fire-and-forget indexing (upload pipeline).
 */
export function scheduleIndexSessionRag(sessionId: string): void {
  setImmediate(() => {
    indexSessionRag(sessionId).catch((e) => console.error("scheduleIndexSessionRag:", e));
  });
}

/**
 * Upsert a single `user_context` chunk for a session without re-indexing everything.
 * Falls back to a full index if initial indexing hasn't produced a ready state yet
 * (because a concurrent full reindex would delete our targeted doc).
 */
export async function upsertUserContextChunk(
  sessionId: string,
  permanentContext: string
): Promise<void> {
  if (!isRagEnabled()) return;
  const text = permanentContext?.trim();
  if (!text) return;

  const doc = await getChatBySessionIdEfficient(sessionId);
  if (!doc?.dataSummary) {
    // Session not yet enriched — upload pipeline will index naturally later.
    return;
  }

  const status = doc.ragIndex?.status;
  if (status !== "ready") {
    // If the initial full index is still pending or running, let it pick up
    // permanentContext (via buildChunksForSession) instead of racing it.
    scheduleIndexSessionRag(sessionId);
    return;
  }

  const ver = doc.currentDataBlob?.version ?? 1;
  const chunk = userContextChunk(text);

  try {
    const vectors = await embedTexts([chunk.content]);
    const dim = getEmbeddingDimensions();
    let v = vectors[0];
    if (!v || v.length !== dim) {
      v = v?.length ? v : new Array(dim).fill(0);
    }
    const ragDoc: RagSearchDocument = {
      id: `${sessionId}__${USER_CONTEXT_CHUNK_ID}`.replace(/[^\w-]/g, "_"),
      sessionId,
      chunkId: chunk.chunkId,
      chunkType: chunk.chunkType,
      dataVersion: ver,
      content: chunk.content.slice(0, 32000),
      contentVector: v,
    };
    await upsertRagDocuments([ragDoc]);
    console.log(`✅ RAG user_context upserted for session ${sessionId}`);
  } catch (e) {
    console.error("❌ upsertUserContextChunk failed:", e);
  }
}

/**
 * Fire-and-forget variant of `upsertUserContextChunk`.
 */
export function scheduleUpsertUserContextChunk(
  sessionId: string,
  permanentContext: string
): void {
  setImmediate(() => {
    upsertUserContextChunk(sessionId, permanentContext).catch((e) =>
      console.error("scheduleUpsertUserContextChunk:", e)
    );
  });
}

/**
 * W57 · Embed and upsert a batch of Analysis Memory entries into the per-
 * session AI Search index. Reuses the existing index (no schema change): each
 * entry is one search document with `chunkType: "memory_entry"`. The original
 * entry's structured data lives in Cosmos (W56); this is just the semantic
 * retrieval mirror.
 *
 * Idempotent on `id` — replays overwrite cleanly. RAG-disabled environments
 * no-op so the producer hooks (W58/W59) never fail because of missing creds.
 */
export async function indexMemoryEntries(
  entries: AnalysisMemoryEntry[]
): Promise<void> {
  if (!isRagEnabled() || entries.length === 0) return;
  const dim = getEmbeddingDimensions();
  const texts = entries.map(memoryEntryEmbeddingText);
  const vectors = await embedTexts(texts);

  const docs: RagSearchDocument[] = entries.map((e, i) => {
    let v = vectors[i];
    if (!v || v.length !== dim) {
      v = v?.length ? v : new Array(dim).fill(0);
    }
    const chunkId = memoryEntryChunkId(e);
    return {
      id: `${e.sessionId}__${chunkId}`.replace(/[^\w-]/g, "_"),
      sessionId: e.sessionId,
      chunkId,
      chunkType: MEMORY_ENTRY_CHUNK_TYPE,
      dataVersion: e.dataVersion ?? 0,
      content: memoryEntryEmbeddingText(e),
      contentVector: v,
    };
  });

  await upsertRagDocuments(docs);
}

/**
 * Fire-and-forget variant — never blocks the caller. Producer hooks (W58/W59)
 * use this so a Search outage cannot fail a chat turn.
 */
export function scheduleIndexMemoryEntries(
  entries: AnalysisMemoryEntry[]
): void {
  if (entries.length === 0) return;
  setImmediate(() => {
    indexMemoryEntries(entries).catch((e) =>
      console.error("scheduleIndexMemoryEntries:", e)
    );
  });
}
