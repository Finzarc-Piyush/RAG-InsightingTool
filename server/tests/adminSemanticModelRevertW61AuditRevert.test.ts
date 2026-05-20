/**
 * Wave W61-audit-revert · server-side one-call revert endpoint.
 *
 * Closes the W61 audit-trail server-side loop (write → read → revert)
 * by consuming the W61-audit-log ring buffer that W61-audit-history-api
 * just exposed. The chosen entry's `priorModel` becomes the new live
 * model with `version` bumped; the about-to-be-overwritten model is
 * appended to the audit log as the new newest entry so "undo this
 * revert" works without losing the intermediate state.
 *
 * Test harness mirrors the W61-audit-log integration tests: the
 * injected `_detailFetcher` + `_updater` shims thread a shared
 * `currentDoc` reference so consecutive PATCH / revert / PATCH calls
 * simulate persisting state across round-trips.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  revertSemanticModel,
  __setSemanticModelDetailFetcherForTesting,
  __setSemanticModelUpdaterForTesting,
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
  body?: unknown;
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    body: args.body ?? {},
    auth: undefined,
  } as unknown as Request;
}

function makeModel(
  version: number,
  label = "Gross revenue",
  source: "auto" | "user" | "domain" = "auto",
): SemanticModel {
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
        source,
      },
    ],
    dimensions: [],
    hierarchies: [],
  };
}

function makeEntry(
  savedAt: number,
  priorVersion: number,
  priorModel: SemanticModel,
  savedBy = "alice@example.com",
): SemanticModelAuditEntry {
  return { savedAt, savedBy, priorVersion, priorModel };
}

const FIXTURE_SESSION = "sess-1";

function makeDoc(
  semanticModel: SemanticModel,
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

// ─── Admin-gate + parameter / body validation ────────────────────────

test("W61-audit-revert · revertSemanticModel: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "random@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: 400 when sessionId is missing or whitespace", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "   " },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: "missing_session_id" });
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: 400 when body is missing auditEntryIndex", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: {},
      }),
      res,
    );
    assert.equal(res._status, 400);
    const body = res._body as { error: string };
    assert.equal(body.error, "invalid_audit_entry_index");
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: 400 when auditEntryIndex is negative", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: -1 },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(
      (res._body as { error: string }).error,
      "invalid_audit_entry_index",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: 400 when auditEntryIndex is non-integer", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 1.5 },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(
      (res._body as { error: string }).error,
      "invalid_audit_entry_index",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 404 paths ────────────────────────────────────────────────────────

test("W61-audit-revert · revertSemanticModel: 404 when the session doesn't exist", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "no-such-session" },
        body: { auditEntryIndex: 0 },
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

test("W61-audit-revert · revertSemanticModel: 404 when the session has no semanticModel", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    const doc = { ...makeDoc(makeModel(1)), semanticModel: undefined };
    return doc as ChatDocument;
  });
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
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

test("W61-audit-revert · revertSemanticModel: 404 when the audit log is empty", async () => {
  // A session that's been W57-inferred but never PATCHed has no audit
  // entries to revert to — nothing prior was ever saved.
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel(1), undefined),
  );
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "audit_entry_not_found",
      sessionId: FIXTURE_SESSION,
      auditEntryIndex: 0,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: 404 when auditEntryIndex is out of bounds", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  const log = [makeEntry(100, 1, makeModel(1, "v1 prior"))];
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel(2), log),
  );
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 5 },
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "audit_entry_not_found",
      sessionId: FIXTURE_SESSION,
      auditEntryIndex: 5,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── Happy path + content / version / updatedBy pins ────────────────

test("W61-audit-revert · revertSemanticModel: 200 restores priorModel contents with bumped version + reverting-admin stamp", async () => {
  __setSuperadminEmailsForTesting(["bob@example.com"]);
  process.env.DISABLE_AUTH = "true";
  // Snapshot at v1 had label "v1 label"; current model at v2 has "v2 label".
  const v1 = makeModel(1, "v1 label");
  let currentDoc = makeDoc(makeModel(2, "v2 label"), [
    makeEntry(100, 1, v1, "alice@example.com"),
  ]);
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "bob@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as {
      sessionId: string;
      lastUpdatedAt: number;
      model: SemanticModel;
    };
    assert.equal(body.sessionId, FIXTURE_SESSION);
    assert.equal(body.model.metrics[0].label, "v1 label", "content matches the snapshot");
    assert.equal(body.model.version, 3, "version is bumped from current (2) → 3 (monotonic)");
    assert.equal(
      body.model.updatedBy,
      "bob@example.com",
      "reverting admin stamped at the model level",
    );
    assert.ok(
      typeof body.model.updatedAt === "string" && body.model.updatedAt.length > 0,
      "updatedAt is fresh ISO",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: prepends a new audit entry capturing the about-to-be-overwritten model", async () => {
  // After revert, the buffer should have one MORE entry, and the new
  // newest entry's priorModel should match the model that was JUST
  // overwritten (the "current" model at the time of revert). This is
  // what makes "undo this revert" work.
  __setSuperadminEmailsForTesting(["bob@example.com"]);
  process.env.DISABLE_AUTH = "true";
  const v1 = makeModel(1, "v1 label");
  const v2 = makeModel(2, "v2 label");
  let currentDoc = makeDoc(v2, [makeEntry(100, 1, v1, "alice@example.com")]);
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "bob@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const log = currentDoc.semanticModelAuditLog ?? [];
    assert.equal(log.length, 2, "buffer grew by 1 (the revert is itself a save)");
    assert.equal(
      log[0].priorModel.metrics[0].label,
      "v2 label",
      "newest entry preserves the just-overwritten model (v2)",
    );
    assert.equal(log[0].priorVersion, 2, "newest entry's priorVersion === current's version");
    assert.equal(
      log[0].savedBy,
      "bob@example.com",
      "savedBy on the new entry is the reverting admin",
    );
    assert.equal(
      log[1].priorModel.metrics[0].label,
      "v1 label",
      "older entry preserved at index 1",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: snapshot source field survives the revert (NOT bumped to user)", async () => {
  // Critical pin for the "skip W61-source-bump on revert" decision.
  // The snapshot was taken when the entry had source: "auto" (the
  // original W57 inference). The current model has source: "user"
  // (the admin had edited and bumped it). After revert, the entry
  // should restore to source: "auto" from the snapshot — NOT be
  // re-stamped to "user" by the bumper (which would be wrong because
  // the revert is "restore as-was", not "edit").
  __setSuperadminEmailsForTesting(["bob@example.com"]);
  process.env.DISABLE_AUTH = "true";
  const v1Snapshot = makeModel(1, "v1 label", "auto");
  const v2Current = makeModel(2, "v2 label", "user");
  let currentDoc = makeDoc(v2Current, [
    makeEntry(100, 1, v1Snapshot, "alice@example.com"),
  ]);
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "bob@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    assert.equal(
      body.model.metrics[0].source,
      "auto",
      "per-entry source comes verbatim from the snapshot, not re-bumped by W61-source-bump",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: round-trip — revert + undo-revert yields original content with grown audit log", async () => {
  // Pin that the audit-log write on revert makes "undo this revert"
  // work cleanly. The dance: start at v2; revert to v1; revert again
  // (index 0 now points at the just-overwritten v2). Final content
  // should match v2, version should be v4 (monotonic across 2 reverts),
  // audit log should have 3 entries (the original v1 + the v2 captured
  // by the first revert + the v1-restored captured by the second).
  __setSuperadminEmailsForTesting(["bob@example.com"]);
  process.env.DISABLE_AUTH = "true";
  const v1 = makeModel(1, "v1 label");
  const v2 = makeModel(2, "v2 label");
  let currentDoc = makeDoc(v2, [makeEntry(100, 1, v1, "alice@example.com")]);
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    // First revert: v2 → v1 (audit log captures v2 as prior)
    let res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "bob@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(currentDoc.semanticModel?.metrics[0].label, "v1 label");
    assert.equal(currentDoc.semanticModel?.version, 3);
    assert.equal((currentDoc.semanticModelAuditLog ?? []).length, 2);

    // Second revert: index 0 now points at the just-captured v2 prior
    res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "bob@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(
      currentDoc.semanticModel?.metrics[0].label,
      "v2 label",
      "undo-revert restored the v2 content",
    );
    assert.equal(currentDoc.semanticModel?.version, 4, "version stays monotonic across 2 reverts");
    const log = currentDoc.semanticModelAuditLog ?? [];
    assert.equal(log.length, 3, "audit log captured both reverts");
    assert.equal(
      log[0].priorModel.metrics[0].label,
      "v1 label",
      "newest entry is the v1-restored model overwritten by the undo",
    );
    assert.equal(log[1].priorModel.metrics[0].label, "v2 label");
    assert.equal(log[2].priorModel.metrics[0].label, "v1 label");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-audit-revert · revertSemanticModel: 500 when the updater throws", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  const v1 = makeModel(1, "v1 label");
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel(2), [makeEntry(100, 1, v1)]),
  );
  __setSemanticModelUpdaterForTesting(async () => {
    throw new Error("cosmos unavailable");
  });
  try {
    const res = fakeRes();
    await revertSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: FIXTURE_SESSION },
        body: { auditEntryIndex: 0 },
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_revert_failed",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});
