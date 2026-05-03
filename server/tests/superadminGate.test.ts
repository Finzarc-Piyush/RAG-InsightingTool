import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import { isSuperadminEmail, isSuperadminRequest } from "../lib/superadmin.js";
import {
  superadminMeEndpoint,
  requireSuperadmin,
} from "../controllers/superadminController.js";

/**
 * Superadmin allowlist + gate behaviour. Pure logic — does NOT reach Cosmos.
 * The hardcoded list is asserted explicitly so an accidental rotation in
 * `server/lib/superadmin.ts` shows up as a test failure.
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

function makeReq(opts: { email?: string }): Request {
  return {
    auth: opts.email ? { email: opts.email } : undefined,
    body: {},
    headers: {},
    params: {},
  } as unknown as Request;
}

describe("superadmin · allowlist", () => {
  it("matches the two hardcoded emails", () => {
    assert.strictEqual(isSuperadminEmail("piyush@finzarc.com"), true);
    assert.strictEqual(isSuperadminEmail("piyush.kumar@finzarc.com"), true);
  });

  it("normalizes case and whitespace", () => {
    assert.strictEqual(isSuperadminEmail("  Piyush@FinZarc.com "), true);
    assert.strictEqual(isSuperadminEmail("PIYUSH.KUMAR@FINZARC.COM"), true);
  });

  it("rejects non-allowlist emails", () => {
    assert.strictEqual(isSuperadminEmail("alice@finzarc.com"), false);
    assert.strictEqual(isSuperadminEmail("piyush@example.com"), false);
    assert.strictEqual(isSuperadminEmail(""), false);
    assert.strictEqual(isSuperadminEmail(undefined), false);
    assert.strictEqual(isSuperadminEmail(null), false);
  });

  it("isSuperadminRequest reads req.auth.email", () => {
    assert.strictEqual(
      isSuperadminRequest(makeReq({ email: "piyush@finzarc.com" })),
      true
    );
    assert.strictEqual(
      isSuperadminRequest(makeReq({ email: "alice@finzarc.com" })),
      false
    );
    assert.strictEqual(isSuperadminRequest(makeReq({})), false);
  });
});

describe("superadmin · /me endpoint", () => {
  it("returns isSuperadmin: true for an allowlisted email", async () => {
    const req = makeReq({ email: "piyush@finzarc.com" });
    const res = makeRes();
    await superadminMeEndpoint(req, res as unknown as Response);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      isSuperadmin: true,
      email: "piyush@finzarc.com",
    });
  });

  it("returns isSuperadmin: false for a non-allowlist email (still 200)", async () => {
    const req = makeReq({ email: "alice@finzarc.com" });
    const res = makeRes();
    await superadminMeEndpoint(req, res as unknown as Response);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      isSuperadmin: false,
      email: "alice@finzarc.com",
    });
  });
});

describe("superadmin · requireSuperadmin middleware", () => {
  it("403s when caller is not on the allowlist", () => {
    const req = makeReq({ email: "alice@finzarc.com" });
    const res = makeRes();
    let nextCalled = false;
    requireSuperadmin(req, res as unknown as Response, () => {
      nextCalled = true;
    });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: "superadmin_required" });
    assert.strictEqual(nextCalled, false);
  });

  it("calls next() for an allowlisted caller", () => {
    const req = makeReq({ email: "piyush.kumar@finzarc.com" });
    const res = makeRes();
    let nextCalled = false;
    requireSuperadmin(req, res as unknown as Response, () => {
      nextCalled = true;
    });
    assert.strictEqual(res.statusCode, 200); // untouched
    assert.strictEqual(nextCalled, true);
  });
});
