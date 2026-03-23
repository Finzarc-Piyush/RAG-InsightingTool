import { getChatBySessionIdEfficient, updateChatDocument, type ChatDocument } from "../../models/chat.model.js";
import { isRagEnabled, getEmbeddingDimensions } from "./config.js";
import { buildChunksForSession } from "./chunking.js";
import { embedTexts } from "./embeddings.js";
import {
  upsertRagDocuments,
  deleteRagDocumentsBySessionId,
  type RagSearchDocument,
} from "./aiSearchStore.js";
import { getSampleFromDuckDB } from "../duckdbPlanExecutor.js";

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
        duckdbSample = await getSampleFromDuckDB(sessionId, 3000);
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
