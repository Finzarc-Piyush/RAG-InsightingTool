/**
 * Wave W61-references-dashboards · controller tests for the
 * widened references endpoint that includes cross-dashboard counts.
 *
 *   GET /admin/semantic-models/:sessionId/references?entry=<name>
 *   → { sessionId, entry, chartCount, totalOccurrences,
 *       dashboardCount, dashboardTileCount }
 *
 * The pure-function scanner tests
 * (`semanticModelDashboardReferencesW61ReferencesDashboards.test.ts`)
 * cover the field-walking semantics; this file covers the controller
 * surface — the `_dashboardListerForUser` injectable, the username
 * passthrough, the empty-username short-circuit, and the combined
 * in-chat + dashboard envelope shape.
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
import type {
  ChartSpec,
  Dashboard,
  DashboardSheet,
  SemanticModel,
} from "../shared/schema.js";
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

function makeModel(): SemanticModel {
  return {
    version: 1,
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

function makeSheet(
  charts: ChartSpec[],
  overrides: Partial<DashboardSheet> = {},
): DashboardSheet {
  return {
    id: "sheet_1",
    name: "Overview",
    charts,
    order: 0,
    ...overrides,
  };
}

function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: "dash-1",
    username: "alice@example.com",
    name: "Sales overview",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    charts: [],
    sheets: [],
    ...overrides,
  };
}

const FIXTURE_SESSION = "sess-1";
const ADMIN_EMAIL = "admin@example.com";

function makeDoc(args: {
  username?: string;
  semanticModel?: SemanticModel;
  charts?: ChartSpec[];
}): ChatDocument {
  return {
    id: "doc-1",
    username: args.username ?? "alice@example.com",
    sessionId: FIXTURE_SESSION,
    fileName: "sales.csv",
    lastUpdatedAt: 1_700_000_000_000,
    semanticModel: args.semanticModel,
    charts: args.charts ?? [],
    messages: [],
  } as unknown as ChatDocument;
}

// ─── Combined in-chat + dashboard envelope ───────────────────────────

test("W61-references-dashboards · 200 envelope includes dashboardCount + dashboardTileCount fields", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({
      semanticModel: makeModel(),
      charts: [makeChart({ y: "net_sales_value" })],
    }),
  );
  __setDashboardListerForUserForTesting(async () => [
    makeDashboard({
      sheets: [makeSheet([makeChart({ y: "net_sales_value" })])],
    }),
  ]);
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
      chartCount: 1,
      totalOccurrences: 1,
      dashboardCount: 1,
      dashboardTileCount: 1,
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-dashboards · dashboard-only matches (chartCount=0, dashboardCount>0)", async () => {
  // Real-world scenario: a domain pack metric used by promoted
  // dashboard tiles but never plotted in-chat. The admin still gets
  // the dashboard-impact warning even though the in-chat count is zero.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ semanticModel: makeModel(), charts: [] }),
  );
  __setDashboardListerForUserForTesting(async () => [
    makeDashboard({
      sheets: [
        makeSheet([
          makeChart({ y: "net_sales_value" }),
          makeChart({ y: "net_sales_value" }),
        ]),
      ],
    }),
  ]);
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
    assert.equal(body.dashboardCount, 1);
    assert.equal(body.dashboardTileCount, 2);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-dashboards · dashboard lister receives the chat doc's username, not the sessionId", async () => {
  // Pins the partition-key correctness: dashboards are partitioned by
  // username (not sessionId); the handler must thread the chat doc's
  // username field — a regression that passed sessionId instead would
  // silently return zero hits because no dashboard belongs to a session.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ username: "bob@example.com", semanticModel: makeModel() }),
  );
  let receivedUsername = "";
  __setDashboardListerForUserForTesting(async (username) => {
    receivedUsername = username;
    return [];
  });
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
    assert.equal(receivedUsername, "bob@example.com");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-dashboards · empty username short-circuits the dashboard fetch", async () => {
  // System-test sessions with no associated user used to slip through.
  // The handler must not call the lister with an empty string (the
  // production lister would still call Cosmos and waste a round-trip);
  // the short-circuit returns zero dashboard counts directly.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ username: "", semanticModel: makeModel() }),
  );
  let listerCalled = false;
  __setDashboardListerForUserForTesting(async () => {
    listerCalled = true;
    return [];
  });
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
    assert.equal(body.dashboardCount, 0);
    assert.equal(body.dashboardTileCount, 0);
    assert.equal(
      listerCalled,
      false,
      "lister should not be invoked for an empty username",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-dashboards · multiple dashboards aggregate correctly across the envelope", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ semanticModel: makeModel() }),
  );
  // Three dashboards: A has 2 matching tiles on 1 sheet, B has 1
  // matching tile on each of 2 sheets (= 2 tiles), C has none.
  // Expected: dashboardCount=2, dashboardTileCount=4.
  __setDashboardListerForUserForTesting(async () => [
    makeDashboard({
      id: "a",
      sheets: [
        makeSheet([
          makeChart({ y: "net_sales_value" }),
          makeChart({ y: "net_sales_value" }),
        ]),
      ],
    }),
    makeDashboard({
      id: "b",
      sheets: [
        makeSheet([makeChart({ y: "net_sales_value" })], { id: "s1" }),
        makeSheet([makeChart({ y: "net_sales_value" })], {
          id: "s2",
          order: 1,
        }),
      ],
    }),
    makeDashboard({
      id: "c",
      sheets: [makeSheet([makeChart({ y: "unrelated" })])],
    }),
  ]);
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
    assert.equal(body.dashboardCount, 2);
    assert.equal(body.dashboardTileCount, 4);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-dashboards · dashboard lister error throws → 500 with the existing wave-specific code", async () => {
  // The dashboard lister is in the same try / catch as the chat-doc
  // fetch. An error from either surfaces as the same
  // admin_semantic_model_references_failed code so ops can grep one
  // line per failure surface.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ semanticModel: makeModel() }),
  );
  __setDashboardListerForUserForTesting(async () => {
    throw new Error("dashboards cosmos boom");
  });
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
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-references-dashboards · legacy dashboards (no sheets) walk top-level charts[] for tile counts", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ semanticModel: makeModel() }),
  );
  __setDashboardListerForUserForTesting(async () => [
    makeDashboard({
      sheets: undefined,
      charts: [
        makeChart({ y: "net_sales_value" }),
        makeChart({ y: "unrelated" }),
      ],
    }),
  ]);
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
    assert.equal(body.dashboardCount, 1);
    assert.equal(body.dashboardTileCount, 1);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setDashboardListerForUserForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});
