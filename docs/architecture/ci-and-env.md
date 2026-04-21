# CI and environment files

## Purpose

How the three services boot their configuration and how CI verifies
the tree. Two non-standard env filenames + a deliberately narrow CI
matrix; this doc is the map.

## Key files

- `.github/workflows/ci.yml` — CI matrix. Three jobs: `server`,
  `client`, `python`. Runs on push + PR to `main`/`master`.
- `server/loadEnv.ts` — reads `server/server.env` into
  `process.env`. **Must** be the first import in `server/index.ts`.
- `client/vite.config.ts` — loads `client/client.env` via `dotenv`
  before Vite's own `loadEnv()` so the SPA sees the vars.
- `server/.env.example` — the expected variable set for the server.
  Mirror any new key into this file in the same commit.
- `server/lib/agents/runtime/assertAgenticRag.ts` — runs inside
  `createApp()`. Fails boot when `AGENTIC_LOOP_ENABLED=true` but RAG
  is not configured; same file now also guards
  `DASHBOARD_AUTOGEN_ENABLED`.

## CI matrix

```
server/
  npm ci && npm run build && npm run typecheck && npm test
client/
  npm ci && npm run build && npm run theme:check && npm test
python-service/
  pip install -r requirements.txt
  python -c "import main; print('OK')"
  Requirements sync gate (P-005) — api/data-ops/requirements.txt
  must `-r ../../python-service/requirements.txt`.
```

Everything runs on Node 20 and Python 3.12. No external services.

## Env-file quirks

- **`server/server.env`** — not a standard `.env` name, Vite + dotenv
  won't auto-load it. `server/loadEnv.ts` reads it explicitly.
- **`client/client.env`** — same story for the SPA.
- Don't rename either without updating the loader first, or both
  services boot with missing config.
- Port sync: if you change server `PORT`, set `VITE_DEV_API_PORT` (or
  `VITE_DEV_API_ORIGIN`) in `client.env` so the Vite proxy still
  reaches `/api`.

## Critical flags (server)

| Flag | Effect |
|---|---|
| `AGENTIC_LOOP_ENABLED=true` | Routes every turn through the agentic runtime. **Requires** RAG configured; boot fails without it. |
| `AGENTIC_ALLOW_NO_RAG=true` | Tests / local only; bypasses the RAG assertion. |
| `DEEP_ANALYSIS_SKILLS_ENABLED=true` | Exposes Phase-1 skills to the planner. |
| `DEEP_ANALYSIS_SKILL_ALLOWLIST` | Comma-separated skill names for staged rollout. |
| `DASHBOARD_AUTOGEN_ENABLED=true` | Phase-2 dashboard draft loop. Requires `AGENTIC_LOOP_ENABLED=true`. |
| `PYTHON_SERVICE_URL=http://localhost:8001` | Node → Python bridge. |
| `AGENT_TOOL_TIMEOUT_MS` / `AGENTIC_MAX_STEPS` | Hotfix knobs — prefer these over disabling the agentic runtime. |

See `server/.env.example` for the complete list.

## Server tests

`server/package.json` `test` is **an explicit file list**, not a glob.
Node's built-in test runner (`node --import tsx --test`) is invoked
with every test file listed by path. New test files must be appended
or CI silently skips them. Known gotcha — a comment in `CLAUDE.md`
calls it out.

Some client tests also live in the server `test` list via
`../client/...` paths (`chartFilters.test.ts`,
`parseContentDispositionFilename.test.ts`,
`splitAssistantFollowUpPrompts.test.ts`,
`dashboardGridLogic.test.ts`, `useLayoutHistory.test.ts`). These are
node:test compatible files; they pre-date the client's vitest runner
and stay where they are to avoid churn.

## Client tests

The client runs **vitest** via `npm test`. Config lives at
`client/vitest.config.ts`; the include glob is
`src/**/*.{vitest.test,vitest.spec}.{ts,tsx}` — this intentionally
excludes plain `*.test.ts` files so the server's node:test list does
not double-count.

Vitest is pinned in `client/devDependencies` (`^2.1.9`). Before Wave
F8 the script invoked `npx --yes vitest@^2` at run time, which
fetched from the registry on every CI run and hid a broken config
(see "Known pitfalls" below).

DOM-driven tests will need `environment: "jsdom"` and
`@testing-library/*` devDeps added the first time one lands.

## Python tests

No test job today — the CI step only verifies that `main.py` imports
cleanly and that `api/data-ops/requirements.txt` pins versions via
`-r ../../python-service/requirements.txt` (the sync gate).

## Deployment

- Vercel. `api/index.ts` sets `process.env.VERCEL = '1'`;
  `server/index.ts` skips `http.createServer` when `VERCEL` is set.
- `api/data-ops/index.py` exposes FastAPI `app` as ASGI for
  serverless Python.
- `client/vercel.json` rewrites SPA routes to `index.html` and
  caches `/assets/*` immutably.

## Known pitfalls

- **`loadEnv.ts` must be the first import in `server/index.ts`.**
  Anything above it will read `process.env` before it's populated.
- **Server `npm test` is an explicit list.** See above.
- **Non-standard env-file names don't auto-load.** Rename only with
  the matching loader change.
- **Block comments with glob patterns can close themselves.** A
  JSDoc comment containing `src/**/*.ts` puts a `*/` inside it and
  ends the block silently — Wave F8 caught this in
  `vitest.config.ts`. Prefer `//` line comments for headers that
  mention globs.

## Recent changes

- **Wave F8** — pinned `vitest@^2.1.9` in
  `client/devDependencies`; switched the test script from
  `npx --yes vitest@^2 …` to `vitest run …`. CI `npm ci` now
  installs deterministically; no per-run registry fetch. Also fixed
  `vitest.config.ts` — a glob pattern inside the JSDoc header
  (`src/**/*.…`) contained `*/` which silently closed the comment
  and broke config loading. Header now uses line comments.
- Initial seed of this doc.
