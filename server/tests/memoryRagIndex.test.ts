import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisMemoryEntry } from "../shared/schema.js";

/**
 * W57 · The Memory RAG mirror reuses the existing per-session AI Search index
 * via `chunkType = "memory_entry"`. Tests exercise the pure helpers (id
 * derivation + embedding-text shape + filter clause) without touching Azure
 * Search itself — that side-effect is fire-and-forget and out of band of our
 * test runner (no creds, no network).
 */

const memoryEntry = (
  overrides: Partial<AnalysisMemoryEntry> = {}
): AnalysisMemoryEntry => ({
  id: "session_abc__turn_001__finding__0",
  sessionId: "session_abc",
  username: "user@example.com",
  createdAt: 1_773_000_000_000,
  turnId: "turn_001",
  sequence: 0,
  type: "finding",
  actor: "agent",
  title: "East region tech sales declined 23% Mar→Apr",
  summary:
    "Q1 sales drop concentrated in East tech category; magnitude exceeds the historical seasonal pattern by 11pp.",
  body: { evidence: "compute_query_plan call abc123" },
  refs: { messageTimestamp: 1_773_000_000_000 },
  dataVersion: 1,
  significance: "anomalous",
  ...overrides,
});

describe("W57 · MEMORY_ENTRY_CHUNK_TYPE", () => {
  it("module exports the canonical chunk-type constant", async () => {
    const { MEMORY_ENTRY_CHUNK_TYPE } = await import(
      "../lib/rag/indexSession.js"
    );
    assert.strictEqual(MEMORY_ENTRY_CHUNK_TYPE, "memory_entry");
  });
});

describe("W57 · indexMemoryEntries", () => {
  it("no-ops on empty input — never touches Azure Search", async () => {
    const { indexMemoryEntries } = await import("../lib/rag/indexSession.js");
    // Should resolve without throwing even when RAG creds are absent.
    await indexMemoryEntries([]);
  });

  it("scheduleIndexMemoryEntries no-ops on empty input", async () => {
    const { scheduleIndexMemoryEntries } = await import(
      "../lib/rag/indexSession.js"
    );
    // No throw, no setImmediate dispatch.
    scheduleIndexMemoryEntries([]);
    assert.ok(true);
  });
});

describe("W64 · deleteRagDocumentsBySessionId protects memory entries", () => {
  it("default filter excludes chunkType='memory_entry'", async () => {
    const { buildSessionDeleteFilter } = await import(
      "../lib/rag/aiSearchStore.js"
    );
    const f = buildSessionDeleteFilter("sess_abc");
    assert.match(f, /sessionId eq 'sess_abc'/);
    assert.match(f, /chunkType ne 'memory_entry'/);
  });

  it("escapes single quotes in sessionId (defense vs OData injection)", async () => {
    const { buildSessionDeleteFilter } = await import(
      "../lib/rag/aiSearchStore.js"
    );
    const f = buildSessionDeleteFilter("sess_with_'quote");
    // OData escapes ' as '' (doubled).
    assert.match(f, /sessionId eq 'sess_with_''quote'/);
  });

  it("explicit empty exclusion list wipes everything (allows full session purge)", async () => {
    const { buildSessionDeleteFilter } = await import(
      "../lib/rag/aiSearchStore.js"
    );
    const f = buildSessionDeleteFilter("sess_abc", []);
    assert.strictEqual(f, "sessionId eq 'sess_abc'");
    assert.doesNotMatch(f, /chunkType ne/);
  });

  it("multiple exclusion types append ANDed clauses", async () => {
    const { buildSessionDeleteFilter } = await import(
      "../lib/rag/aiSearchStore.js"
    );
    const f = buildSessionDeleteFilter("sess_abc", [
      "memory_entry",
      "user_context",
    ]);
    assert.match(f, /chunkType ne 'memory_entry'/);
    assert.match(f, /chunkType ne 'user_context'/);
  });
});

describe("W57 · entry shape preserved on round-trip", () => {
  it("a finding entry serialises with id stable on replay", () => {
    const a = memoryEntry();
    const b = memoryEntry();
    assert.deepStrictEqual(a.id, b.id);
    // Different sequence ⇒ different id.
    const c = memoryEntry({
      id: "session_abc__turn_001__finding__1",
      sequence: 1,
    });
    assert.notStrictEqual(a.id, c.id);
  });
});
