# 14 — Client — TanStack Query & HTTP layer

Wave 2 (P-014, P-049) + Wave 3 (P-074).

---

### P-014 — TanStack Query defaults too aggressive (`staleTime: Infinity`, no retry)

- **Severity:** high
- **Category:** state / UX
- **Location:** `client/src/lib/queryClient.ts:32`
- **Evidence:** `{ staleTime: Infinity, refetchInterval: false, refetchOnWindowFocus: false, retry: false }`. Queries never go stale, never retry, never refetch on focus. User comes back to the tab hours later and sees cached-forever data.
- **Fix:** Set sane defaults: `staleTime: 5 * 60_000` (5 min), `retry: 1`, `refetchOnWindowFocus: true`. Keep `refetchInterval: false` (explicit opt-in per query). Any query that truly needs forever-cache can override inline.
- **Status:** todo

### P-049 — HTTP retry reuses aborted signal

- **Severity:** medium
- **Category:** correctness
- **Location:** `client/src/lib/httpClient.ts:57-66`
- **Evidence:** On a CORS/network error the interceptor calls `apiClient.request(error.config)` without clearing `error.config.signal`. If the original signal already fired, the retry aborts immediately.
- **Fix:** Before retry, clone the config and delete `signal`, or set a fresh `AbortController().signal` with a short budget. Log the retry attempt once for debuggability.
- **Status:** todo

### P-074 — `httpClient.ts:111-114` logs full response headers in DEV

- **Severity:** low
- **Category:** logging / privacy
- **Location:** `client/src/lib/httpClient.ts:111-114`
- **Evidence:** DEV-mode logger dumps `response.headers` including any custom auth or session headers.
- **Fix:** Redact a known-sensitive set (`authorization`, `x-*-token`, `set-cookie`) before logging. Better: log only a whitelist of header names relevant for debugging.
- **Status:** todo
