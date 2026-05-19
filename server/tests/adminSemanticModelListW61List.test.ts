/**
 * Wave W61-list · admin semantic-model index endpoint + projection.
 *
 * Covers three layers:
 *   1. Pure projection — `finalizeAdminSemanticModelEntry` coerces raw
 *      Cosmos responses into the typed `AdminSemanticModelListEntry`
 *      with the right defaults when fields are missing.
 *   2. Cosmos query shape — `ADMIN_SEMANTIC_MODEL_LIST_SELECT` mentions
 *      every projected field, sorts by `c.lastUpdatedAt DESC`, and
 *      gates with `WHERE IS_DEFINED(c.semanticModel)` so pre-W57
 *      sessions don't pollute the list.
 *   3. Controller wiring — `listSemanticModels` honours the admin gate
 *      (403 for non-admin), routes through the injectable lister
 *      (200 envelope shape + ordering), and surfaces internal errors
 *      as 500.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  ADMIN_SEMANTIC_MODEL_LIST_SELECT,
  finalizeAdminSemanticModelEntry,
  type AdminSemanticModelListEntry,
} from "../models/chat.model.js";
import {
  listSemanticModels,
  __setSemanticModelListerForTesting,
} from "../controllers/adminSemanticModelController.js";
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

function fakeReq(email?: string): Request {
  return {
    headers: email ? { "x-user-email": email } : {},
    params: {},
    body: {},
    auth: undefined,
  } as unknown as Request;
}

const FIXTURE_ENTRY: AdminSemanticModelListEntry = {
  id: "doc-1",
  username: "alice@example.com",
  fileName: "sales.csv",
  sessionId: "sess-1",
  lastUpdatedAt: 1_700_000_000_000,
  version: 2,
  modelName: "Sales semantic model",
  modelUpdatedAt: "2026-05-15T12:00:00.000Z",
  modelUpdatedBy: "alice@example.com",
  metricsCount: 8,
  dimensionsCount: 4,
  hierarchiesCount: 1,
};

// ────────────────────────────────────────────────────────────────────
// (1) Pure projection finaliser
// ────────────────────────────────────────────────────────────────────

test("W61-list · finalizeAdminSemanticModelEntry: maps a complete raw row", () => {
  const raw: Record<string, unknown> = {
    id: "doc-7",
    username: "bob@example.com",
    fileName: "marketing.xlsx",
    sessionId: "sess-7",
    lastUpdatedAt: 1_700_000_000_000,
    version: 3,
    modelName: "Marketing model",
    modelUpdatedAt: "2026-05-19T09:30:00.000Z",
    modelUpdatedBy: "bob@example.com",
    metricsCount: 12,
    dimensionsCount: 5,
    hierarchiesCount: 2,
  };
  const entry = finalizeAdminSemanticModelEntry(raw);
  assert.equal(entry.id, "doc-7");
  assert.equal(entry.username, "bob@example.com");
  assert.equal(entry.fileName, "marketing.xlsx");
  assert.equal(entry.sessionId, "sess-7");
  assert.equal(entry.lastUpdatedAt, 1_700_000_000_000);
  assert.equal(entry.version, 3);
  assert.equal(entry.modelName, "Marketing model");
  assert.equal(entry.modelUpdatedAt, "2026-05-19T09:30:00.000Z");
  assert.equal(entry.modelUpdatedBy, "bob@example.com");
  assert.equal(entry.metricsCount, 12);
  assert.equal(entry.dimensionsCount, 5);
  assert.equal(entry.hierarchiesCount, 2);
});

test("W61-list · finalizeAdminSemanticModelEntry: applies defaults when fields are missing", () => {
  const entry = finalizeAdminSemanticModelEntry({});
  assert.equal(entry.id, "");
  assert.equal(entry.username, "");
  assert.equal(entry.fileName, "");
  assert.equal(entry.sessionId, "");
  assert.equal(entry.lastUpdatedAt, 0);
  assert.equal(entry.version, 1, "defaults to v1 like semanticModelSchema");
  assert.equal(
    entry.modelName,
    "Default model",
    "defaults to the schema's default name",
  );
  assert.equal(entry.modelUpdatedAt, undefined);
  assert.equal(entry.modelUpdatedBy, undefined);
  assert.equal(entry.metricsCount, 0);
  assert.equal(entry.dimensionsCount, 0);
  assert.equal(entry.hierarchiesCount, 0);
});

test("W61-list · finalizeAdminSemanticModelEntry: drops non-string optional metadata", () => {
  const entry = finalizeAdminSemanticModelEntry({
    modelUpdatedAt: 12345 as unknown,
    modelUpdatedBy: { not: "a string" } as unknown,
  });
  assert.equal(entry.modelUpdatedAt, undefined);
  assert.equal(entry.modelUpdatedBy, undefined);
});

test("W61-list · finalizeAdminSemanticModelEntry: coerces number-ish counts via Number()", () => {
  const entry = finalizeAdminSemanticModelEntry({
    metricsCount: "42",
    dimensionsCount: "0",
    hierarchiesCount: null,
  });
  assert.equal(entry.metricsCount, 42);
  assert.equal(entry.dimensionsCount, 0);
  assert.equal(entry.hierarchiesCount, 0);
});

// ────────────────────────────────────────────────────────────────────
// (2) Cosmos SELECT shape
// ────────────────────────────────────────────────────────────────────

test("W61-list · ADMIN_SEMANTIC_MODEL_LIST_SELECT: projects every typed field", () => {
  const sql = ADMIN_SEMANTIC_MODEL_LIST_SELECT;
  for (const field of [
    "c.id",
    "c.username",
    "c.fileName",
    "c.sessionId",
    "c.lastUpdatedAt",
    "c.semanticModel.version",
    "c.semanticModel.name",
    "c.semanticModel.updatedAt",
    "c.semanticModel.updatedBy",
    "c.semanticModel.metrics",
    "c.semanticModel.dimensions",
    "c.semanticModel.hierarchies",
  ]) {
    assert.ok(sql.includes(field), `SELECT must reference ${field}`);
  }
});

test("W61-list · ADMIN_SEMANTIC_MODEL_LIST_SELECT: defensive ARRAY_LENGTH wrapping", () => {
  const sql = ADMIN_SEMANTIC_MODEL_LIST_SELECT;
  // The IIF + IS_ARRAY + ARRAY_LENGTH triple keeps a legacy doc with a
  // missing array from returning `undefined` for the count.
  for (const arr of ["metrics", "dimensions", "hierarchies"]) {
    const pattern = new RegExp(
      `IIF\\(IS_DEFINED\\(c\\.semanticModel\\.${arr}\\)\\s+AND\\s+IS_ARRAY\\(c\\.semanticModel\\.${arr}\\),\\s+ARRAY_LENGTH\\(c\\.semanticModel\\.${arr}\\),\\s+0\\)`,
    );
    assert.match(sql, pattern, `${arr} must be defensively wrapped`);
  }
});

test("W61-list · ADMIN_SEMANTIC_MODEL_LIST_SELECT: filters pre-W57 sessions + orders newest first", () => {
  const sql = ADMIN_SEMANTIC_MODEL_LIST_SELECT;
  assert.match(sql, /WHERE\s+IS_DEFINED\(c\.semanticModel\)/);
  assert.match(sql, /ORDER\s+BY\s+c\.lastUpdatedAt\s+DESC/);
});

// ────────────────────────────────────────────────────────────────────
// (3) Controller wiring
// ────────────────────────────────────────────────────────────────────

test("W61-list · listSemanticModels: 403 for non-admin callers", async () => {
  __resetSuperadminEmailsForTesting();
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await listSemanticModels(fakeReq("random@example.com"), res);
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-list · listSemanticModels: 200 envelope shape for admin", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelListerForTesting(async () => [FIXTURE_ENTRY]);
  try {
    const res = fakeRes();
    await listSemanticModels(fakeReq("admin@example.com"), res);
    assert.equal(res._status, 200);
    const body = res._body as {
      generatedAt: number;
      sessions: AdminSemanticModelListEntry[];
    };
    assert.ok(typeof body.generatedAt === "number");
    assert.ok(body.generatedAt > 0);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].sessionId, "sess-1");
    assert.equal(body.sessions[0].modelName, "Sales semantic model");
    assert.equal(body.sessions[0].metricsCount, 8);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelListerForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-list · listSemanticModels: empty list yields { sessions: [] }, NOT a 404", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelListerForTesting(async () => []);
  try {
    const res = fakeRes();
    await listSemanticModels(fakeReq("admin@example.com"), res);
    assert.equal(res._status, 200);
    const body = res._body as { sessions: AdminSemanticModelListEntry[] };
    assert.deepEqual(body.sessions, []);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelListerForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-list · listSemanticModels: 500 when the lister throws", async () => {
  __setSuperadminEmailsForTesting(["admin@example.com"]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelListerForTesting(async () => {
    throw new Error("cosmos unavailable");
  });
  try {
    const res = fakeRes();
    await listSemanticModels(fakeReq("admin@example.com"), res);
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, {
      error: "admin_semantic_model_list_failed",
    });
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelListerForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-list · __setSemanticModelListerForTesting(null) restores the production lister", async () => {
  // We can't call the production Cosmos query in tests, but the
  // restoration shouldn't throw at the swap step.
  assert.doesNotThrow(() => {
    __setSemanticModelListerForTesting(async () => []);
    __setSemanticModelListerForTesting(null);
  });
});
