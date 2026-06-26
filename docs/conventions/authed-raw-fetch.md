# Convention: Authenticate every raw `fetch()` to `/api/*` — interactive for user actions, silent for background beacons

> Introduced in Wave W-INS1/W-INS2 (2026-06-26) after the dashboard "Generate insight"
> fallback 401'd with *"Missing Authorization: Bearer token or access_token query"*.
> Codified on discovering it was a recurring class across six call sites. See
> [`docs/lessons.md`](../lessons.md) L-036.

## Rule

The client's auth token (an Azure AD ID token from MSAL) is auto-attached to API
requests by the **axios `apiClient` request interceptor** in
[`httpClient.ts`](../../client/src/lib/httpClient.ts). That interceptor only runs for
calls made through `api.*` (`api.get` / `api.post` / …). **A raw `fetch()` does NOT go
through axios, so it carries no token unless you add one.** The server guards every
`/api/*` route with `requireAzureAdAuth`
([`azureAdAuth.ts`](../../server/middleware/azureAdAuth.ts)), which returns 401 unless an
`Authorization: Bearer <id-token>` header is present (the `?access_token=` query
fallback is off by default since Wave R33).

Therefore **every raw `fetch("/api/…")` must attach the token itself**, choosing the
variant by who triggered it:

| Trigger | Helper | Why |
|---|---|---|
| **User-initiated** (button click, "Update data", replay) | `getAuthorizationHeader()` | Interactive — on a stale token it may pop an MSAL re-auth window, which is acceptable UX when the user just clicked something. |
| **Fire-and-forget background** (telemetry beacon, error sink) | `getAuthorizationHeaderSilent()` | Silent — reads the MSAL cache only, **never** pops a popup. Returns `{}` when no token is cached, so the request is sent as-is (best-effort) rather than hijacking the screen with a login window. |

Both live in [`msalToken.ts`](../../client/src/auth/msalToken.ts). The silent variant is
`acquireIdTokenForApi({ allowPopup: false })` under the hood.

```ts
// User-initiated raw fetch:
const auth = await getAuthorizationHeader();
const res = await fetch("/api/insight/regen", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json", ...auth },
  body: JSON.stringify(body),
});

// Fire-and-forget background beacon:
const auth = await getAuthorizationHeaderSilent();
await fetch("/api/telemetry/drill-through", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json", ...auth },
  body: JSON.stringify(payload),
});
```

## Why

The interceptor is a convenience that makes `api.post(...)` "just work", which trains
you to treat auth as ambient. The instant a feature needs something axios can't express
cleanly — an SSE/streaming response read via `getReader()`, a `multipart/form-data`
upload, a `keepalive` unload beacon — it drops to raw `fetch` and the ambient guarantee
silently evaporates. There is no compile error and no obvious runtime signal: the 401
surfaces only as "the feature doesn't work" (or, for fire-and-forget calls, as nothing
at all — the data is just silently lost). Six call sites had shipped this way.

The interactive-vs-silent split is load-bearing, not cosmetic. The naive uniform fix —
`getAuthorizationHeader()` everywhere — would make a background telemetry beacon or the
global error reporter call `acquireTokenPopup()` when the token is stale, erupting a
login window unprompted (and, for the error sink, potentially *while the app is already
crashing*). That is a NEW broken behaviour. The silent variant degrades to "send without
a token" exactly as the code did before the fix — no regression, no popup.

Alternatives considered and rejected:

- **Exempt `/api/client-error` + `/api/telemetry/*` from `requireAzureAdAuth` on the
  server** (like `/api/health`). More invasive to the auth middleware and opens
  unauthenticated write endpoints (a log-spam / exfil surface). Keeping the fix
  client-side and uniform is lower blast radius.
- **A shared `authedFetch()` wrapper** replacing all raw fetches. Tempting, but each site
  has bespoke shape (streaming reader loops, multipart bodies, keepalive, abort handles);
  a one-size wrapper would either leak those concerns or fight them. The inline
  `...auth` spread matches the existing pattern (feedback/superadmin/admin/chat all do it)
  and keeps each call site's plumbing intact. Revisit only if the count grows.

## How to apply

When you write `fetch("/api/…")` (or see one in review):

1. **Is it raw or `api.*`?** If `api.*`, the interceptor covers it — done. If raw, it
   needs an explicit token; there is no third option that authenticates.
2. **Classify the trigger** and pick the helper from the table above. Default to
   `getAuthorizationHeaderSilent()` only for genuinely fire-and-forget background calls
   that must never interrupt the user.
3. **Place `await get…()` INSIDE the existing `try`/async-IIFE**, before the `fetch`, so
   synchronous-return contracts (`{ abort }` handles) and never-throws invariants are
   preserved.
4. **Multipart:** merge as `{ ...callerHeaders, ...auth }` and do NOT set `Content-Type`
   — the browser must set the multipart boundary. The merge preserves a deliberate
   *absence* of `Content-Type`.
5. **Pin it with a test** that asserts the header reaches the wire: `vi.stubGlobal("fetch", …)`
   then inspect `init.headers.Authorization`. A mock that's merely *present* (as
   `refresh.vitest.test.ts` had) does not prove the code sends it.
6. **Found one? Sweep the class.** Grep `fetch("/api` and `` fetch(`${``…``}/api `` across
   `client/` — missing-auth raw fetches cluster around streaming, multipart, and beacons.

## Related

- [`docs/lessons.md`](../lessons.md) L-036 — the cross-session lesson.
- Compliant call sites (all `client/`): [`useInsightRegen.ts`](../../client/src/pages/Dashboard/hooks/useInsightRegen.ts),
  [`useEnsureDashboardInsights.ts`](../../client/src/pages/Dashboard/hooks/useEnsureDashboardInsights.ts) (the insight self-heal on dashboard open),
  [`automations.ts`](../../client/src/lib/api/automations.ts),
  [`refresh.ts`](../../client/src/lib/api/refresh.ts) (`streamSse`),
  [`telemetry.ts`](../../client/src/lib/telemetry.ts) (silent),
  [`errorSink.ts`](../../client/src/lib/errorSink.ts) (silent).
- Token helpers: [`msalToken.ts`](../../client/src/auth/msalToken.ts).
- Server gate: [`azureAdAuth.ts`](../../server/middleware/azureAdAuth.ts).
- Adjacent: the SSE-ticket pattern (`acquireSseTicket` in `msalToken.ts`) — for
  `EventSource`, which can't set headers, exchange the Bearer token for an opaque
  `?sse_ticket=` instead. Raw `fetch` SSE (used here) keeps the header.
