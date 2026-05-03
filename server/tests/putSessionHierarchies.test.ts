import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { putSessionHierarchiesEndpoint } = await import(
  "../controllers/sessionController.js"
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
  body?: unknown;
}): Request {
  return {
    auth: opts.email ? { email: opts.email } : undefined,
    params: { sessionId: opts.sessionId ?? "" },
    body: opts.body ?? {},
    headers: {},
  } as unknown as Request;
}

describe("EU1 · putSessionHierarchiesEndpoint validation", () => {
  it("400 when sessionId param is missing", async () => {
    const req = makeReq({ email: "u@x.com", body: { hierarchies: [] } });
    const res = makeRes();
    await putSessionHierarchiesEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Session ID is required/);
  });

  it("401 when no authenticated user", async () => {
    const req = makeReq({ sessionId: "s1", body: { hierarchies: [] } });
    const res = makeRes();
    await putSessionHierarchiesEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 401);
  });

  it("400 when body is missing hierarchies", async () => {
    const req = makeReq({
      email: "u@x.com",
      sessionId: "s1",
      body: { other: 123 },
    });
    const res = makeRes();
    await putSessionHierarchiesEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /Invalid hierarchies payload/);
  });

  it("400 when a hierarchy entry has empty rollupValue", async () => {
    const req = makeReq({
      email: "u@x.com",
      sessionId: "s1",
      body: {
        hierarchies: [
          { column: "Products", rollupValue: "", source: "user" },
        ],
      },
    });
    const res = makeRes();
    await putSessionHierarchiesEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
  });

  it("400 when more than 20 hierarchies are submitted", async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      column: `Col${i}`,
      rollupValue: `Rollup${i}`,
      source: "user" as const,
    }));
    const req = makeReq({
      email: "u@x.com",
      sessionId: "s1",
      body: { hierarchies: tooMany },
    });
    const res = makeRes();
    await putSessionHierarchiesEndpoint(req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
  });

  it("accepts a well-formed empty array (= remove all)", async () => {
    const req = makeReq({
      email: "u@x.com",
      sessionId: "s1",
      body: { hierarchies: [] },
    });
    const res = makeRes();
    // Will reach updateSessionDimensionHierarchies → Cosmos lookup → returns
    // undefined (no doc in test env), so endpoint replies 404. Validation
    // passed (which is the assertion here).
    await putSessionHierarchiesEndpoint(req, res as unknown as Response);
    assert.ok(
      res.statusCode === 404 || res.statusCode === 503,
      `expected 404 or 503, got ${res.statusCode}`
    );
  });
});
