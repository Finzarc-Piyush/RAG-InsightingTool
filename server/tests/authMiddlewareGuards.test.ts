import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { requireAzureAdAuth } from "../middleware/azureAdAuth.js";

/**
 * EX6 / TEST-3 + SEC-3 regression — the Azure AD auth middleware had ZERO tests
 * despite being the single gate in front of every /api route. These pin the
 * branch matrix, with emphasis on the DISABLE_AUTH dev-bypass being FAIL-CLOSED:
 *   - honoured only when NODE_ENV is explicitly development/test (never unset),
 *   - requires AUTH_BYPASS_DEV_TOKEN to be set (mandatory sentinel),
 *   - requires the matching X-Auth-Bypass-Dev-Token header,
 *   - requires X-User-Email.
 * Before SEC-3, an operator who set DISABLE_AUTH=true but left the sentinel
 * unset would have the server trust an attacker-supplied X-User-Email header.
 */

const ENV_KEYS = [
  "DISABLE_AUTH",
  "NODE_ENV",
  "VERCEL",
  "AUTH_BYPASS_DEV_TOKEN",
  "AZURE_AD_TENANT_ID",
  "AZURE_AD_CLIENT_ID",
];

function withEnv(overrides: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // reset all to undefined, then apply overrides
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };
  const r = run();
  if (r instanceof Promise) return r.finally(restore);
  restore();
  return undefined;
}

function makeReqRes(reqInit: Partial<Request> & { headers?: Record<string, unknown> }) {
  const req = {
    method: "GET",
    path: "/chat",
    headers: {},
    query: {},
    ...reqInit,
  } as unknown as Request & { auth?: unknown };
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return { req, res, next, nextCalled: () => nextCalled };
}

test("SEC-3: DISABLE_AUTH bypass succeeds with explicit dev env + sentinel + email", async () => {
  await withEnv(
    { DISABLE_AUTH: "true", NODE_ENV: "development", AUTH_BYPASS_DEV_TOKEN: "s3cret" },
    async () => {
      const { req, res, next, nextCalled } = makeReqRes({
        headers: { "x-auth-bypass-dev-token": "s3cret", "x-user-email": "Dev@Example.com" },
      });
      await requireAzureAdAuth(req, res as unknown as Response, next);
      assert.equal(nextCalled(), true, "should pass through");
      assert.equal((req as unknown as { auth: { email: string } }).auth.email, "dev@example.com");
    },
  );
});

test("SEC-3: DISABLE_AUTH with sentinel UNSET fails closed (500)", async () => {
  await withEnv({ DISABLE_AUTH: "true", NODE_ENV: "development" }, async () => {
    const { req, res, next, nextCalled } = makeReqRes({ headers: { "x-user-email": "dev@example.com" } });
    await requireAzureAdAuth(req, res as unknown as Response, next);
    assert.equal(nextCalled(), false, "must NOT trust the header without the mandatory sentinel");
    assert.equal(res.statusCode, 500);
  });
});

test("SEC-3: DISABLE_AUTH with unset NODE_ENV is refused (500) — unset must not disable auth", async () => {
  await withEnv({ DISABLE_AUTH: "true", AUTH_BYPASS_DEV_TOKEN: "s3cret" }, async () => {
    const { req, res, next, nextCalled } = makeReqRes({
      headers: { "x-auth-bypass-dev-token": "s3cret", "x-user-email": "dev@example.com" },
    });
    await requireAzureAdAuth(req, res as unknown as Response, next);
    assert.equal(nextCalled(), false);
    assert.equal(res.statusCode, 500);
  });
});

test("SEC-3: DISABLE_AUTH refused on Vercel even in dev", async () => {
  await withEnv(
    { DISABLE_AUTH: "true", NODE_ENV: "development", VERCEL: "1", AUTH_BYPASS_DEV_TOKEN: "s3cret" },
    async () => {
      const { req, res, next, nextCalled } = makeReqRes({
        headers: { "x-auth-bypass-dev-token": "s3cret", "x-user-email": "dev@example.com" },
      });
      await requireAzureAdAuth(req, res as unknown as Response, next);
      assert.equal(nextCalled(), false);
      assert.equal(res.statusCode, 500);
    },
  );
});

test("SEC-3: DISABLE_AUTH with wrong sentinel token → 401", async () => {
  await withEnv(
    { DISABLE_AUTH: "true", NODE_ENV: "development", AUTH_BYPASS_DEV_TOKEN: "s3cret" },
    async () => {
      const { req, res, next, nextCalled } = makeReqRes({
        headers: { "x-auth-bypass-dev-token": "WRONG", "x-user-email": "dev@example.com" },
      });
      await requireAzureAdAuth(req, res as unknown as Response, next);
      assert.equal(nextCalled(), false);
      assert.equal(res.statusCode, 401);
    },
  );
});

test("SEC-3: DISABLE_AUTH with sentinel ok but no X-User-Email → 401", async () => {
  await withEnv(
    { DISABLE_AUTH: "true", NODE_ENV: "development", AUTH_BYPASS_DEV_TOKEN: "s3cret" },
    async () => {
      const { req, res, next, nextCalled } = makeReqRes({
        headers: { "x-auth-bypass-dev-token": "s3cret" },
      });
      await requireAzureAdAuth(req, res as unknown as Response, next);
      assert.equal(nextCalled(), false);
      assert.equal(res.statusCode, 401);
    },
  );
});

test("auth middleware: OPTIONS preflight passes through", async () => {
  await withEnv({}, async () => {
    const { req, res, next, nextCalled } = makeReqRes({ method: "OPTIONS" });
    await requireAzureAdAuth(req, res as unknown as Response, next);
    assert.equal(nextCalled(), true);
  });
});

test("auth middleware: /health is unauthenticated", async () => {
  await withEnv({}, async () => {
    const { req, res, next, nextCalled } = makeReqRes({ path: "/health" });
    await requireAzureAdAuth(req, res as unknown as Response, next);
    assert.equal(nextCalled(), true);
  });
});

test("auth middleware: not configured (no tenant/client) → 500 before any JWKS call", async () => {
  await withEnv({}, async () => {
    const { req, res, next, nextCalled } = makeReqRes({
      headers: { authorization: "Bearer abc" },
    });
    await requireAzureAdAuth(req, res as unknown as Response, next);
    assert.equal(nextCalled(), false);
    assert.equal(res.statusCode, 500);
  });
});

test("auth middleware: configured but missing token → 401", async () => {
  await withEnv({ AZURE_AD_TENANT_ID: "t", AZURE_AD_CLIENT_ID: "c" }, async () => {
    const { req, res, next, nextCalled } = makeReqRes({ headers: {} });
    await requireAzureAdAuth(req, res as unknown as Response, next);
    assert.equal(nextCalled(), false);
    assert.equal(res.statusCode, 401);
  });
});
