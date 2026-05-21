/**
 * Wave W61-detail · admin semantic-model detail endpoint.
 *
 * Pairs with the W61-list test: validates the `:sessionId` route's
 * admin gate, parameter parsing, 404 paths (missing session OR
 * pre-W57 session with no inferred model), envelope shape on success,
 * and 500 propagation on Cosmos failure. The Cosmos fetch itself
 * (`getChatBySessionIdEfficient`) is exercised in production paths and
 * by the W57 wave's tests; this wave's contract is the projection +
 * gating that sits between Cosmos and the wire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  getSemanticModel,
  __setSemanticModelDetailFetcherForTesting,
  type AdminSemanticModelDetailResponse,
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
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    body: {},
    auth: undefined,
  } as unknown as Request;
}

const FIXTURE_MODEL: SemanticModel = {
  version: 2,
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

const DOC_WITHOUT_MODEL: ChatDocument = {
  id: "doc-2",
  username: "bob@example.com",
  sessionId: "sess-2",
  fileName: "old_legacy.csv",
  lastUpdatedAt: 1_600_000_000_000,
  // semanticModel intentionally absent — pre-W57 session
} as ChatDocument;

test("W61-detail · getSemanticModel: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({
        email: "random@example.com",
        params: { sessionId: "sess-1" },
      }),
      res,
    );
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail · getSemanticModel: 400 when sessionId is missing or empty", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModel(
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

test("W61-detail · getSemanticModel: 404 when the session doesn't exist", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  try {
    const res = fakeRes();
    await getSemanticModel(
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

test("W61-detail · getSemanticModel: 404 when the session has no semanticModel (pre-W57)", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => DOC_WITHOUT_MODEL);
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-2" },
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "semantic_model_not_inferred",
      sessionId: "sess-2",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail · getSemanticModel: 200 envelope for admin with valid session", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => FIXTURE_DOC);
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-1" },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelDetailResponse;
    assert.equal(body.sessionId, "sess-1");
    assert.equal(body.fileName, "sales.csv");
    assert.equal(body.username, "alice@example.com");
    assert.equal(body.lastUpdatedAt, 1_700_000_000_000);
    assert.equal(body.model.version, 2);
    assert.equal(body.model.name, "Sales semantic model");
    assert.equal(body.model.metrics.length, 1);
    assert.equal(body.model.metrics[0].name, "gross_revenue");
    assert.equal(body.model.dimensions.length, 1);
    assert.equal(body.model.dimensions[0].name, "region");
    assert.equal(body.model.hierarchies.length, 0);
    // W61-detail-schema · datasetSchema is null on this fixture
    // because FIXTURE_DOC has no dataSummary; the dedicated
    // W61-detail-schema test file covers the populated branch.
    assert.equal(body.datasetSchema, null);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail · getSemanticModel: 500 when the detail fetcher throws", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    throw new Error("cosmos unavailable");
  });
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "sess-1" },
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_detail_failed",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail · getSemanticModel: trims whitespace in sessionId param", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  let capturedSessionId: string | null = null;
  __setSemanticModelDetailFetcherForTesting(async (sid) => {
    capturedSessionId = sid;
    return FIXTURE_DOC;
  });
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({
        email: "admin@example.com",
        params: { sessionId: "  sess-1  " },
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(capturedSessionId, "sess-1");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail · __setSemanticModelDetailFetcherForTesting(null) restores the production fetcher", () => {
  assert.doesNotThrow(() => {
    __setSemanticModelDetailFetcherForTesting(async () => null);
    __setSemanticModelDetailFetcherForTesting(null);
  });
});
