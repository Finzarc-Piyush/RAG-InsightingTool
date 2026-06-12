/**
 * Wave R30 · Cosmos document-size guard — extracted from chat.model.ts as the
 * first step of the god-file decomposition (chat.model was 2088 lines).
 *
 * Cosmos's per-document hard limit is 2 MB. We warn well before and throw before
 * the cliff so a failing turn surfaces an actionable error instead of a silent
 * Cosmos 413. Self-contained: depends only on the ChatDocument shape (type-only
 * import — no runtime cycle back into chat.model) and the logger.
 */
import type { ChatDocument } from "./chat.model.js";
import { logger } from "../lib/logger.js";

const COSMOS_DOC_SIZE_WARN_BYTES = 1_600_000;
const COSMOS_DOC_SIZE_ERROR_BYTES = 1_900_000;

export class CosmosDocSizeError extends Error {
  readonly bytes: number;
  readonly sessionId: string;
  constructor(bytes: number, sessionId: string) {
    super(
      `Chat document for session ${sessionId} is ${bytes} bytes — too large to persist (Cosmos 2 MB limit). Start a new session or remove older messages.`,
    );
    this.name = "CosmosDocSizeError";
    this.bytes = bytes;
    this.sessionId = sessionId;
  }
}

export function assertDocSizeUnderLimit(chatDocument: ChatDocument): void {
  const bytes = Buffer.byteLength(JSON.stringify(chatDocument), "utf8");
  if (bytes >= COSMOS_DOC_SIZE_ERROR_BYTES) {
    throw new CosmosDocSizeError(bytes, chatDocument.sessionId);
  }
  if (bytes >= COSMOS_DOC_SIZE_WARN_BYTES) {
    logger.warn(
      `⚠️ chat doc size ${bytes} bytes (session ${chatDocument.sessionId}, messages=${chatDocument.messages?.length ?? 0}) — approaching Cosmos 2 MB limit`,
    );
  }
}
