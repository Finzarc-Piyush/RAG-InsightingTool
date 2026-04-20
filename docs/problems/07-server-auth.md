# 07 — Auth & middleware (server)

Wave 2.

---

### P-009 — `DISABLE_AUTH=true` trusts any `X-User-Email` header

- **Severity:** high
- **Category:** security
- **Location:** `server/middleware/azureAdAuth.ts:103-114`
- **Evidence:** When `DISABLE_AUTH=true`, the header is read with no further validation. If the flag ships accidentally, any client can impersonate any user. Some proxies rewrite incoming headers silently.
- **Fix:** (a) refuse to boot when `DISABLE_AUTH=true && NODE_ENV=production`; (b) require a second dev-only sentinel env var (`AUTH_BYPASS_DEV_TOKEN`) to match a constant-time-compared value; (c) audit-log every bypassed request with method, path, email, source IP.
- **Status:** todo

### P-031 — JWKS-miss paths not individually throttled

- **Severity:** medium
- **Category:** rate-limit
- **Location:** `server/index.ts:13-19`
- **Evidence:** Global limiter skips `/health`; JWKS cache misses during token verification are not individually throttled, so a client spamming invalid tokens forces repeated Azure AD round-trips.
- **Fix:** Add a per-IP token-bucket limiter in front of the Azure AD verify step for unauthenticated paths / cache misses. Small bucket (e.g. 20 / min) is enough to blunt abuse without breaking legitimate cold starts.
- **Status:** todo
