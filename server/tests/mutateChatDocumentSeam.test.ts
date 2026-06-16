import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Container } from "@azure/cosmos";

import {
  mutateChatDocument,
  type ChatDocument,
} from "../models/chat.model.js";
import { __setContainerForTesting } from "../models/database.config.js";
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";

/**
 * TEST-2 · HERMETIC executable test for the `mutateChatDocument` write seam.
 *
 * This is the in-memory counterpart to the source-text grep in
 * `chatDocWriteSeam.test.ts`. It drives the REAL seam (`mutateChatDocument`
 * → `getChatBySessionIdEfficient(forceRefresh)` → `updateChatDocument(IfMatch
 * _etag)` → 412 retry) against a FAKE Cosmos `Container` injected via
 * `__setContainerForTesting`. No real Cosmos, no network, no timers — so it
 * cannot hang.
 *
 * The seam contract under test:
 *   1. read FRESH (forceRefresh) so the `_etag` is current,
 *   2. run `mutate(doc)`,
 *   3. upsert with an IfMatch `_etag` precondition,
 *   4. on a 412 (cross-instance writer) re-read fresh + re-apply, bounded by
 *      `maxRetries`,
 *   5. a mutator returning `false` aborts (no upsert), and a missing doc → null.
 */

const SESSION_ID = "seam-test-session";

function buildDoc(etag: string, overrides: Partial<ChatDocument> = {}): ChatDocument {
  return {
    id: "chat_seam_test",
    username: "tester@example.com",
    fileName: "f.xlsx",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    _etag: etag,
    collaborators: ["tester@example.com"],
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
    ...overrides,
  };
}

function preconditionFailed(): Error {
  const err = new Error("Cosmos 412 precondition failed (IfMatch _etag mismatch)") as Error & {
    code?: number;
  };
  err.code = 412;
  return err;
}

/**
 * Minimal in-memory fake of the Cosmos chat `Container`. The seam only ever
 * calls `.items.query(...).fetchAll()` (the fresh read) and `.items.upsert(...)`
 * (the conditional write), so we stub exactly those two surfaces.
 */
interface FakeContainer {
  container: Container;
  reads: { forced: boolean }[];
  upserts: { etag: string | undefined; newEtag: string }[];
}

function makeFakeContainer(opts: {
  /** Latest stored doc; query().fetchAll() returns this. `null` ⇒ missing. */
  stored: ChatDocument | null;
  /** Number of leading upserts that should throw a 412 before succeeding. */
  failUpsertsBeforeSuccess?: number;
  /**
   * When a 412 is thrown, advance the stored doc's `_etag` to this value so the
   * NEXT fresh read sees a moved doc — mimicking a cross-instance writer.
   */
  etagAfterConflict?: string;
}): FakeContainer {
  const state = {
    stored: opts.stored,
    remainingFailures: opts.failUpsertsBeforeSuccess ?? 0,
  };
  const record: FakeContainer = {
    reads: [],
    upserts: [],
    container: undefined as unknown as Container,
  };

  let upsertSeq = 0;

  const items = {
    query(_spec: unknown) {
      // forceRefresh in the seam bypasses chat.model's read cache, so EVERY read
      // reaches this fake. We can't see the forceRefresh flag here, but the seam
      // is the only reader and it always passes forceRefresh=true — asserted via
      // the cache-bypass behaviour (two reads on a 412 retry both reach us).
      record.reads.push({ forced: true });
      const resources = state.stored ? [state.stored] : [];
      return {
        async fetchAll() {
          return { resources };
        },
      };
    },
    async upsert(doc: ChatDocument, requestOptions?: { accessCondition?: { type: string; condition?: string } }) {
      const ifMatch = requestOptions?.accessCondition?.condition;
      if (state.remainingFailures > 0) {
        state.remainingFailures -= 1;
        // Simulate a concurrent cross-instance write: the stored doc has moved
        // to a new etag, so this conditional upsert is rejected AND the next
        // fresh read must observe the moved doc.
        if (opts.etagAfterConflict && state.stored) {
          state.stored = { ...state.stored, _etag: opts.etagAfterConflict };
        }
        throw preconditionFailed();
      }
      const newEtag = `etag-after-write-${++upsertSeq}`;
      const written = { ...doc, _etag: newEtag } as ChatDocument;
      state.stored = written;
      record.upserts.push({ etag: ifMatch, newEtag });
      return { resource: written };
    },
  };

  record.container = { items } as unknown as Container;
  return record;
}

