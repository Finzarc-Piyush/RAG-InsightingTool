/**
 * Wave W61-detail-schema · server-only foundation wave that widens the
 * `GET /admin/semantic-models/:sessionId` detail-endpoint envelope with
 * a `datasetSchema: { columns: { name, type }[] } | null` field
 * projected from `doc.dataSummary?.columns`. Unblocks the upcoming
 * client waves W61-edit-column (column-picker for SemanticDimension)
 * and W61-edit-references (tag-input for SemanticMetric.references[]),
 * both of which need the live column inventory to populate the picker
 * and validate user input.
 *
 * Pairs with `adminSemanticModelDetailW61Detail.test.ts` (existing —
 * pins the admin gate, 404 paths, 500 propagation, and the
 * pre-widening 200-envelope shape; that file's 200 assertion was
 * updated in-place to also pin `datasetSchema === null` on the
 * dataSummary-absent fixture). This file pins the wave-specific
 * behaviours: the projection shape, the populated-vs-null branches,
 * defensive guards on malformed dataSummary state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  getSemanticModel,
  projectDatasetSchema,
  __setSemanticModelDetailFetcherForTesting,
  type AdminSemanticModelDetailResponse,
  type AdminSemanticModelDatasetSchema,
} from "../controllers/adminSemanticModelController.js";
import type { ChatDocument } from "../models/chat.model.js";
import type {
  DataSummary,
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

const FIXTURE_MODEL: SemanticModel = {
  version: 1,
  name: "Sales semantic model",
  metrics: [],
  dimensions: [],
  hierarchies: [],
};

const ADMIN_EMAIL = "admin@example.com";

function makeColumn(
  name: string,
  type: string,
  extras: Record<string, unknown> = {},
) {
  return {
    name,
    type,
    sampleValues: ["alpha", "beta"],
    ...extras,
  };
}

function makeDataSummary(
  columns: ReturnType<typeof makeColumn>[],
  extras: Partial<DataSummary> = {},
): DataSummary {
  return {
    rowCount: 1000,
    columnCount: columns.length,
    columns,
    numericColumns: [],
    dateColumns: [],
    ...extras,
  } as DataSummary;
}

function makeDoc(args: {
  dataSummary?: DataSummary | undefined;
  sessionId?: string;
} = {}): ChatDocument {
  return {
    id: "doc-1",
    username: "alice@example.com",
    sessionId: args.sessionId ?? "sess-1",
    fileName: "sales.csv",
    lastUpdatedAt: 1_700_000_000_000,
    semanticModel: FIXTURE_MODEL,
    dataSummary: args.dataSummary,
  } as ChatDocument;
}

// ─── projectDatasetSchema pure-fn coverage ───────────────────────────

test("W61-detail-schema · projectDatasetSchema returns null when dataSummary is undefined", () => {
  const result = projectDatasetSchema({} as ChatDocument);
  assert.equal(result, null);
});

test("W61-detail-schema · projectDatasetSchema returns null when dataSummary.columns is empty", () => {
  const doc = makeDoc({ dataSummary: makeDataSummary([]) });
  const result = projectDatasetSchema(doc);
  assert.equal(result, null);
});

test("W61-detail-schema · projectDatasetSchema returns name + type pairs from a populated dataSummary", () => {
  const doc = makeDoc({
    dataSummary: makeDataSummary([
      makeColumn("region", "string"),
      makeColumn("sales_amount", "number"),
      makeColumn("order_date", "date"),
    ]),
  });
  const result = projectDatasetSchema(doc);
  assert.ok(result, "expected non-null projection");
  assert.equal(result.columns.length, 3);
  assert.deepEqual(result.columns, [
    { name: "region", type: "string" },
    { name: "sales_amount", type: "number" },
    { name: "order_date", type: "date" },
  ]);
});

test("W61-detail-schema · projectDatasetSchema strips DataSummary.column fields beyond name + type (privacy + payload size)", () => {
  // Load-bearing: the wire projection must NOT include sampleValues
  // (sample data could be sensitive), topValues (low-cardinality
  // categorical samples), or dateRange (cheap-but-large per-column
  // metadata). A future widening that adds those fields would
  // re-bloat the envelope; this test pins the deliberate slimness.
  const doc = makeDoc({
    dataSummary: makeDataSummary([
      makeColumn("region", "string", {
        topValues: [{ value: "APAC", count: 50 }],
        temporalDisplayGrain: "day",
        dateRange: {
          minIso: "2025-01-01",
          maxIso: "2025-12-31",
          distinctDayCount: 365,
          spanDays: 365,
        },
      }),
    ]),
  });
  const result = projectDatasetSchema(doc);
  assert.ok(result);
  assert.equal(result.columns.length, 1);
  const col = result.columns[0];
  assert.deepEqual(Object.keys(col).sort(), ["name", "type"]);
  // Strict deepEqual against the documented projection shape — a
  // regression that adds e.g. sampleValues would fail here.
  assert.deepEqual(col, { name: "region", type: "string" });
});

test("W61-detail-schema · projectDatasetSchema preserves column ORDER from the source array", () => {
  // The client picker UI presents columns in array order; preserving
  // the dataSummary's order (which is the upload-time CSV column
  // order) keeps the picker scan-stable across sessions.
  const doc = makeDoc({
    dataSummary: makeDataSummary([
      makeColumn("z_last", "string"),
      makeColumn("a_first", "string"),
      makeColumn("m_middle", "string"),
    ]),
  });
  const result = projectDatasetSchema(doc);
  assert.ok(result);
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ["z_last", "a_first", "m_middle"],
    "projection must preserve source-array order (no sort)",
  );
});

// ─── Controller integration coverage ─────────────────────────────────

test("W61-detail-schema · getSemanticModel: 200 envelope includes datasetSchema populated from doc.dataSummary.columns", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  const doc = makeDoc({
    dataSummary: makeDataSummary([
      makeColumn("region", "string"),
      makeColumn("sales_amount", "number"),
      makeColumn("order_date", "date"),
    ]),
  });
  __setSemanticModelDetailFetcherForTesting(async () => doc);
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({ email: ADMIN_EMAIL, params: { sessionId: "sess-1" } }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelDetailResponse;
    assert.ok(body.datasetSchema, "expected populated datasetSchema");
    assert.equal(body.datasetSchema.columns.length, 3);
    assert.deepEqual(body.datasetSchema.columns, [
      { name: "region", type: "string" },
      { name: "sales_amount", type: "number" },
      { name: "order_date", type: "date" },
    ]);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail-schema · getSemanticModel: 200 envelope datasetSchema is null when doc has no dataSummary (legacy doc)", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ dataSummary: undefined }),
  );
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({ email: ADMIN_EMAIL, params: { sessionId: "sess-1" } }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelDetailResponse;
    assert.equal(body.datasetSchema, null);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail-schema · getSemanticModel: 200 envelope datasetSchema is null when dataSummary.columns is empty array", async () => {
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ dataSummary: makeDataSummary([]) }),
  );
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({ email: ADMIN_EMAIL, params: { sessionId: "sess-1" } }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelDetailResponse;
    assert.equal(body.datasetSchema, null);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail-schema · getSemanticModel: datasetSchema field is present in 200 envelope (not undefined-stripped on JSON.stringify)", async () => {
  // Load-bearing: `null` JSON-serialises distinctly from `undefined`
  // (undefined fields get stripped). The client's `body.datasetSchema`
  // check needs to distinguish "no schema available" (null) from
  // "field missing on a stale-server response" (undefined → typo /
  // server-version mismatch). This test asserts the field key
  // appears in the body even when its value is null.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  __setSemanticModelDetailFetcherForTesting(async () =>
    makeDoc({ dataSummary: undefined }),
  );
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({ email: ADMIN_EMAIL, params: { sessionId: "sess-1" } }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelDetailResponse;
    assert.ok(
      "datasetSchema" in body,
      "envelope must include the datasetSchema key even when null",
    );
    // Round-trip through JSON to mimic the over-the-wire shape; null
    // must survive but undefined would be stripped.
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    assert.ok(
      "datasetSchema" in wire,
      "datasetSchema must JSON-serialise (not be stripped as undefined)",
    );
    assert.equal(wire.datasetSchema, null);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail-schema · getSemanticModel: datasetSchema is unaffected by the semantic-model's own state (model + schema are independent)", async () => {
  // Pinned to surface a regression where the schema projection
  // accidentally reads from `doc.semanticModel` instead of
  // `doc.dataSummary`. The dataset columns and the semantic-model
  // entries are independent: a session can have 10 dataset columns
  // and a semantic model with 30 metrics, none of which directly
  // correspond to the columns.
  __setSuperadminEmailsForTesting([ADMIN_EMAIL]);
  process.env.DISABLE_AUTH = "true";
  const doc = makeDoc({
    dataSummary: makeDataSummary([
      makeColumn("only_column", "string"),
    ]),
  });
  // Override semanticModel to be much richer than the dataset.
  doc.semanticModel = {
    ...FIXTURE_MODEL,
    metrics: Array.from({ length: 5 }, (_, i) => ({
      name: `metric_${i}`,
      label: `Metric ${i}`,
      expression: `SUM(field_${i})`,
      format: "number" as const,
      references: [`field_${i}`],
      exposed: true,
      source: "auto" as const,
    })),
  };
  __setSemanticModelDetailFetcherForTesting(async () => doc);
  try {
    const res = fakeRes();
    await getSemanticModel(
      fakeReq({ email: ADMIN_EMAIL, params: { sessionId: "sess-1" } }),
      res,
    );
    assert.equal(res._status, 200);
    const body = res._body as AdminSemanticModelDetailResponse;
    assert.ok(body.datasetSchema, "datasetSchema must be populated");
    assert.equal(body.datasetSchema.columns.length, 1);
    assert.equal(body.datasetSchema.columns[0].name, "only_column");
    // The model has 5 metrics; the schema has 1 column. The two are
    // independent.
    assert.equal(body.model.metrics.length, 5);
  } finally {
    __resetSuperadminEmailsForTesting();
    __setSemanticModelDetailFetcherForTesting(null);
    delete process.env.DISABLE_AUTH;
  }
});

test("W61-detail-schema · AdminSemanticModelDatasetSchema interface shape is stable (TS-level pin via inline cast)", () => {
  // TS-level pin: if a future widening changes `columns` from an
  // array-of-objects to e.g. a `Record<name, type>`, this construct
  // would fail to type-check. The assignment is the contract.
  const schema: AdminSemanticModelDatasetSchema = {
    columns: [
      { name: "alpha", type: "string" },
      { name: "beta", type: "number" },
    ],
  };
  assert.equal(schema.columns.length, 2);
  assert.equal(schema.columns[0].name, "alpha");
  assert.equal(schema.columns[1].type, "number");
});
