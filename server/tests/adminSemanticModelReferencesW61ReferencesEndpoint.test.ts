/**
 * Wave W61-references-endpoint · admin GET endpoint that wires the
 * W61-references-scan scanner into a downstream-reference counter
 * exposed over the wire.
 *
 *   GET /admin/semantic-models/:sessionId/references?entry=<name>
 *
 * Pairs with the prior W61-references-scan wave's pure-function
 * scanner — this wave is the controller surface only. The scanner's
 * field-walking semantics are exhaustively tested in
 * [`semanticModelReferencesW61ReferencesScan.test.ts`](./semanticModelReferencesW61ReferencesScan.test.ts);
 * this file covers the 403 / 400 / 404 / 200 envelope shape, the
 * `entry` query-param trim semantics, and the choice to walk
 * `doc.charts[]` only (not blob-stored references).
 *
 * Harness mirrors the W61-detail / W61-audit-history-api test shape:
 * the injected `_detailFetcher` shim lets us stand up the read path
 * without Cosmos.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  getSemanticModelReferences,
  __setSemanticModelDetailFetcherForTesting,
  __setDashboardListerForUserForTesting,
  type AdminSemanticModelReferencesResponse,
} from "../controllers/adminSemanticModelController.js";
import type { ChatDocument } from "../models/chat.model.js";
import type { ChartSpec, SemanticModel } from "../shared/schema.js";
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
  query?: Record<string, unknown>;
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    query: args.query ?? {},
    body: {},
    auth: undefined,
  } as unknown as Request;
}

function makeModel(version: number): SemanticModel {
  return {
    version,
    name: "Sales model",
    metrics: [
      {
        name: "net_sales_value",
        label: "Net sales value",
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

function makeChart(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    type: "bar",
    title: "Sales by region",
    x: "region",
    y: "sales",
    ...overrides,
  };
}

const FIXTURE_SESSION = "sess-1";

function makeDoc(args: {
  semanticModel?: SemanticModel;
  charts?: ChartSpec[];
}): ChatDocument {
  return {
    id: "doc-1",
    username: "alice@example.com",
    sessionId: FIXTURE_SESSION,
    fileName: "sales.csv",
    lastUpdatedAt: 1_700_000_000_000,
    semanticModel: args.semanticModel,
    charts: args.charts ?? [],
    messages: [],
  } as unknown as ChatDocument;
}

const ADMIN_EMAIL = "admin@example.com";

// ─── Admin-gate + parameter validation ───────────────────────────────

test("W61-references-endpoint · getSemanticModelReferences: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: "random@example.com",
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "net_sales_value" },
      }),
      res,
    );
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-endpoint · getSemanticModelReferences: 400 when sessionId is missing or whitespace", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: "   " },
        query: { entry: "net_sales_value" },
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

test("W61-references-endpoint · getSemanticModelReferences: 400 when `entry` query param is absent", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: {},
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: "missing_entry" });
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-endpoint · getSemanticModelReferences: 400 when `entry` is whitespace-only", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "   " },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: "missing_entry" });
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-endpoint · getSemanticModelReferences: 400 when `entry` is an array (?entry=a&entry=b)", async () => {
  // Express's qs parser turns repeated keys into an array. The handler
  // accepts only single-string queries — anything else is malformed.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: ["a", "b"] },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: "missing_entry" });
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 404 paths ────────────────────────────────────────────────────────

test("W61-references-endpoint · getSemanticModelReferences: 404 when the session doesn't exist", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: "no-such-session" },
        query: { entry: "net_sales_value" },
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

test("W61-references-endpoint · getSemanticModelReferences: 404 when the session has no semanticModel (pre-W57)", async () => {
  // Mirror getSemanticModel / getSemanticModelAuditLog's 404 here so
  // the UI handles one "pre-W57" branch, not three.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => makeDoc({}));
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "net_sales_value" },
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

test("W61-references-endpoint · getSemanticModelReferences: 200 with zero counts when charts array is empty", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ semanticModel: makeModel(1), charts: [] }),
  );
  __setDashboardListerForUserForTesting(async () => []);
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "net_sales_value" },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelReferencesResponse;
    assert.deepEqual(body, {
      sessionId: FIXTURE_SESSION,
      entry: "net_sales_value",
      chartCount: 0,
      totalOccurrences: 0,
      dashboardCount: 0,
      dashboardTileCount: 0,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-endpoint · getSemanticModelReferences: 200 with correct counts for charts that reference the entry", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  // Three charts: one references the entry once (y), one references
  // it twice (x + y), one doesn't reference it. Expected: 2 distinct
  // charts, 3 total occurrences.
  const charts: ChartSpec[] = [
    makeChart({ y: "net_sales_value" }),
    makeChart({ x: "net_sales_value", y: "net_sales_value" }),
    makeChart({ x: "region", y: "volume" }),
  ];
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ semanticModel: makeModel(1), charts }),
  );
  __setDashboardListerForUserForTesting(async () => []);
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "net_sales_value" },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelReferencesResponse;
    assert.deepEqual(body, {
      sessionId: FIXTURE_SESSION,
      entry: "net_sales_value",
      chartCount: 2,
      totalOccurrences: 3,
      dashboardCount: 0,
      dashboardTileCount: 0,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-endpoint · getSemanticModelReferences: returns the server-trimmed entry, not the raw query value", async () => {
  // ?entry=%20net_sales_value%20 arrives as " net_sales_value ".
  // The server trims it before the scan; the envelope echoes the
  // trimmed form so the client can compare against its own state
  // without re-implementing the trim rule.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({
      semanticModel: makeModel(1),
      charts: [makeChart({ y: "net_sales_value" })],
    }),
  );
  __setDashboardListerForUserForTesting(async () => []);
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "  net_sales_value  " },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelReferencesResponse;
    assert.equal(body.entry, "net_sales_value");
    assert.equal(body.chartCount, 1);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-endpoint · getSemanticModelReferences: undefined doc.charts coerces to empty (no throw)", async () => {
  // Defensive: a session whose `charts` field is missing entirely
  // (legacy doc shape) must not throw — return zero counts so the UI
  // shows "0 affected" which is correct: a session with no charts
  // has no downstream impact.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    const doc = makeDoc({ semanticModel: makeModel(1) });
    delete (doc as { charts?: unknown }).charts;
    return doc;
  });
  __setDashboardListerForUserForTesting(async () => []);
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "net_sales_value" },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelReferencesResponse;
    assert.equal(body.chartCount, 0);
    assert.equal(body.totalOccurrences, 0);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 500 path ────────────────────────────────────────────────────────

test("W61-references-endpoint · getSemanticModelReferences: 500 when the fetcher throws", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    throw new Error("cosmos boom");
  });
  // Capture console.error so the failure noise doesn't pollute the
  // test runner output.
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = fakeRes();
    await getSemanticModelReferences(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION },
        query: { entry: "net_sales_value" },
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_references_failed",
    });
  } finally {
    console.error = originalError;
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});
