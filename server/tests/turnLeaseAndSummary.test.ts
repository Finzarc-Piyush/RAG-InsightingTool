import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Container } from "@azure/cosmos";

import {
  acquireTurnLease,
  releaseTurnLease,
  getChatSummaryBySessionId,
  TURN_LEASE_TTL_MS,
  type ChatDocument,
} from "../models/chat.model.js";
import { __setContainerForTesting } from "../models/database.config.js";
import { __resetSessionWriteChainForTesting } from "../lib/sessionWriteLock.js";

/**
 * DATA-5 + PERF-5 · hermetic tests for the durable turn lease helpers
 * (`acquireTurnLease` / `releaseTurnLease`) and the lean summary read
 * (`getChatSummaryBySessionId`), driven against a FAKE Cosmos `Container`
 * injected via `__setContainerForTesting`. No real Cosmos, no network, no
 * timers — so it cannot hang.
 *
 * The lease helpers route through the REAL `mutateChatDocument` seam (per-
 * session lock + IfMatch `_etag`), so these tests also exercise that the lease
 * write serialises through the seam exactly like every other contended RMW.
 */

const SESSION_ID = "turn-lease-session";

function buildDoc(etag: string, overrides: Partial<ChatDocument> = {}): ChatDocument {
  return {
    id: "chat_lease_test",
    username: "tester@example.com",
    fileName: "f.xlsx",
    uploadedAt: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    _etag: etag,
    collaborators: ["tester@example.com"],
    dataSummary: {
      rowCount: 7,
      columnCount: 3,
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

/**
 * Minimal mutable in-memory fake of the chat `Container`. `query().fetchAll()`
 * returns the stored doc (or a projected subset when the query is the lean
 * SELECT), and `upsert` advances the stored `_etag` and records the write.
 */
function makeFakeContainer(initial: ChatDocument | null) {
  const state: { stored: ChatDocument | null } = { stored: initial };
  let upsertSeq = 0;
  const record = {
    summaryQueries: 0,
    fullQueries: 0,
    upserts: 0,
  };

  const items = {
    query(spec: { query: string }) {
      const isSummary = spec.query.includes("AS rowCount");
      if (isSummary) record.summaryQueries += 1;
      else record.fullQueries += 1;
      return {
        async fetchAll() {
          if (!state.stored) return { resources: [] };
          if (isSummary) {
            // Project only the light summary fields (mirrors SESSION_SUMMARY_SELECT).
            const d = state.stored;
            return {
              resources: [
                {
                  id: d.id,
                  username: d.username,
                  fileName: d.fileName,
                  sessionId: d.sessionId,
                  uploadedAt: d.uploadedAt,
                  createdAt: d.createdAt,
                  lastUpdatedAt: d.lastUpdatedAt,
                  collaborators: d.collaborators,
                  enrichmentStatus: d.enrichmentStatus,
                  permanentContext: d.permanentContext,
                  rowCount: d.dataSummary.rowCount,
                  columnCount: d.dataSummary.columnCount,
                },
              ],
            };
          }
          return { resources: [state.stored] };
        },
      };
    },
    async upsert(doc: ChatDocument) {
      record.upserts += 1;
      const written = { ...doc, _etag: `etag-w${++upsertSeq}` } as ChatDocument;
      state.stored = written;
      return { resource: written };
    },
  };

  return {
    container: { items } as unknown as Container,
    state,
    record,
  };
}

describe("DATA-5 · acquireTurnLease / releaseTurnLease", () => {
  afterEach(() => {
    __setContainerForTesting(null);
    __resetSessionWriteChainForTesting();
  });

  it("acquires on an absent lease, records turnInProgress, and is idempotent for the same turnId", async () => {
    const fake = makeFakeContainer(buildDoc("etag-1"));
    __setContainerForTesting(fake.container);

    const first = await acquireTurnLease(SESSION_ID, "turn-A");
    assert.equal(first, true, "absent lease → acquired");
    assert.equal(fake.state.stored?.turnInProgress?.turnId, "turn-A");

    // Re-acquiring with the SAME turnId is allowed (owned-by-self).
    const again = await acquireTurnLease(SESSION_ID, "turn-A");
    assert.equal(again, true, "owned-by-self → re-acquire allowed");
  });

  it("rejects a second LIVE turn (different turnId, not stale)", async () => {
    const now = 1_000_000;
    const fake = makeFakeContainer(
      buildDoc("etag-1", { turnInProgress: { turnId: "turn-A", startedAt: now } }),
    );
    __setContainerForTesting(fake.container);

    const second = await acquireTurnLease(SESSION_ID, "turn-B", now + 1_000);
    assert.equal(second, false, "live lease held by another turn → not acquired");
    assert.equal(fake.state.stored?.turnInProgress?.turnId, "turn-A", "owner unchanged");
    assert.equal(fake.record.upserts, 0, "rejected acquire must not write");
  });

  it("takes over a STALE lease (older than TURN_LEASE_TTL_MS)", async () => {
    const now = 1_000_000;
    const fake = makeFakeContainer(
      buildDoc("etag-1", { turnInProgress: { turnId: "turn-A", startedAt: now } }),
    );
    __setContainerForTesting(fake.container);

    // A turn arriving just past the TTL self-heals the crashed lease.
    const takeover = await acquireTurnLease(SESSION_ID, "turn-B", now + TURN_LEASE_TTL_MS);
    assert.equal(takeover, true, "stale lease → taken over");
    assert.equal(fake.state.stored?.turnInProgress?.turnId, "turn-B");
  });

  it("returns null for a missing session (not a contention case)", async () => {
    const fake = makeFakeContainer(null);
    __setContainerForTesting(fake.container);
    const r = await acquireTurnLease("no-such-session", "turn-A");
    assert.equal(r, null);
  });

  it("releaseTurnLease clears only a lease owned by the caller", async () => {
    const fake = makeFakeContainer(
      buildDoc("etag-1", { turnInProgress: { turnId: "turn-A", startedAt: Date.now() } }),
    );
    __setContainerForTesting(fake.container);

    // A different turn's release is a no-op (must not clear the live owner).
    await releaseTurnLease(SESSION_ID, "turn-OTHER");
    assert.equal(fake.state.stored?.turnInProgress?.turnId, "turn-A", "foreign release is a no-op");

    // The owner's release clears it.
    await releaseTurnLease(SESSION_ID, "turn-A");
    assert.equal(fake.state.stored?.turnInProgress, undefined, "owner release clears the lease");
  });
});

describe("PERF-5 · getChatSummaryBySessionId (lean projection)", () => {
  afterEach(() => {
    __setContainerForTesting(null);
    __resetSessionWriteChainForTesting();
  });

  it("returns only light fields via the summary projection (never SELECT *)", async () => {
    const fake = makeFakeContainer(
      buildDoc("etag-1", {
        permanentContext: "FMCG haircare notes",
        enrichmentStatus: "complete",
      }),
    );
    __setContainerForTesting(fake.container);

    const summary = await getChatSummaryBySessionId(SESSION_ID);
    assert.ok(summary, "summary returned");
    assert.equal(summary!.permanentContext, "FMCG haircare notes");
    assert.equal(summary!.enrichmentStatus, "complete");
    assert.equal(summary!.rowCount, 7, "rowCount surfaced flat off dataSummary");
    assert.equal(summary!.columnCount, 3);
    // The lean read must use the summary projection, NOT the full SELECT *.
    assert.equal(fake.record.summaryQueries, 1, "exactly one summary query");
    assert.equal(fake.record.fullQueries, 0, "must NOT issue a full SELECT *");
    // The projected object carries no heavy fields.
    assert.equal((summary as Record<string, unknown>).messages, undefined);
    assert.equal((summary as Record<string, unknown>).rawData, undefined);
  });

  it("returns null when no doc matches the sessionId", async () => {
    const fake = makeFakeContainer(null);
    __setContainerForTesting(fake.container);
    const summary = await getChatSummaryBySessionId("missing-session");
    assert.equal(summary, null);
  });
});
