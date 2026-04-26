import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import {
  listDomainContextPacks,
  setDomainContextPackEnabled,
} from "../controllers/adminDomainContextController.js";

function fakeRes(): Response & {
  status: (code: number) => Response;
  json: (b: unknown) => Response;
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

test("listDomainContextPacks: 403 when caller is not admin", async () => {
  // No ADMIN_EMAILS set → no email matches
  const before = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await listDomainContextPacks(fakeReq({ email: "random@example.com" }), res);
    assert.equal(res._status, 403);
    assert.deepEqual(res._body, { error: "admin_required" });
  } finally {
    if (before) process.env.ADMIN_EMAILS = before;
    delete process.env.DISABLE_AUTH;
  }
});

test("listDomainContextPacks: 200 returns packs when caller is admin", async () => {
  const before = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await listDomainContextPacks(fakeReq({ email: "admin@example.com" }), res);
    assert.equal(res._status, 200);
    const body = res._body as { packs: Array<{ id: string }>; totalEnabledTokens: number };
    assert.ok(Array.isArray(body.packs));
    assert.ok(body.packs.length === 13, `expected 13 packs, got ${body.packs.length}`);
    assert.ok(body.totalEnabledTokens > 0);
    assert.ok(body.packs.find((p) => p.id === "marico-company-profile"));
  } finally {
    if (before) process.env.ADMIN_EMAILS = before;
    else delete process.env.ADMIN_EMAILS;
    delete process.env.DISABLE_AUTH;
  }
});

test("setDomainContextPackEnabled: 400 when body.enabled is not a boolean", async () => {
  const before = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await setDomainContextPackEnabled(
      fakeReq({
        email: "admin@example.com",
        params: { packId: "marico-company-profile" },
        body: {},
      }),
      res
    );
    assert.equal(res._status, 400);
    assert.deepEqual(res._body, { error: "enabled_must_be_boolean" });
  } finally {
    if (before) process.env.ADMIN_EMAILS = before;
    else delete process.env.ADMIN_EMAILS;
    delete process.env.DISABLE_AUTH;
  }
});

test("setDomainContextPackEnabled: 404 for unknown pack id", async () => {
  const before = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.DISABLE_AUTH = "true";
  try {
    const res = fakeRes();
    await setDomainContextPackEnabled(
      fakeReq({
        email: "admin@example.com",
        params: { packId: "no-such-pack" },
        body: { enabled: true },
      }),
      res
    );
    assert.equal(res._status, 404);
  } finally {
    if (before) process.env.ADMIN_EMAILS = before;
    else delete process.env.ADMIN_EMAILS;
    delete process.env.DISABLE_AUTH;
  }
});

test("setDomainContextPackEnabled: 500 when Cosmos store unavailable for write", async () => {
  // Cosmos is not configured in the test env, so the store throws on writes.
  const before = process.env.ADMIN_EMAILS;
  const beforeCosmos = process.env.COSMOS_ENDPOINT;
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.DISABLE_AUTH = "true";
  delete process.env.COSMOS_ENDPOINT;
  try {
    const res = fakeRes();
    await setDomainContextPackEnabled(
      fakeReq({
        email: "admin@example.com",
        params: { packId: "marico-company-profile" },
        body: { enabled: false },
      }),
      res
    );
    assert.equal(res._status, 500);
    const body = res._body as { error: string };
    assert.equal(body.error, "admin_domain_context_patch_failed");
  } finally {
    if (before) process.env.ADMIN_EMAILS = before;
    else delete process.env.ADMIN_EMAILS;
    if (beforeCosmos) process.env.COSMOS_ENDPOINT = beforeCosmos;
    delete process.env.DISABLE_AUTH;
  }
});
