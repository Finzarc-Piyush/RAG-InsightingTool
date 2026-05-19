/**
 * Wave W61-save · admin semantic-model PATCH endpoint.
 *
 * Validates the read-modify-write that powers the admin's edit-and-save
 * flow: admin gate, sessionId parameter, body validation via
 * `semanticModelSchema.parse`, version bump, server-stamped
 * `updatedAt` / `updatedBy`, 404 modes for missing session or pre-W57
 * doc, and 500 propagation when the Cosmos updater throws. The
 * `withSessionWriteLock` invariant is implicit in this test path —
 * the controller routes through it; a failure there would surface as
 * a 500.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

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

function fakeRes(): Response & {
  _body?: unknown;
  _status?: number;
} {
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

const FIXTURE_MODEL: SemanticModel = {
  version: 3,
  name: "Sales semantic model",
  metrics: [
    {
      name: "gross_revenue",
      label: "Gross revenue",
      expression: "SUM(sales_amount)",
      format: "currency",
      currencyCode: "USD",
      references: ["sales_amount"],
      exposed: true,
      source: "auto",
    },
  ],
  dimensions: [
    {
      name: "region",
      label: "Region",
      column: "region",
      kind: "categorical",
      exposed: true,
      source: "auto",
    },
  ],
  hierarchies: [],
  updatedAt: "2026-05-15T12:00:00.000Z",
  updatedBy: "alice@example.com",
};

const FIXTURE_DOC: ChatDocument = {
  id: "doc-1",
  username: "alice@example.com",
  sessionId: "sess-1",
  fileName: "sales.csv",
  lastUpdatedAt: 1_700_000_000_000,
  semanticModel: FIXTURE_MODEL,
} as ChatDocument;

const VALID_PATCH_BODY: SemanticModel = {
  version: 1, // server overwrites this
  name: "Sales semantic model",
  metrics: [
    {
      name: "gross_revenue",
      label: "Gross revenue",
      expression: "SUM(sales_amount)",
      format: "currency",
      currencyCode: "USD",
      references: ["sales_amount"],
      exposed: false, // <— the user just hid this metric
      source: "user",
    },
  ],
  dimensions: [
    {
      name: "region",
      label: "Region",
      column: "region",
      kind: "categorical",
      exposed: true,
      source: "auto",
    },
  ],
  hierarchies: [],
};

test("W61-save · patchSemanticModel: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "random@example.com",
        params: { sessionId: "sess-1" },
        body: VALID_PATCH_BODY,
      }),
      res,
    );
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-save · patchSemanticModel: 400 when sessionId is missing", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "  " },
        body: VALID_PATCH_BODY,
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

test("W61-save · patchSemanticModel: 400 when body fails semanticModelSchema validation", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-1" },
        body: { metrics: "not an array" }, // missing required fields, wrong types
      }),
      res,
    );
    assert.equal(res._status, 400);
    const body = res._body as {
      error: string;
      issues: Array<{ path: string; message: string }>;
    };
    assert.equal(body.error, "invalid_semantic_model");
    assert.ok(Array.isArray(body.issues));
    assert.ok(body.issues.length > 0);
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-save · patchSemanticModel: 404 when the session doesn't exist", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "no-such" },
        body: VALID_PATCH_BODY,
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "session_not_found",
      sessionId: "no-such",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-save · patchSemanticModel: 404 when the session pre-dates W57", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    return { ...FIXTURE_DOC, semanticModel: undefined } as ChatDocument;
  });
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-1" },
        body: VALID_PATCH_BODY,
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "semantic_model_not_inferred",
      sessionId: "sess-1",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-save · patchSemanticModel: 200 bumps version + stamps updatedAt/updatedBy", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => ({
    ...FIXTURE_DOC,
    semanticModel: { ...FIXTURE_MODEL },
  }));
  let savedDoc: ChatDocument | null = null;
  __setSemanticModelUpdaterForTesting(async (doc) => {
    savedDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-1" },
        body: VALID_PATCH_BODY,
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as {
      sessionId: string;
      lastUpdatedAt: number;
      model: SemanticModel;
    };
    assert.equal(body.sessionId, "sess-1");
    assert.equal(body.model.version, 4, "version bumps from prior 3 → 4");
    assert.equal(body.model.updatedBy, "admin@example.com");
    assert.ok(
      typeof body.model.updatedAt === "string" &&
        body.model.updatedAt.length > 0,
      "updatedAt stamped as ISO string",
    );
    assert.equal(
      body.model.metrics[0].exposed,
      false,
      "the user's exposed-toggle to false survived the round-trip",
    );
    assert.ok(savedDoc, "updater was invoked");
    assert.equal(
      savedDoc!.semanticModel?.version,
      4,
      "saved doc carries the bumped version",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-save · patchSemanticModel: client-sent version is overwritten by server bump", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => ({
    ...FIXTURE_DOC,
    semanticModel: { ...FIXTURE_MODEL, version: 7 },
  }));
  __setSemanticModelUpdaterForTesting(async (doc) => doc);
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-1" },
        body: { ...VALID_PATCH_BODY, version: 9999 }, // client tries to set
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    assert.equal(
      body.model.version,
      8,
      "server overrides client version to prior+1, not to 9999",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-save · patchSemanticModel: 500 when the updater throws", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => ({
    ...FIXTURE_DOC,
    semanticModel: { ...FIXTURE_MODEL },
  }));
  __setSemanticModelUpdaterForTesting(async () => {
    throw new Error("cosmos throughput exceeded");
  });
  try {
    const res = fakeRes();
    await patchSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-1" },
        body: VALID_PATCH_BODY,
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_patch_failed",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-save · __setSemanticModelUpdaterForTesting(null) restores the production updater", () => {
  assert.doesNotThrow(() => {
    __setSemanticModelUpdaterForTesting(async (d) => d);
    __setSemanticModelUpdaterForTesting(null);
  });
});
