/**
 * Wave R20 · Short-lived SSE tickets.
 *
 * EventSource (SSE) cannot set an Authorization header, so the SPA previously
 * passed the raw Azure AD JWT as `?access_token=<jwt>`. Query strings leak into
 * proxy/CDN/access logs and browser history, so a long-lived bearer token there
 * is a real exposure. Instead the client trades its Bearer token (over a normal
 * POST, header-auth'd) for an OPAQUE, short-lived ticket and opens the stream
 * with `?sse_ticket=<ticket>`. A leaked ticket reveals no identity and expires
 * in minutes.
 *
 * Design notes:
 *  - Tickets are reusable within their TTL (NOT single-use) so the browser's
 *    automatic SSE reconnect re-presents the same ticket without re-minting.
 *  - Bound to the verified identity (email + immutable oid) captured when the
 *    Bearer token was validated, so the stream auth needs no second JWK check.
 *  - In-memory Map with periodic sweep. Multi-instance note: a ticket minted on
 *    instance A won't resolve on instance B; this is acceptable for the current
 *    sticky-session / single-region deploy and is documented for a future
 *    move to a shared store (Cosmos/Redis) if horizontal SSE fan-out lands.
 */
import { randomBytes } from "crypto";

export interface SseTicketIdentity {
  email: string;
  oid?: string;
}

interface StoredTicket extends SseTicketIdentity {
  expiresAt: number;
}

const TICKET_TTL_MS = 5 * 60 * 1000; // 5 minutes — covers reconnect windows
const store = new Map<string, StoredTicket>();

// Periodic sweep of expired tickets (unref'd so it never holds the process up).
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
}, 60 * 1000).unref();

/**
 * Mint a ticket for an already-authenticated identity. Returns the opaque
 * ticket string and its lifetime in seconds (for the client to schedule a
 * refresh before expiry).
 */
export function mintSseTicket(
  identity: SseTicketIdentity,
  nowMs: number = Date.now(),
): { ticket: string; expiresInSeconds: number } {
  const ticket = randomBytes(32).toString("base64url");
  store.set(ticket, {
    email: identity.email,
    oid: identity.oid,
    expiresAt: nowMs + TICKET_TTL_MS,
  });
  return { ticket, expiresInSeconds: Math.floor(TICKET_TTL_MS / 1000) };
}

/**
 * Resolve a ticket to its identity, or null when unknown/expired. Reusable
 * within the TTL; expired tickets are eagerly deleted on lookup.
 */
export function resolveSseTicket(
  ticket: string | undefined | null,
  nowMs: number = Date.now(),
): SseTicketIdentity | null {
  if (!ticket || typeof ticket !== "string") return null;
  const found = store.get(ticket);
  if (!found) return null;
  if (found.expiresAt <= nowMs) {
    store.delete(ticket);
    return null;
  }
  return { email: found.email, oid: found.oid };
}

/** Test-only · clear the in-memory ticket store. */
export function __clearSseTicketsForTesting(): void {
  store.clear();
}