describe("TEST-2 · mutateChatDocument seam (hermetic, fake Cosmos container)", () => {
  afterEach(() => {
    __setContainerForTesting(null);
    __resetSessionWriteChainForTesting();
  });

  it("(1) 412 on first upsert, success on second → mutator runs twice, re-read is fresh, final write carries the new etag", async () => {
    const fake = makeFakeContainer({
      stored: buildDoc("etag-v1"),
      failUpsertsBeforeSuccess: 1,
      etagAfterConflict: "etag-v2",
    });
    __setContainerForTesting(fake.container);

    let mutatorCalls = 0;
    const seenEtags: (string | undefined)[] = [];
    const result = await mutateChatDocument(SESSION_ID, (doc) => {
      mutatorCalls += 1;
      seenEtags.push(doc._etag);
      doc.permanentContext = `mutated-${mutatorCalls}`;
    });

    // Mutator ran twice: once on the initial fresh read, once after the 412
    // re-read against the moved doc.
    assert.equal(mutatorCalls, 2, "mutator must run twice (initial + 412 retry)");

    // Two FRESH reads reached the fake container (cache-bypass on every attempt).
    assert.ok(fake.reads.length >= 2, `expected ≥2 fresh reads, saw ${fake.reads.length}`);

    // The second read observed the MOVED doc (etag-v2), proving forceRefresh
    // re-read from the container rather than reusing the stale v1 snapshot.
    assert.deepEqual(seenEtags, ["etag-v1", "etag-v2"], "retry must re-read the moved (v2) doc");

    // Exactly one upsert SUCCEEDED, and it was conditioned on the fresh v2 etag.
    assert.equal(fake.upserts.length, 1, "exactly one upsert should succeed");
    assert.equal(fake.upserts[0]!.etag, "etag-v2", "successful write must use the fresh (v2) IfMatch etag");

    // The returned doc carries the etag Cosmos assigned on the successful write.
    assert.ok(result, "seam must return the written doc");
    assert.equal(result!._etag, fake.upserts[0]!.newEtag, "returned doc carries the new write etag");
    assert.equal(result!.permanentContext, "mutated-2", "returned doc reflects the (second) mutation");
  });

  it("(2) mutator returning false → no upsert, doc returned unchanged", async () => {
    const original = buildDoc("etag-aborted", { permanentContext: "original" });
    const fake = makeFakeContainer({ stored: original });
    __setContainerForTesting(fake.container);

    let mutatorCalls = 0;
    const result = await mutateChatDocument(SESSION_ID, (doc) => {
      mutatorCalls += 1;
      doc.permanentContext = "should-not-persist";
      return false; // abort
    });

    assert.equal(mutatorCalls, 1, "mutator runs once");
    assert.equal(fake.upserts.length, 0, "aborting mutator must NOT upsert");
    assert.ok(result, "seam returns the (unchanged) doc, not null");
    assert.equal(result!._etag, "etag-aborted", "returned doc is the freshly-read doc");
  });

  it("(3) missing doc → returns null, no upsert, mutator never runs", async () => {
    const fake = makeFakeContainer({ stored: null });
    __setContainerForTesting(fake.container);

    let mutatorCalls = 0;
    const result = await mutateChatDocument(SESSION_ID, () => {
      mutatorCalls += 1;
    });

    assert.equal(result, null, "missing doc must yield null");
    assert.equal(mutatorCalls, 0, "mutator must not run when the doc is missing");
    assert.equal(fake.upserts.length, 0, "no upsert for a missing doc");
  });

  it("412 every attempt → exhausts maxRetries and throws the 412", async () => {
    const fake = makeFakeContainer({
      stored: buildDoc("etag-stuck"),
      failUpsertsBeforeSuccess: 5, // more than maxRetries
      etagAfterConflict: "etag-stuck", // never resolves
    });
    __setContainerForTesting(fake.container);

    await assert.rejects(
      () => mutateChatDocument(SESSION_ID, (doc) => {
        doc.permanentContext = "x";
      }, { maxRetries: 2 }),
      (err: unknown) => (err as { code?: number }).code === 412,
      "exhausting retries must surface the underlying 412",
    );
    assert.equal(fake.upserts.length, 0, "no upsert ever succeeded");
  });
});
