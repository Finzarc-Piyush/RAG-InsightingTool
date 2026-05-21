/**
 * Wave W61-add-server · POST endpoint for appending a single new metric /
 * dimension / hierarchy to a session's semantic model.
 *
 *   POST /admin/semantic-models/:sessionId/entries/:kind
 *
 * Mirrors the W61-delete-server harness shape: a shared `currentDoc`
 * reference threaded between the fetcher stub and the updater stub
 * simulates persisting the audit log across consecutive operations.
 * The production Cosmos updater writes the field back transparently
 * because the ChatDocument blob is stored as raw JSON.
 *
 * Coverage focuses on: admin gate (403), parameter validation (400
 * across sessionId / kind / body schema), 404 paths (session / model
 * not found), 409 name_already_exists per kind, cross-kind name
 * collision IS allowed (metric "x" + dimension "x"), 200 success per
 * kind with W61-save envelope, audit-log integration (prior model
 * snapshot grows the buffer with the pre-add state), version
 * monotonicity, client-sent source preservation (admin importing from
 * a pack can send source: "domain" and it's preserved verbatim).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  addSemanticModelEntry,
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
  body?: unknown;
}): Request {
  return {
    headers: args.email ? { "x-user-email": args.email } : {},
    params: args.params ?? {},
    body: args.body ?? {},
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
    levels: ["region", "country"],
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

test("W61-add-server · addSemanticModelEntry: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: "random@example.com",
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("gamma"),
      }),
      res,
    );
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-add-server · addSemanticModelEntry: 400 when sessionId is whitespace", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: "  ", kind: "metric" },
        body: makeMetric("gamma"),
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

test("W61-add-server · addSemanticModelEntry: 400 when :kind is not in the literal union", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "foo" },
        body: makeMetric("gamma"),
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

test("W61-add-server · addSemanticModelEntry: 400 when body is missing a required field", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        // missing `expression` — required, no default
        body: { name: "gamma", label: "Gamma" },
      }),
      res,
    );
    assert.equal(res._status, 400);
    const body = res._body as {
      error: string;
      kind: string;
      issues: Array<{ path: string; message: string }>;
    };
    assert.equal(body.error, "invalid_entry");
    assert.equal(body.kind, "metric");
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
    assert.ok(
      body.issues.some((i) => i.path === "expression"),
      "issues include the missing expression field",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-add-server · addSemanticModelEntry: 400 when entry name is not snake_case", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: { ...makeMetric("alpha"), name: "Camel Case Bad" },
      }),
      res,
    );
    assert.equal(res._status, 400);
    const body = res._body as {
      error: string;
      issues: Array<{ path: string; message: string }>;
    };
    assert.equal(body.error, "invalid_entry");
    assert.ok(
      body.issues.some((i) => i.path === "name"),
      "snake_case regex violation surfaces under name",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 404 paths ────────────────────────────────────────────────────────

test("W61-add-server · addSemanticModelEntry: 404 when session not found", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => null);
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: "ghost", kind: "metric" },
        body: makeMetric("gamma"),
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

test("W61-add-server · addSemanticModelEntry: 404 when session has no semanticModel", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => makeDoc(undefined));
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("gamma"),
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

// ─── 409 name collisions ──────────────────────────────────────────────

test("W61-add-server · addSemanticModelEntry: 409 when adding a metric with a name that already exists as a metric", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel({ metrics: [makeMetric("alpha"), makeMetric("beta")] })),
  );
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("alpha"),
      }),
      res,
    );
    assert.equal(res._status, 409);
    assert.deepEqual(res._body, {
      error: "name_already_exists",
      sessionId: FIXTURE_SESSION,
      kind: "metric",
      name: "alpha",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-add-server · addSemanticModelEntry: 409 when adding a dimension that collides with an existing dimension", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel({ dimensions: [makeDimension("region")] })),
  );
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "dimension" },
        body: makeDimension("region"),
      }),
      res,
    );
    assert.equal(res._status, 409);
    const body = res._body as { error: string; kind: string; name: string };
    assert.equal(body.error, "name_already_exists");
    assert.equal(body.kind, "dimension");
    assert.equal(body.name, "region");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-add-server · addSemanticModelEntry: 409 when adding a hierarchy that collides with an existing hierarchy", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc(makeModel({ hierarchies: [makeHierarchy("geo")] })),
  );
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "hierarchy" },
        body: makeHierarchy("geo"),
      }),
      res,
    );
    assert.equal(res._status, 409);
    const body = res._body as { error: string; kind: string; name: string };
    assert.equal(body.error, "name_already_exists");
    assert.equal(body.kind, "hierarchy");
    assert.equal(body.name, "geo");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-add-server · addSemanticModelEntry: cross-kind name collisions ARE allowed (metric 'x' + dimension 'x' coexist)", async () => {
  // Load-bearing: a dimension named "revenue" must be addable even when
  // a metric named "revenue" exists. The kind in the URL scopes the
  // uniqueness check.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({ metrics: [makeMetric("revenue")] }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "dimension" },
        body: makeDimension("revenue"),
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    assert.equal(body.model.metrics.length, 1);
    assert.equal(body.model.metrics[0].name, "revenue");
    assert.equal(body.model.dimensions.length, 1);
    assert.equal(body.model.dimensions[0].name, "revenue");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 200 success paths per kind ──────────────────────────────────────

test("W61-add-server · addSemanticModelEntry: 200 adds a metric and returns the W61-save envelope", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 3,
      metrics: [makeMetric("alpha", "user"), makeMetric("beta", "auto")],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("gamma"),
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
    assert.equal(body.model.metrics.length, 3);
    assert.deepEqual(
      body.model.metrics.map((m) => m.name).sort(),
      ["alpha", "beta", "gamma"],
      "gamma appended; alpha and beta survive",
    );
    // Survivors' source preserved (add doesn't bump unchanged entries).
    const alpha = body.model.metrics.find((m) => m.name === "alpha");
    const beta = body.model.metrics.find((m) => m.name === "beta");
    assert.equal(alpha?.source, "user", "alpha's source stays user");
    assert.equal(beta?.source, "auto", "beta's source stays auto");
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

test("W61-add-server · addSemanticModelEntry: 200 adds a dimension", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 1,
      metrics: [],
      dimensions: [makeDimension("region")],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "dimension" },
        body: makeDimension("category"),
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    assert.equal(body.model.dimensions.length, 2);
    assert.deepEqual(
      body.model.dimensions.map((d) => d.name).sort(),
      ["category", "region"],
    );
    assert.equal(body.model.version, 2);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-add-server · addSemanticModelEntry: 200 adds a hierarchy", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({
      version: 5,
      metrics: [],
      dimensions: [],
      hierarchies: [makeHierarchy("geo")],
    }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "hierarchy" },
        body: makeHierarchy("product"),
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    assert.equal(body.model.hierarchies.length, 2);
    assert.deepEqual(
      body.model.hierarchies.map((h) => h.name).sort(),
      ["geo", "product"],
    );
    assert.equal(body.model.version, 6);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── Audit-log integration ───────────────────────────────────────────

test("W61-add-server · addSemanticModelEntry: writes the prior model to the audit log (snapshot is pre-add state)", async () => {
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
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("gamma"),
      }),
      res,
    );
    assert.equal(res._status, 200);
    assert.ok(currentDoc, "doc persisted via updater");
    const log = currentDoc!.semanticModelAuditLog ?? [];
    assert.equal(log.length, 1, "exactly one audit entry written");
    assert.equal(log[0].priorVersion, 7);
    assert.equal(log[0].savedBy, ADMIN_EMAIL);
    assert.deepEqual(
      log[0].priorModel.metrics.map((m) => m.name).sort(),
      ["alpha", "beta"],
      "audit snapshot captures the PRE-add model (no gamma)",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-add-server · addSemanticModelEntry: consecutive adds grow the audit log + version monotonically", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(
    makeModel({ version: 1, metrics: [makeMetric("alpha")] }),
  );
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    // Add beta
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("beta"),
      }),
      fakeRes(),
    );
    // Add gamma
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("gamma"),
      }),
      fakeRes(),
    );
    assert.ok(currentDoc);
    assert.equal(currentDoc!.semanticModel?.version, 3, "version 1 → 2 → 3");
    assert.equal(currentDoc!.semanticModel?.metrics.length, 3);
    const log = currentDoc!.semanticModelAuditLog ?? [];
    assert.equal(log.length, 2, "two audit entries newest-first");
    assert.equal(log[0].priorVersion, 2, "newest entry = post-beta-add model");
    assert.equal(log[1].priorVersion, 1, "oldest entry = pre-beta original");
    assert.equal(log[0].priorModel.metrics.length, 2, "newest snapshot: alpha + beta");
    assert.equal(log[1].priorModel.metrics.length, 1, "oldest snapshot: alpha only");
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── Source preservation ─────────────────────────────────────────────

test("W61-add-server · addSemanticModelEntry: client-sent source: 'domain' is preserved verbatim (pack-import flow)", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  let currentDoc: ChatDocument | null = makeDoc(makeModel({ metrics: [] }));
  __setSemanticModelDetailFetcherForTesting(async () => currentDoc);
  __setSemanticModelUpdaterForTesting(async (doc) => {
    currentDoc = doc;
    return doc;
  });
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("gamma", "domain"),
      }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as { model: SemanticModel };
    const gamma = body.model.metrics.find((m) => m.name === "gamma");
    assert.equal(
      gamma?.source,
      "domain",
      "client-sent 'domain' source preserved, not overridden to 'user'",
    );
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    __setSemanticModelUpdaterForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

// ─── 500 path ────────────────────────────────────────────────────────

test("W61-add-server · addSemanticModelEntry: 500 when the fetcher throws", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () => {
    throw new Error("cosmos boom");
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = fakeRes();
    await addSemanticModelEntry(
      fakeReq({
        email: ADMIN_EMAIL,
        params: { sessionId: FIXTURE_SESSION, kind: "metric" },
        body: makeMetric("gamma"),
      }),
      res,
    );
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_add_failed",
    });
  } finally {
    console.error = originalError;
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});
