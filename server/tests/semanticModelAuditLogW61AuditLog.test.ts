/**
 * Wave W61-audit-log · prior-model audit trail for admin PATCH.
 *
 * Unit-tests for the pure `appendSemanticModelAuditEntry` ring-buffer
 * helper, plus end-to-end checks through `patchSemanticModel` that the
 * audit log grows, caps, and snapshots the *prior* (not next) model.
 *
 * Test harness mirrors the W61-save controller test: the injected
 * `__set*ForTesting` shims let us stand up the patch path without
 * Cosmos. A shared `currentDoc` reference threaded between the fetcher
 * stub and the updater stub simulates persisting the audit log across
 * consecutive PATCHes — the production Cosmos updater would write the
 * field back transparently because the ChatDocument blob is stored as
 * raw JSON.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  appendSemanticModelAuditEntry,
  SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES,
  type SemanticModelAuditEntry,
} from "../lib/semantic/semanticModelAuditLog.js";
import {
  patchSemanticModel,
  __setSemanticModelDetailFetcherForTesting,
  __setSemanticModelUpdaterForTesting,
} from "../controllers/adminSemanticModelController.js";
import type { ChatDocument } from "../models/chat.model.js";
import type { SemanticModel } from "../shared/schema.js";
import {
  __setSuperadminEmailsForTesting,
  __resetSuperadminEmailsForTesting,
} from "../lib/superadmin.js";

// ─── Pure-module fixtures ────────────────────────────────────────────

function makeModel(version: number, label = "Gross revenue"): SemanticModel {
  return {
    version,
    name: "Sales model",
    metrics: [
      {
        name: "gross_revenue",
        label,
        expression: "SUM(sales_amount)",
        format: "currency",
        currencyCode: "USD",
        references: ["sales_amount"],
        exposed: true,
        source: "auto",
      },
    ],
    dimensions: [],
    hierarchies: [],
  };
}

function makeEntry(
  savedAt: number,
  savedBy = "admin@example.com",
  priorVersion = 1,
): SemanticModelAuditEntry {
  return {
    savedAt,
    savedBy,
    priorVersion,
    priorModel: makeModel(priorVersion),
  };
}

// ─── Pure-module tests ───────────────────────────────────────────────

test("W61-audit-log · SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES pin = 10", () => {
  // Pin to catch a future bump that would change Cosmos doc footprint
  // assumptions. A wave that intentionally raises this should update
  // both the constant and this assertion in the same diff.
  assert.equal(SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES, 10);
});

test("W61-audit-log · appendSemanticModelAuditEntry(undefined, entry) creates a 1-element log", () => {
  const out = appendSemanticModelAuditEntry(undefined, makeEntry(1));
  assert.equal(out.length, 1);
  assert.equal(out[0].savedAt, 1);
});

test("W61-audit-log · appendSemanticModelAuditEntry prepends newest-first", () => {
  const log = [makeEntry(100), makeEntry(50)];
  const out = appendSemanticModelAuditEntry(log, makeEntry(200));
  assert.deepEqual(
    out.map((e) => e.savedAt),
    [200, 100, 50],
    "new entry lands at index 0; older entries shift right",
  );
});

test("W61-audit-log · cap drops the oldest entry when exceeding max", () => {
  // 11 entries with default max=10 → oldest (savedAt=1) drops off.
  const entries: SemanticModelAuditEntry[] = [];
  for (let i = 10; i >= 1; i--) entries.push(makeEntry(i));
  // entries is newest-first: [10, 9, 8, ..., 1]
  const out = appendSemanticModelAuditEntry(entries, makeEntry(11));
  assert.equal(out.length, SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES);
  assert.equal(out[0].savedAt, 11, "newest at the head");
  assert.equal(out[9].savedAt, 2, "oldest (savedAt=1) was dropped");
  assert.ok(
    !out.some((e) => e.savedAt === 1),
    "savedAt=1 is gone from the buffer",
  );
});

test("W61-audit-log · cap exactly at max keeps all entries; one more drops the tail", () => {
  // Start from 9 entries, prepend a 10th — under cap, all retained.
  const nine: SemanticModelAuditEntry[] = [];
  for (let i = 9; i >= 1; i--) nine.push(makeEntry(i));
  const atCap = appendSemanticModelAuditEntry(nine, makeEntry(10));
  assert.equal(atCap.length, 10);
  // Prepend an 11th — tail drops.
  const overCap = appendSemanticModelAuditEntry(atCap, makeEntry(11));
  assert.equal(overCap.length, 10);
  assert.equal(overCap[0].savedAt, 11);
  assert.equal(overCap[9].savedAt, 2);
});

test("W61-audit-log · custom max param overrides the default", () => {
  // Test the cap mechanics without hand-rolling 11 entries — pass max=3.
  let log: SemanticModelAuditEntry[] = [];
  for (let i = 1; i <= 5; i++) {
    log = appendSemanticModelAuditEntry(log, makeEntry(i), 3);
  }
  assert.equal(log.length, 3);
  assert.deepEqual(
    log.map((e) => e.savedAt),
    [5, 4, 3],
    "newest 3 retained, oldest 2 dropped",
  );
});

test("W61-audit-log · input array is never mutated", () => {
  const input: SemanticModelAuditEntry[] = [makeEntry(1), makeEntry(0)];
  const snapshot = input.slice();
  appendSemanticModelAuditEntry(input, makeEntry(2));
  assert.deepEqual(
    input.map((e) => e.savedAt),
    snapshot.map((e) => e.savedAt),
    "prior input is byte-identical after the append",
  );
});

test("W61-audit-log · returns a fresh array reference even when under cap", () => {
  // Load-bearing: a future "defensive" refactor that returned the
  // input reference unchanged when no cap-trim happened would break
  // callers that expect to assign the result back into a frozen field.
  const input: SemanticModelAuditEntry[] = [makeEntry(1)];
  const out = appendSemanticModelAuditEntry(input, makeEntry(2));
  assert.notEqual(out, input);
});

test("W61-audit-log · undefined prior + custom max still respects the cap", () => {
  // Edge case: max=0 (degenerate but legal). The new entry is appended
  // then immediately trimmed away — result is empty. This pins that
  // the cap is applied AFTER prepend, not before.
  const out = appendSemanticModelAuditEntry(undefined, makeEntry(1), 0);
  assert.deepEqual(out, []);
});

test("W61-audit-log · each entry preserves its full priorModel snapshot", () => {
  const v1 = makeModel(1, "Old label");
  const v2 = makeModel(2, "New label");
  const log = appendSemanticModelAuditEntry(undefined, {
    savedAt: 1,
    savedBy: "alice@example.com",
    priorVersion: 1,
    priorModel: v1,
  });
  const log2 = appendSemanticModelAuditEntry(log, {
    savedAt: 2,
    savedBy: "alice@example.com",
    priorVersion: 2,
    priorModel: v2,
  });
  assert.equal(log2[0].priorModel.metrics[0].label, "New label");
  assert.equal(log2[1].priorModel.metrics[0].label, "Old label");
  assert.equal(log2[0].priorVersion, 2);
  assert.equal(log2[1].priorVersion, 1);
});

// ─── Controller-integration fixtures ─────────────────────────────────

function fakeRes(): Response & { _body?: unknown; _status?: number } {
  const r: any = {};
  r._status = 200;
  r.status = (code: number) => {
    r._status = code;
    return r;
  };
  r.json = (b: unknown) => {
    r._body = b;
    return r;
  };
  return r;
}

function fakeReq(args: {
  email?: string;
  params?: Record<string, string>;
  body?: unknown;
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    body: args.body ?? {},
    auth: undefined,
  } as unknown as Request;
}

const FIXTURE_DOC_ID = "doc-1";
const FIXTURE_SESSION = "sess-1";

function makeFixtureDoc(model: SemanticModel): ChatDocument {
  return {
    id: FIXTURE_DOC_ID,
    username: "alice@example.com",
    sessionId: FIXTURE_SESSION,
    fileName: "sales.csv",
    lastUpdatedAt: 1_700_000_000_000,
    semanticModel: model,
  } as ChatDocument;
}

function validPatchBody(label: string): SemanticModel {
  return {
    version: 1, // server overwrites
    name: "Sales model",
    metrics: [
      {
        name: "gross_revenue",
        label,
        expression: "SUM(sales_amount)",
        format: "currency",
        currencyCode: "USD",
        references: ["sales_amount"],
        exposed: true,
        source: "auto",
      },
    ],
    dimensions: [],
    hierarchies: [],
  };
}

// ─── Controller integration tests ────────────────────────────────────

test("W61-audit-log · patchSemanticModel: first save writes a 1-entry audit log with the prior model", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc = makeFixtureDoc(makeModel(3, "Prior label"));
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: validPatchBody("New label"),
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.ok(currentDoc.semanticModelAuditLog, "log was written");
    assert.equal(currentDoc.semanticModelAuditLog!.length, 1);
    const entry = currentDoc.semanticModelAuditLog![0];
    assert.equal(entry.savedBy, "admin@example.com");
    assert.equal(entry.priorVersion, 3, "prior model.version captured");
    assert.equal(
      entry.priorModel.metrics[0].label,
      "Prior label",
      "snapshot is the PRIOR model (not the new one)",
    );
    assert.ok(typeof entry.savedAt === "number" && entry.savedAt > 0);
    // The new model overwrote semanticModel; audit log preserves only the prior.
    assert.equal(currentDoc.semanticModel?.metrics[0].label, "New label");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-log · patchSemanticModel: consecutive saves prepend newest-first", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc = makeFixtureDoc(makeModel(1, "v1 label"));
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    // Save 1: v1 → v2 (prior model captured = v1)
    let res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: validPatchBody("v2 label"),
      }),
      res,
    );
    assert.equal(res._status, 200);
    // Save 2: v2 → v3 (prior model captured = v2 = "v2 label")
    res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: validPatchBody("v3 label"),
      }),
      res,
    );
    assert.equal(res._status, 200);

    const log = currentDoc.semanticModelAuditLog ?? [];
    assert.equal(log.length, 2);
    // Newest-first: log[0] is the most recent save's prior (= v2)
    assert.equal(log[0].priorVersion, 2);
    assert.equal(log[0].priorModel.metrics[0].label, "v2 label");
    assert.equal(log[1].priorVersion, 1);
    assert.equal(log[1].priorModel.metrics[0].label, "v1 label");
    assert.equal(currentDoc.semanticModel?.version, 3);
    assert.equal(currentDoc.semanticModel?.metrics[0].label, "v3 label");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-log · patchSemanticModel: cap kicks in after >10 saves; oldest drops", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc = makeFixtureDoc(makeModel(1, "v1 label"));
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    // 11 saves total → after the 11th, only the most recent 10 priors
    // are retained. The very first prior (v1) drops off.
    for (let i = 2; i <= 12; i++) {
      const res = fakeRes();
      await patchSemanticModel(
        fakeReq({
          email: "admin@example.com",
          params: { sessionId: FIXTURE_SESSION },
          body: validPatchBody(`v${i} label`),
        }),
        res,
      );
      assert.equal(res._status, 200);
    }
    const log = currentDoc.semanticModelAuditLog ?? [];
    assert.equal(log.length, SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES);
    assert.equal(
      log[0].priorVersion,
      11,
      "newest prior is the 11th save's prior (= v11)",
    );
    assert.equal(
      log[9].priorVersion,
      2,
      "tail is v2 (the 2nd save's prior); v1 was evicted",
    );
    assert.ok(
      !log.some((e) => e.priorVersion === 1),
      "v1 prior is gone from the buffer",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});
