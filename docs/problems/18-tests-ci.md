# 18 — Tests & CI gaps

Wave 4. Lock in everything earlier waves fixed.

---

### P-011 — No Python job in CI

- **Severity:** high
- **Category:** CI
- **Location:** `.github/workflows/ci.yml`
- **Evidence:** Only `server` and `client` jobs exist. `python-service/` changes ship untested. Requirements drift vs `api/data-ops/` is not caught until deploy.
- **Fix:** Add a `python` job: `actions/setup-python@v4` (3.12), `pip install -r python-service/requirements.txt`, `python -c "import main"` smoke, reserve space for `pytest python-service/tests/` once tests exist. Add a "requirements sync" step that `diff`s `python-service/requirements.txt` against `api/data-ops/requirements.txt` (or fails if they diverge).
- **Status:** todo

### P-033 — Missing `server/tsconfig.json`; no `tsc` gate

- **Severity:** medium
- **Category:** build / types
- **Location:** `server/`
- **Evidence:** `tsx` + `esbuild` accept `.ts` directly but there is no `tsconfig.json`, no `tsc --noEmit` gate. Type errors only surface at editor.
- **Fix (locked-in decision: strict + fix errors same PR):** Add `server/tsconfig.json` with `strict: true`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `exactOptionalPropertyTypes: true`, matching the `tsx`/esbuild expectations (especially the ESM `.js` import convention). Add `"typecheck": "tsc --noEmit"` to `package.json` and run it in CI after `npm run build`. Fix every error surfaced before merge.
- **Status:** todo

### P-056 — Happy-path-only tests across `server/tests/`

- **Severity:** low
- **Category:** test coverage
- **Location:** `server/tests/*.test.ts` (~58 files)
- **Evidence:** Grep for `throw`/`rejects`/`catch` in test files returns < 10 hits. Error/timeout/malformed-input paths are undertested.
- **Fix:** Add at least one negative test per high-risk module: `chartSpecCompiler`, `ragRetrieve`, `duckdbPlanExecutor`, `pivotQueryService`, `dirtyDateEnrichment`, the SSE flusher. Focus on assertions that would have caught the bugs in areas 2, 3, 5.
- **Status:** todo

### P-057 — Server tests possibly not listed in `npm test` script

- **Severity:** low
- **Category:** CI (silent-skip risk)
- **Location:** `server/package.json` (`test` script), `server/tests/*.test.ts`
- **Evidence:** `CLAUDE.md` already warns: the `test` script is an explicit file list, not a glob; new files must be appended. Need to diff the script's list against actual files on disk.
- **Fix:** One-time reconciliation: list all `server/tests/*.test.ts` files, diff against the `test` script, append any missing ones. Add a CI step that does the same check on every PR (a tiny Node script: scan dir, compare).
- **Status:** todo

### P-062 — Client has no test runner

- **Severity:** low
- **Category:** test coverage
- **Location:** `client/package.json` (no `test` script)
- **Evidence:** A few `.test.ts(x)` files live under `client/src/` but are only executed via the server's `npm test` (which imports them by relative path). If the server job is skipped or the paths rot, coverage is silently lost.
- **Fix:** Add Vitest to `client/`: `vitest` dev dep, `"test": "vitest run"` script, wire into the client CI job. Migrate the existing client-side `.test.ts` files to run under Vitest and remove them from the server's explicit test list.
- **Status:** todo
