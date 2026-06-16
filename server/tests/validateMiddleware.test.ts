/**
 * Wave API-8 · `validate()` zod middleware.
 *
 * Asserts the three behaviours of the reusable validation middleware:
 *   1. A request whose body fails the schema → 400 with `{ error, details }`
 *      and `next()` NOT called.
 *   2. A valid body → `next()` called, no response written, and the parsed
 *      (coerced) value assigned back onto `req.body`.
 *   3. An omitted schema part (e.g. no `query` schema) → passthrough: the
 *      original value is untouched and `next()` is called.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.js";

interface FakeRes {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

describe("validate() middleware", () => {
  it("responds 400 with details when the body is invalid", () => {
    const mw = validate({ body: z.object({ name: z.string() }) });
    const req = { body: { name: 123 } } as unknown as Request;
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    mw(req, res as unknown as Response, next);

    assert.equal(res.statusCode, 400);
    assert.equal(nextCalled, false);
    const body = res.body as { error: string; details: unknown };
    assert.equal(body.error, "Invalid request");
    assert.ok(body.details, "details should be present (zodError.flatten())");
  });

  it("calls next() and assigns parsed value when the body is valid", () => {
    const mw = validate({
      body: z.object({ count: z.coerce.number() }),
    });
    const req = { body: { count: "7" } } as unknown as Request;
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    mw(req, res as unknown as Response, next);

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null, "no response should be written");
    // Coercion proves the PARSED value was assigned back.
    assert.deepEqual(req.body, { count: 7 });
  });

  it("passes through when a schema part is omitted", () => {
    const mw = validate({}); // no body/query/params schemas
    const originalQuery = { keep: "me" };
    const req = { query: originalQuery } as unknown as Request;
    const res = makeRes();
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    mw(req, res as unknown as Response, next);

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
    assert.equal(req.query, originalQuery, "untouched when no schema given");
  });
});
