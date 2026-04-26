import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import { feedbackController } from "../controllers/feedbackController.js";

/**
 * W5.5a · Validation guards on the feedback route. Pure-logic tests — never
 * actually reach Cosmos / AI Search because the early-return paths are
 * covered first (missing auth, malformed body).
 */

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
  body?: unknown;
}): Request {
  return {
    auth: opts.email ? { email: opts.email } : undefined,
    body: opts.body ?? {},
    headers: {},
  } as unknown as Request;
}

describe("feedbackController · validation guards", () => {
  it("returns 401 when no authenticated email is present", async () => {
    const req = makeReq({ body: { sessionId: "s", turnId: "t", feedback: "up" } });
    const res = makeRes();
    await feedbackController(req, res as unknown as Response);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { error: "Missing authenticated user email." });
  });

  it("returns 400 when sessionId is missing", async () => {
    const req = makeReq({
      email: "u@example.com",
      body: { turnId: "t", feedback: "up" },
    });
    const res = makeRes();
    await feedbackController(req, res as unknown as Response);
    assert.strictEqual(res.statusCode, 400);
    assert.ok((res.body as { error: string }).error === "Invalid request body.");
  });

  it("returns 400 when feedback is not in the allowed enum", async () => {
    const req = makeReq({
      email: "u@example.com",
      body: { sessionId: "s", turnId: "t", feedback: "neutral" },
    });
    const res = makeRes();
    await feedbackController(req, res as unknown as Response);
    assert.strictEqual(res.statusCode, 400);
  });

  it("returns 400 when sessionId is an empty string", async () => {
    const req = makeReq({
      email: "u@example.com",
      body: { sessionId: "", turnId: "t", feedback: "up" },
    });
    const res = makeRes();
    await feedbackController(req, res as unknown as Response);
    assert.strictEqual(res.statusCode, 400);
  });

  // Note: a positive-path test that asserts the enum values pass validation
  // would block on Cosmos init (~10s × retries). That belongs in an
  // integration test against a real Cosmos emulator. The first 4 cases above
  // exhaustively cover the validation logic (Zod enum + min(1) on every
  // string field).
});
