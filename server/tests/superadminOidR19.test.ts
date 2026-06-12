import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import {
  isSuperadminOid,
  isSuperadminRequest,
  __setSuperadminOidsForTesting,
  __resetSuperadminOidsForTesting,
  __setSuperadminEmailsForTesting,
  __resetSuperadminEmailsForTesting,
} from "../lib/superadmin.js";
import { getAuthenticatedOid } from "../utils/auth.helper.js";

/**
 * Wave R19 · authorize on the immutable Azure AD `oid` (preferred) with the
 * email allowlist as a backward-compatible fallback.
 */
function reqWith(auth?: { email?: string; oid?: string }): Request {
  return {
    auth: auth ? { email: auth.email ?? "", oid: auth.oid, claims: {} } : undefined,
    headers: {},
  } as unknown as Request;
}

test("getAuthenticatedOid reads the immutable oid from req.auth", () => {
  assert.equal(getAuthenticatedOid(reqWith({ oid: "oid-123" })), "oid-123");
  assert.equal(getAuthenticatedOid(reqWith({ email: "a@b.com" })), undefined);
  assert.equal(getAuthenticatedOid(reqWith()), undefined);
});

test("isSuperadminRequest prefers oid when SUPERADMIN_OIDS is configured", () => {
  __setSuperadminOidsForTesting(["oid-super"]);
  try {
    assert.equal(isSuperadminOid("oid-super"), true);
    assert.equal(isSuperadminOid("oid-other"), false);
    // oid match wins even when the email is not a superadmin.
    assert.equal(
      isSuperadminRequest(reqWith({ oid: "oid-super", email: "nobody@x.com" })),
      true,
    );
    assert.equal(
      isSuperadminRequest(reqWith({ oid: "oid-other", email: "nobody@x.com" })),
      false,
    );
  } finally {
    __resetSuperadminOidsForTesting();
  }
});

test("email allowlist remains a fallback (backward compatible)", () => {
  __setSuperadminEmailsForTesting(["admin@x.com"]);
  __setSuperadminOidsForTesting([]);
  try {
    assert.equal(isSuperadminRequest(reqWith({ email: "admin@x.com" })), true);
    assert.equal(isSuperadminRequest(reqWith({ email: "other@x.com" })), false);
  } finally {
    __resetSuperadminEmailsForTesting();
    __resetSuperadminOidsForTesting();
  }
});
