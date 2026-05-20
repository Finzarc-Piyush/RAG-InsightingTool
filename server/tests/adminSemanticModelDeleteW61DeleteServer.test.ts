/**
 * Wave W61-delete-server · DELETE endpoint for removing a single
 * metric / dimension / hierarchy from a session's semantic model.
 *
 *   DELETE /admin/semantic-models/:sessionId/entries/:kind/:name
 *
 * Mirrors the W61-audit-revert harness shape: a shared `currentDoc`
 * reference threaded between the fetcher stub and the updater stub
 * simulates persisting the audit log across consecutive operations.
 * The production Cosmos updater writes the field back transparently
 * because the ChatDocument blob is stored as raw JSON.
 *
 * Coverage focuses on: admin gate (403), parameter validation (400
 * across sessionId / kind / name), 404 paths (session / model /
 * entry not found), 200 success per kind (metric / dimension /
 * hierarchy), audit-log integration (prior model snapshot grows
 * the buffer with the deleted entry intact), version monotonicity,
 * and surviving entries' `source` preservation (delete is a model
 * edit but the survivors are themselves unchanged so their source
 * stays at its prior value).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  deleteSemanticModelEntry,
  __setSemanticModelDetailFetcherForTesting,
  __setSemanticModelUpdaterForTesting,
} from "../controllers/adminSemanticModelController.js";
import type { ChatDocument } from "../models/chat.model.js";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
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
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    body: {},
    auth: undefined,
  } as unknown as Request;
}

const FIXTURE_SESSION = "sess-1";
const ADMIN_EMAIL = "admin@example.com";

function makeMetric(
  name: string,
  source: SemanticMetric["source"] = "auto",
): SemanticMetric {
  return {
    name,
    label: `${name} label`,
    expression: `SUM(${name}_col)`,
    format: "number",
    references: [`${name}_col`],
    exposed: true,
    source,
  };
}

function makeDimension(
  name: string,
  source: SemanticDimension["source"] = "auto",
): SemanticDimension {
  return {
    name,
    label: `${name} label`,
    column: `${name}_col`,
    kind: "categorical",
    exposed: true,
    source,
  };
}

function makeHierarchy(
  name: string,
  source: SemanticHierarchy["source"] = "auto",
): SemanticHierarchy {
  return {
    name,
    label: `${name} label`,
    levels: [{ column: `${name}_col`, label: "Level 1" }],
    source,
  };
}

function makeModel(args: {
  version?: number;
  metrics?: SemanticMetric[];
  dimensions?: SemanticDimension[];
  hierarchies?: SemanticHierarchy[];
} = {}): SemanticModel {
  return {
    version: args.version ?? 3,
    name: "Sales model",
    metrics: args.metrics ?? [makeMetric("alpha"), makeMetric("beta")],
    dimensions: args.dimensions ?? [],
    hierarchies: args.hierarchies ?? [],
  };
}

function makeDoc(model: SemanticModel | undefined): ChatDocument {
  return {
    id: "doc-1",
    username: "alice@example.com",
    sessionId: FIXTURE_SESSION,
    fileName: "sales.csv",
    lastUpdatedAt: 1_700_000_000_000,
    semanticModel: model,
  } as ChatDocument;
}

// ─── Admin-gate + parameter validation ───────────────────────────────

test("W61-delete-server · deleteSemanticModelEntry: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: "random@example.com",
        params: { sessionId: FIXTURE_SESSION, kind: "metric", name: "alpha" },
      }),
      res,
    );
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-delete-server · deleteSemanticModelEntry: 400 when sessionId is whitespace", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: "  ", kind: "metric", name: "alpha" },
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

test("W61-delete-server · deleteSemanticModelEntry: 400 when :kind is not in the literal union", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "foo", name: "alpha" },
      }),
      res,
    );
    assert.equal(res._status, 400);
    const body = res._body as { error: string; kind: string; allowed: string[] };
    assert.equal(body.error, "invalid_kind");
    assert.equal(body.kind, "foo");
    assert.deepEqual(body.allowed, ["metric", "dimension", "hierarchy"]);
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-delete-server · deleteSemanticModelEntry: 400 when :name is whitespace", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric", name: "   " },
      }),
      res,
    );
    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: "missing_entry_name" });
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 404 paths ────────────────────────────────────────────────────────

test("W61-delete-server · deleteSemanticModelEntry: 404 when session not found", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: "ghost", kind: "metric", name: "alpha" },
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "session_not_found",
      sessionId: "ghost",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-delete-server · deleteSemanticModelEntry: 404 when session has no semanticModel", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => makeDoc(undefined));
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric", name: "alpha" },
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

test("W61-delete-server · deleteSemanticModelEntry: 404 when the named metric doesn't exist", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel({ metrics: [makeMetric("alpha"), makeMetric("beta")] })),
  );
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "metric",
          name: "gamma",
        },
      }),
      res,
    );
    assert.equal(res._status, 404);
    assert.deepEqual(res._body, {
      error: "entry_not_found",
      sessionId: FIXTURE_SESSION,
      kind: "metric",
      name: "gamma",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-delete-server · deleteSemanticModelEntry: 404 when :kind is `dimension` but the name only exists as a metric (cross-kind no-fuzzy)", async () => {
  // Load-bearing: a metric named "alpha" must NOT be deleted by a
  // request that says :kind=dimension. The explicit kind in the URL
  // prevents accidental cross-kind deletes when name collisions exist.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel({ metrics: [makeMetric("alpha")] })),
  );
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "dimension",
          name: "alpha",
        },
      }),
      res,
    );
    assert.equal(res._status, 404);
    const body = res._body as { error: string; kind: string };
    assert.equal(body.error, "entry_not_found");
    assert.equal(body.kind, "dimension");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 200 success paths per kind ──────────────────────────────────────

test("W61-delete-server · deleteSemanticModelEntry: 200 deletes a metric and returns the W61-save envelope", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 3,
      metrics: [
        makeMetric("alpha", "user"),
        makeMetric("beta", "auto"),
        makeMetric("gamma", "domain"),
      ],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "metric",
          name: "beta",
        },
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
    assert.equal(body.model.version, 4, "version bumped 3 → 4");
    assert.equal(body.model.metrics.length, 2);
    assert.deepEqual(
      body.model.metrics.map((m) => m.name).sort(),
      ["alpha", "gamma"],
      "beta removed; alpha and gamma survive",
    );
    // Survivors' source preserved (delete doesn't bump unchanged entries).
    const alpha = body.model.metrics.find((m) => m.name === "alpha");
    const gamma = body.model.metrics.find((m) => m.name === "gamma");
    assert.equal(alpha?.source, "user", "alpha's source stays user");
    assert.equal(gamma?.source, "domain", "gamma's source stays domain");
    assert.equal(body.model.updatedBy, ADMIN_EMAIL);
    assert.ok(body.model.updatedAt, "updatedAt is set");
    assert.ok(body.lastUpdatedAt > 0, "lastUpdatedAt is positive");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-delete-server · deleteSemanticModelEntry: 200 deletes a dimension", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 1,
      metrics: [],
      dimensions: [makeDimension("region"), makeDimension("category")],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "dimension",
          name: "region",
        },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    assert.equal(body.model.dimensions.length, 1);
    assert.equal(body.model.dimensions[0].name, "category");
    assert.equal(body.model.version, 2);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-delete-server · deleteSemanticModelEntry: 200 deletes a hierarchy", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 5,
      metrics: [],
      dimensions: [],
      hierarchies: [makeHierarchy("geo"), makeHierarchy("product")],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "hierarchy",
          name: "geo",
        },
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    assert.equal(body.model.hierarchies.length, 1);
    assert.equal(body.model.hierarchies[0].name, "product");
    assert.equal(body.model.version, 6);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── Audit-log integration ───────────────────────────────────────────

test("W61-delete-server · deleteSemanticModelEntry: writes the prior model to the audit log", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  const priorMetrics = [makeMetric("alpha"), makeMetric("beta")];
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({ version: 7, metrics: priorMetrics }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "metric",
          name: "alpha",
        },
      }),
      res,
    );
    assert.equal(res._status, 200);
    // The persisted doc's audit log should now have one entry whose
    // priorModel is the pre-delete model (with both metrics intact).
    assert.ok(currentDoc, "doc persisted via updater");
    const log = currentDoc!.semanticModelAuditLog ?? [];
    assert.equal(log.length, 1, "exactly one audit entry written");
    assert.equal(log[0].priorVersion, 7);
    assert.equal(log[0].savedBy, ADMIN_EMAIL);
    assert.deepEqual(
      log[0].priorModel.metrics.map((m) => m.name).sort(),
      ["alpha", "beta"],
      "audit snapshot captures BOTH metrics (pre-delete state)",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-delete-server · deleteSemanticModelEntry: consecutive deletes grow the audit log monotonically", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 1,
      metrics: [
        makeMetric("alpha"),
        makeMetric("beta"),
        makeMetric("gamma"),
      ],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    // Delete alpha
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "metric",
          name: "alpha",
        },
      }),
      fakeRes(),
    );
    // Delete beta
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "metric",
          name: "beta",
        },
      }),
      fakeRes(),
    );
    assert.ok(currentDoc);
    assert.equal(currentDoc!.semanticModel?.version, 3, "version 1 → 2 → 3");
    assert.equal(currentDoc!.semanticModel?.metrics.length, 1);
    assert.equal(currentDoc!.semanticModel?.metrics[0].name, "gamma");
    const log = currentDoc!.semanticModelAuditLog ?? [];
    assert.equal(log.length, 2, "two audit entries newest-first");
    assert.equal(log[0].priorVersion, 2, "newest entry = post-alpha-delete model");
    assert.equal(log[1].priorVersion, 1, "oldest entry = original model");
    // Both snapshots' metrics counts read correctly: newest has 2 (post-alpha), oldest has 3.
    assert.equal(log[0].priorModel.metrics.length, 2);
    assert.equal(log[1].priorModel.metrics.length, 3);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 500 path ────────────────────────────────────────────────────────

test("W61-delete-server · deleteSemanticModelEntry: 500 when the fetcher throws", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    throw new Error("cosmos boom");
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = fakeRes();
    await deleteSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: {
          sessionId: FIXTURE_SESSION,
          kind: "metric",
          name: "alpha",
        },
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_delete_failed",
    });
  } finally {
    console.error = originalError;
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});
