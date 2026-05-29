// Wave W-UD9 · pins the GET + DELETE directives endpoints' validation
// behaviour and the model integration.
//
// We test the deterministic error paths through the controller directly
// (no chat-doc fixture needed) and verify the model integration via the
// existing in-memory Cosmos stub on `datasetDirectives.model.ts`. The
// happy-path is exercised end-to-end in the model layer (see
// `datasetDirectivesModel.test.ts`).

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import type { Request, Response } from "express";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const {
  getSessionDirectivesEndpoint,
  revokeSessionDirectiveEndpoint,
} = await import("../controllers/sessionController.js");
const datasetDirectivesModel = await import(
  "../models/datasetDirectives.model.js"
);

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (n: number) => MockRes;
  json: (b: unknown) => MockRes;
}

function makeRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: undefined,
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return r;
}

function makeReq(opts: {
  email?: string;
  sessionId?: string;
  directiveId?: string;
}): Request {
  return {
    auth: opts.email ? { email: opts.email } : undefined,
    params: {
      sessionId: opts.sessionId ?? "",
      directiveId: opts.directiveId ?? "",
    },
    headers: {},
  } as unknown as Request;
}

afterEach(() => {
  datasetDirectivesModel.__setContainerForTesting(null);
});

describe("W-UD9 · GET /api/session/:sessionId/directives — validation", () => {
  it("400 when sessionId is missing from the path", async () => {
    const req = makeReq({ email: "u@x.com" });
    const res = makeRes();
    await getSessionDirectivesEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Session ID is required/);
  });

  it("401 when no authenticated user", async () => {
    const req = makeReq({ sessionId: "s1" });
    const res = makeRes();
    await getSessionDirectivesEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 401);
  });
});

describe("W-UD9 · DELETE /api/session/:sessionId/directives/:directiveId — validation", () => {
  it("400 when sessionId or directiveId missing", async () => {
    const req = makeReq({ email: "u@x.com", sessionId: "s1" });
    const res = makeRes();
    await revokeSessionDirectiveEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.match(
      JSON.stringify(res.body),
      /Session ID and directive ID are required/
    );
  });

  it("401 when no authenticated user", async () => {
    const req = makeReq({ sessionId: "s1", directiveId: "d1" });
    const res = makeRes();
    await revokeSessionDirectiveEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 401);
  });
});

describe("W-UD9 · model integration — revokeDirective is what the endpoint dispatches to", () => {
  const USER = "tida@example.com";
  const FINGERPRINT = "fp_test_directives";

  function makeContainerStub() {
    const store = new Map<string, any>();
    return {
      store,
      item: (id: string, _pk: string) => ({
        async read<T>() {
          return { resource: (store.get(id) as T | undefined) ?? undefined };
        },
      }),
      items: {
        async upsert(doc: any) {
          store.set(doc.id, doc);
          return { resource: doc };
        },
      },
    };
  }

  it("revokeDirective transitions status to 'revoked' and preserves audit", async () => {
    const stub = makeContainerStub();
    datasetDirectivesModel.__setContainerForTesting(stub as any);
    const { directive } = await datasetDirectivesModel.appendDirective(
      USER,
      FINGERPRINT,
      {
        scope: "dataset",
        kind: "exclude",
        text: "omit Pure Sense from brand breakdown",
        structured: { column: "Brand", op: "not_in", values: ["Pure Sense"] },
        source: "chat-message",
      }
    );
    const updated = await datasetDirectivesModel.revokeDirective(
      USER,
      FINGERPRINT,
      directive.id
    );
    assert.ok(updated);
    assert.equal(updated!.directives.length, 1);
    assert.equal(updated!.directives[0]!.status, "revoked");
    // Active list excludes it.
    const active = await datasetDirectivesModel.listActiveDirectives(
      USER,
      FINGERPRINT
    );
    assert.equal(active.length, 0);
  });

  it("revokeDirective returns null for an unknown id (controller forwards 404)", async () => {
    const stub = makeContainerStub();
    datasetDirectivesModel.__setContainerForTesting(stub as any);
    const updated = await datasetDirectivesModel.revokeDirective(
      USER,
      FINGERPRINT,
      "no-such-id"
    );
    assert.equal(updated, null);
  });
});
