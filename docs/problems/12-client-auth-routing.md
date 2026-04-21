# 12 — Client — auth & routing

Wave 2.

---

### P-013 — `AuthContext.isLoading` can stick forever

- **Severity:** high
- **Category:** auth UX (bricked login screen)
- **Location:** `client/src/contexts/AuthContext.tsx:45-60`
- **Evidence:** `setIsLoading(false)` only fires when `accounts.length > 0` OR `inProgress === 'none'`. If MSAL is stuck in a non-terminal `inProgress` state with no accounts (network glitch, popup blocked), the `ProtectedRoute` loading screen renders indefinitely.
- **Fix:** Add a 5-second failsafe `setTimeout` inside the effect: if still loading after 5s, force `setIsLoading(false)` and render the login path. Keep the normal exit paths intact.
- **Status:** todo

### P-016 — MSAL instance created at module scope

- **Severity:** high
- **Category:** bootstrap (HMR fragility + re-auth storms)
- **Location:** `client/src/App.tsx:181-182`
- **Evidence:** `const msalInstance = new PublicClientApplication(createMsalConfig()); registerMsalInstance(msalInstance);` at module top-level. HMR reparse or a second import path can build a second instance and invalidate cached auth state.
- **Fix:** Wrap in a lazy singleton (`let cached; export function getMsalInstance() { if (!cached) cached = new PublicClientApplication(createMsalConfig()); return cached; }`) and call it inside the `App` component. Guarantees exactly one instance per tab.
- **Status:** todo

### P-045 — Redirect effect can loop

- **Severity:** medium
- **Category:** correctness (redirect storm in edge cases)
- **Location:** `client/src/App.tsx:93-97`
- **Evidence:** `useEffect(() => { if (location === '/' || …) setLocation('/analysis'); }, [location, setLocation])`. If `setLocation` is unstable or a downstream effect rewrites `location`, the effect thrashes.
- **Fix:** Guard with `if (location !== '/analysis') setLocation('/analysis')`. Drop `setLocation` from the dependency array (it's stable in wouter) to reduce noise.
- **Status:** todo

### P-046 — Token refresh silent failure → cryptic 401

- **Severity:** medium
- **Category:** UX
- **Location:** `client/src/auth/msalToken.ts:22-37`
- **Evidence:** `acquireTokenSilent` → `acquireTokenPopup` fallback → `null` on double-fail. Callers that don't check `null` hit a 401 with no user feedback.
- **Fix:** Emit a typed error event (custom `Event` on window, or a callback registered via the auth context) on double-fail. Wire `ProtectedRoute`/toast to show "Session expired — please sign in again" and trigger re-login.
- **Status:** todo

### P-065 — `AuthRedirectHandler` can flash both AuthCallback and Router

- **Severity:** low
- **Category:** correctness (visual flash; MSAL's `handleRedirectPromise` already guards double-handling)
- **Location:** `client/src/App.tsx:152-178`
- **Evidence:** The component uses `useState(true)` for `isHandlingRedirect`, then sets it to `false` in an effect if no `code`/`error` search param. Async setState causes a brief render where both branches can appear before settling.
- **Fix:** Compute `isHandlingRedirect` synchronously from `window.location.search` in the initial state (no effect). Keep the MSAL callback for actual code exchange.
- **Status:** todo

### P-072 — Legacy `/data-ops`, `/modeling` redirects undocumented

- **Severity:** low
- **Category:** dead-code / docs
- **Location:** `client/src/App.tsx:94`
- **Evidence:** Redirects exist with no comment explaining why.
- **Fix:** Add a 1-line comment stating these are preserved for bookmark backward-compatibility (or remove if nobody has bookmarked them).
- **Status:** todo
