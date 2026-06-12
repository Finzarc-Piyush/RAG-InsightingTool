import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintSseTicket,
  resolveSseTicket,
  __clearSseTicketsForTesting,
} from "../lib/sseTicket.js";

/**
 * Wave R20 · short-lived SSE tickets replace the raw JWT in ?access_token.
 */

test("mint → resolve returns the bound identity within TTL", () => {
  __clearSseTicketsForTesting();
  const t0 = 1_000_000;
  const { ticket, expiresInSeconds } = mintSseTicket(
    { email: "a@b.com", oid: "oid-1" },
    t0,
  );
  assert.ok(ticket.length >= 32, "ticket is opaque + sufficiently long");
  assert.equal(expiresInSeconds, 300);
  // Reusable within TTL (SSE auto-reconnect re-presents the same ticket).
  const id1 = resolveSseTicket(ticket, t0 + 1_000);
  const id2 = resolveSseTicket(ticket, t0 + 299_000);
  assert.deepEqual(id1, { email: "a@b.com", oid: "oid-1" });
  assert.deepEqual(id2, { email: "a@b.com", oid: "oid-1" });
});

test("resolve returns null for unknown / empty tickets", () => {
  __clearSseTicketsForTesting();
  assert.equal(resolveSseTicket("nope"), null);
  assert.equal(resolveSseTicket(""), null);
  assert.equal(resolveSseTicket(undefined), null);
  assert.equal(resolveSseTicket(null), null);
});

test("ticket expires after the TTL and is evicted", () => {
  __clearSseTicketsForTesting();
  const t0 = 5_000_000;
  const { ticket } = mintSseTicket({ email: "x@y.com" }, t0);
  assert.equal(resolveSseTicket(ticket, t0 + 5 * 60 * 1000 + 1), null);
  // Subsequent lookup also null (evicted on the expiry check).
  assert.equal(resolveSseTicket(ticket, t0 + 1_000), null);
});

test("tickets are unique per mint", () => {
  __clearSseTicketsForTesting();
  const a = mintSseTicket({ email: "a@b.com" }).ticket;
  const b = mintSseTicket({ email: "a@b.com" }).ticket;
  assert.notEqual(a, b);
});
