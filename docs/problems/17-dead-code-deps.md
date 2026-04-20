# 17 — Dead code & unused deps

Wave 3. Decision locked in: remove anything with zero imports.

---

### P-054 — Dead dependencies in `server/package.json`

- **Severity:** low
- **Category:** dead-code / bundle
- **Location:** `server/package.json`
- **Evidence:** The following deps have zero grep hits in `server/`:
  - `ws`
  - `passport`
  - `passport-local`
  - `memorystore`
  - `connect-pg-simple`
  - `@neondatabase/serverless`
  - `drizzle-orm` (Cosmos-only app; no Postgres/Neon used)
  - `drizzle-zod` (same)
- **Fix:** One confirmation grep round per package (including dynamic imports), then `npm uninstall` each. Commit in one PR with before/after `dist` size in the message.
- **Status:** todo

### P-055 — Unused Python deps (`matplotlib`, `seaborn`)

- **Severity:** low
- **Category:** dead-code
- **Location:** `python-service/requirements.txt`
- **Evidence:** `matplotlib==3.9.2`, `seaborn==0.13.2` declared but zero imports in `data_operations.py` or `ml_models.py`. Combined they add ~100 MB to the image.
- **Fix:** Remove both lines; reinstall to confirm nothing breaks.
- **Status:** todo

### P-069 — `UserEmailDebug` component unused

- **Severity:** low
- **Category:** dead-code
- **Location:** `client/src/components/UserEmailDebug.tsx`
- **Evidence:** No imports of this component in the app tree.
- **Fix:** Delete the file. If a dev needs it later, `git show` restores it.
- **Status:** todo

### P-070 — `AvailableModelsDialog` component possibly unused (verify)

- **Severity:** low
- **Category:** dead-code (suspicion)
- **Location:** `client/src/components/AvailableModelsDialog.tsx`
- **Evidence:** Initial grep found no imports. Dynamic/lazy imports could hide it.
- **Fix:** Broader grep (`grep -r AvailableModelsDialog client/`) + check for dynamic patterns (`React.lazy(() => import(...))`). If truly unused, delete.
- **Status:** todo

### P-078 — Stale IE11 comment in `msalConfig.ts`

- **Severity:** low
- **Category:** docs / dead-code
- **Location:** `client/src/auth/msalConfig.ts:24`
- **Evidence:** Comment references IE11 support decisions; IE11 is dead.
- **Fix:** Delete the comment.
- **Status:** todo

### P-075 — `ChatSidebarNavContext` / `DashboardContext` value not memoized

- **Severity:** low
- **Category:** performance
- **Location:** `client/src/contexts/ChatSidebarNavContext.tsx`; `client/src/pages/Dashboard/context/DashboardContext.tsx:49`
- **Evidence:** Context `value` prop is a new object literal on every render — all consumers re-render even when data is unchanged.
- **Fix:** `const value = useMemo(() => ({ … }), [deps])` in each provider.
- **Status:** todo

### P-076 — `useSessionLoader` effect depends on unstable setter identities

- **Severity:** low
- **Category:** performance
- **Location:** `client/src/pages/Home/modules/useSessionLoader.ts:127-144`
- **Evidence:** Effect deps include several `setX` functions from `useHomeState`. If those setters are new each render, the effect runs every render.
- **Fix:** Move the setters into a ref (via `useRef`) or stabilize them in `useHomeState` with `useCallback`. Re-check the effect runs only on real `loadedSessionData` change.
- **Status:** todo
