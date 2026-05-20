/**
 * Wave W61-audit-history-api · admin audit-log GET endpoint.
 *
 * Pairs with the W61-audit-log write path: the prior wave snaps each
 * PATCH's prior model into a capped newest-first ring buffer on the
 * ChatDocument; this wave exposes that buffer over a dedicated read-only
 * endpoint so a future history-tab UI (and a future POST revert
 * endpoint) can both consume it without bloating the existing detail
 * endpoint payload.
 *
 * Harness mirrors the W61-detail test: the injected `_detailFetcher`
 * shim lets us stand up the read path without Cosmos. The controller
 * surface contract is the projection + 403/400/404/500 envelope; the
 * underlying Cosmos fetch is exercised in production paths.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  getSemanticModelAuditLog,
  __setSemanticModelDetailFetcherForTesting,
  type AdminSemanticModelAuditLogResponse,
} from "../controllers/adminSemanticModelController.js";
import type { ChatDocument } from "../models/chat.model.js";
import type { SemanticModel } from "../shared/schema.js";
import type { SemanticModelAuditEntry } from "../lib/semantic/semanticModelAuditLog.js";
import {
  __setSuperadminEmailsForTesting,
  __resetSuperadminEmailsForTesting,
} from "../lib/superadmin.js";

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
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    body: {},
    auth: undefined,
  } as unknown as Request;
}

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
  priorVersion: number,
  label: string,
  savedBy = "admin@example.com",
): SemanticModelAuditEntry {
  return {
    savedAt,
    savedBy,
    priorVersion,
    priorModel: makeModel(priorVersion, label),
  };
}

const FIXTURE_SESSION = "sess-1";

function makeDoc(
  semanticModel: SemanticModel | undefined,
  auditLog?: SemanticModelAuditEntry[],
): ChatDocument {
  return {
    id: "doc-1",
    username: "alice@example.com",
    sessionId: FIXTURE_SESSION,
    fileName: "sales.csv",
    lastUpdatedAt: 1_700_000_000_000,
    semanticModel,
    semanticModelAuditLog: auditLog,
  } as ChatDocument;
}

// ─── Admin-gate + parameter validation ───────────────────────────────

test("W61-audit-history-api · getSemanticModelAuditLog: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "random@example.com",
        params: { sessionId: FIXTURE_SESSION },
      }),
      res,
    );
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-history-api · getSemanticModelAuditLog: 400 when sessionId is missing or whitespace", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({ email: "admin@example.com", params: { sessionId: "   " } }),
      res,
    );
    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: "missing_session_id" });
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 404 paths ────────────────────────────────────────────────────────

test("W61-audit-history-api · getSemanticModelAuditLog: 404 when the session doesn't exist", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "no-such-session" },
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "session_not_found",
      sessionId: "no-such-session",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-history-api · getSemanticModelAuditLog: 404 when the session has no semanticModel (pre-W57)", async () => {
  // A pre-W57 session can't have an audit log because the W61-audit-log
  // write path only fires on PATCH (which itself 404s when there's no
  // model to patch). Mirror getSemanticModel's 404 here so the UI
  // handles one "pre-W57" branch, not two.
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(undefined, undefined),
  );
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "semantic_model_not_inferred",
      sessionId: FIXTURE_SESSION,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 200 envelope shape ──────────────────────────────────────────────

test("W61-audit-history-api · getSemanticModelAuditLog: 200 with empty entries when session has a model but no audit log yet", async () => {
  // A W57-inferred session that hasn't been PATCHed yet: semanticModel
  // is defined, semanticModelAuditLog is undefined. Return [] (not the
  // raw undefined) so the UI doesn't need to ?? [] at the call site.
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel(1), undefined),
  );
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelAuditLogResponse;
    assert.equal(body.sessionId, FIXTURE_SESSION);
    assert.deepEqual(body.entries, []);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-history-api · getSemanticModelAuditLog: 200 with populated entries preserves newest-first order", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  // Buffer was produced by W61-audit-log's append helper, so [0] is
  // newest. Verify the endpoint hands it back byte-identical.
  const log: SemanticModelAuditEntry[] = [
    makeEntry(300, 3, "v3 label", "bob@example.com"),
    makeEntry(200, 2, "v2 label", "alice@example.com"),
    makeEntry(100, 1, "v1 label", "alice@example.com"),
  ];
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel(4, "v4 label"), log),
  );
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelAuditLogResponse;
    assert.equal(body.sessionId, FIXTURE_SESSION);
    assert.equal(body.entries.length, 3);
    assert.deepEqual(
      body.entries.map((e) => e.priorVersion),
      [3, 2, 1],
      "newest-first ordering preserved through the controller",
    );
    assert.deepEqual(
      body.entries.map((e) => e.savedAt),
      [300, 200, 100],
    );
    assert.deepEqual(
      body.entries.map((e) => e.savedBy),
      ["bob@example.com", "alice@example.com", "alice@example.com"],
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-history-api · getSemanticModelAuditLog: 200 preserves full priorModel snapshot per entry", async () => {
  // Load-bearing: the revert UI consumes priorModel directly; a future
  // refactor that field-projected the snapshot down to e.g. just the
  // version + a hash would break revert without breaking this test
  // unless we pin a content-bearing field of the snapshot.
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  const log: SemanticModelAuditEntry[] = [
    makeEntry(2, 2, "Most recent prior label"),
    makeEntry(1, 1, "Oldest prior label"),
  ];
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel(3), log),
  );
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelAuditLogResponse;
    assert.equal(
      body.entries[0].priorModel.metrics[0].label,
      "Most recent prior label",
    );
    assert.equal(
      body.entries[1].priorModel.metrics[0].label,
      "Oldest prior label",
    );
    // priorModel carries the full SemanticModel shape (not a projection)
    assert.equal(body.entries[0].priorModel.name, "Sales model");
    assert.equal(body.entries[0].priorModel.version, 2);
    assert.equal(body.entries[0].priorModel.metrics[0].expression, "SUM(sales_amount)");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── Edge cases ──────────────────────────────────────────────────────

test("W61-audit-history-api · getSemanticModelAuditLog: 500 when the detail fetcher throws", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    throw new Error("cosmos unavailable");
  });
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_audit_log_failed",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-history-api · getSemanticModelAuditLog: trims whitespace in sessionId param", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  let capturedSessionId: string | null = null;
  __setSemanticModelDetailFetcherForTesting(async (sid) => {
    capturedSessionId = sid;
    return makeDoc(makeModel(1), [makeEntry(1, 0, "Initial prior")]);
  });
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "  sess-1  " },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(capturedSessionId, "sess-1", "leading/trailing whitespace stripped");
    const body = res._body as AdminSemanticModelAuditLogResponse;
    assert.equal(body.sessionId, FIXTURE_SESSION);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-history-api · response.entries is byte-equivalent to doc.semanticModelAuditLog", async () => {
  // Pin that the endpoint hands the buffer through without re-sorting,
  // re-capping, or deep-cloning. A future refactor that introduced any
  // of those should be a deliberate decision touched by this test.
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  const log: SemanticModelAuditEntry[] = [
    makeEntry(5, 5, "v5"),
    makeEntry(4, 4, "v4"),
    makeEntry(3, 3, "v3"),
    makeEntry(2, 2, "v2"),
    makeEntry(1, 1, "v1"),
  ];
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel(6), log),
  );
  try {
    const res = fakeRes();
    await getSemanticModelAuditLog(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelAuditLogResponse;
    assert.deepEqual(body.entries, log);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});
