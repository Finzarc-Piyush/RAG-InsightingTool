import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  mutateChatDocument,
  getChatBySessionIdEfficient,
  type ChatDocument,
} from "../models/chat.model.js";
import { __setContainerForTesting } from "../models/database.config.js";
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";
import { logger } from "../lib/logger.js";
import { makeInMemoryContainer, type StoredDoc } from "./helpers/inMemoryCosmosContainer.js";

/**
 * UNLOCK PROOF · drives the REAL chat-doc write seam
 * (`mutateChatDocument` → `getChatBySessionIdEfficient(forceRefresh)` →
 * `updateChatDocument(IfMatch _etag)` → 412 retry) through the shared
 * in-memory Cosmos double injected via `__setContainerForTesting`.
 *
 * This is the test that today HANGS against a real Cosmos account
 * (`waitForContainer()` retries for 30s before throwing). With the double it
 * runs in milliseconds and exercises the cross-instance 412-retry end-to-end:
 * a "concurrent writer on another instance" moves the stored `_etag` out from
 * under an in-flight mutator, so its conditional upsert is rejected with 412,
 * the seam re-reads the moved doc and re-applies the mutator, then succeeds.
 *
 * The chat container's partition key path is `/fsmrora` (the username mirror
 * `updateChatDocument` stamps), so the double is built with that path and every
 * read/write keys consistently.
 */

const SESSION_ID = "cosmos-double-unlock-session";
const OWNER = "owner@example.com";

function buildChatDoc(): StoredDoc {
  const doc: ChatDocument = {
    id: "chat_unlock",
    username: OWNER,
    fileName: "f.xlsx",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    collaborators: [OWNER],
    dataSummary: {
      rowCount: 0,
      columnCount: 0,
      columns: [],
      numericColumns: [],
      dateColumns: [],
    } as ChatDocument["dataSummary"],
    messages: [],
    charts: [],
    insights: [],
    sessionId: SESSION_ID,
    rawData: [],
    sampleRows: [],
    columnStatistics: {},
    analysisMetadata: {
      totalProcessingTime: 0,
      aiModelUsed: "test",
      fileSize: 0,
      analysisVersion: "1.0.0",
    },
  };
  // The chat container partitions on `/fsmrora` (a username mirror), so the
  // double must store it under that key — `updateChatDocument` stamps it on
  // write, but the seed doc needs it too so the initial read keys correctly.
  return { ...(doc as unknown as StoredDoc), fsmrora: OWNER };
}

describe("cosmos double · unlock proof (real seam, no hang)", () => {
  // The 412-retry path deliberately makes `updateChatDocument` log the rejected
  // write at `logger.error` (full Error + stack to stderr). Under `node --test`
  // a large stderr burst from the child can race the runner's TAP-over-socket
  // protocol and corrupt it ("Unable to deserialize cloned data"). Silence the
  // logger for these tests — the behaviour under assertion is unchanged; we only
  // suppress the diagnostic noise that the EXPECTED 412 produces.
  const originalLogger = { error: logger.error, warn: logger.warn, log: logger.log };
  const silence = () => {
    logger.error = () => {};
    logger.warn = () => {};
    logger.log = () => {};
  };
  const restoreLogger = () => {
    logger.error = originalLogger.error;
    logger.warn = originalLogger.warn;
    logger.log = originalLogger.log;
  };

  beforeEach(() => {
    silence();
  });

  afterEach(() => {
    __setContainerForTesting(null);
    __resetSessionWriteChainForTesting();
    restoreLogger();
  });

  it("412-retry path: a concurrent cross-instance writer forces one 412, the seam re-reads + succeeds", async () => {
    const startedAt = Date.now();
    const handle = makeInMemoryContainer([buildChatDoc()], { partitionKeyPath: "/fsmrora" });
    __setContainerForTesting(handle.container);

    // Establish the current etag the seam will first read.
    const initial = await getChatBySessionIdEfficient(SESSION_ID, /* forceRefresh */ true);
    assert.ok(initial, "seed doc readable through the double via the real read path");
    const initialEtag = initial!._etag;
    assert.ok(initialEtag, "stored doc carries an _etag from the double");

    let mutatorCalls = 0;
    let injectedConflict = false;
    const seenEtags: (string | undefined)[] = [];

    const result = await mutateChatDocument(SESSION_ID, async (doc) => {
      mutatorCalls += 1;
      seenEtags.push(doc._etag);
      doc.permanentContext = `mutated-${mutatorCalls}`;

      // On the FIRST attempt, simulate a writer on ANOTHER serverless instance:
      // directly upsert a new revision so the stored _etag moves. The in-process
      // write lock can't reach that instance, so the seam's conditional upsert
      // (IfMatch=stale etag) must hit 412 and retry against the moved doc.
      if (!injectedConflict) {
        injectedConflict = true;
        const moved: StoredDoc = {
          ...(doc as unknown as StoredDoc),
          fsmrora: OWNER,
          permanentContext: "from-other-instance",
        };
        await handle.container.items.upsert(moved); // no IfMatch → unconditional cross-instance write
      }
    });

    // The mutator ran TWICE: initial attempt (conflicted) + retry after the 412.
    assert.equal(mutatorCalls, 2, "mutator runs twice: initial + 412 retry");

    // The retry observed the MOVED doc — its _etag differs from the first read,
    // proving forceRefresh re-read fresh state rather than reusing the snapshot.
    assert.equal(seenEtags[0], initialEtag, "first attempt sees the original etag");
    assert.notEqual(seenEtags[1], initialEtag, "retry re-reads the moved (cross-instance) doc");

    // The seam ultimately succeeded and returned the mutated doc.
    assert.ok(result, "seam returns the written doc after retrying through the 412");
    assert.equal(result!.permanentContext, "mutated-2", "final write reflects the retry mutation");

    // The store holds exactly one chat doc (the conflicting writer + the seam's
    // final write are both upserts of the same id) and it is the seam's result.
    const stored = handle.dump().filter((d) => d.id === "chat_unlock");
    assert.equal(stored.length, 1, "single chat doc in the store");
    assert.equal(stored[0]!.permanentContext, "mutated-2", "the seam's retry write won");

    // And critically: it completed FAST — no Cosmos connection attempt / hang.
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5000, `seam completed in ${elapsed}ms (<5s, no real-Cosmos hang)`);
  });

  it("happy path: a single mutator persists with no conflict, readable back through the double", async () => {
    const handle = makeInMemoryContainer([buildChatDoc()], { partitionKeyPath: "/fsmrora" });
    __setContainerForTesting(handle.container);

    const result = await mutateChatDocument(SESSION_ID, (doc) => {
      doc.permanentContext = "single-writer";
    });
    assert.ok(result, "mutate returns the written doc");
    assert.equal(result!.permanentContext, "single-writer");

    const readBack = await getChatBySessionIdEfficient(SESSION_ID, /* forceRefresh */ true);
    assert.equal(readBack!.permanentContext, "single-writer", "write is durable + readable via the real read path");
  });
});
