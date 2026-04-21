# Monorepo overview

## Services

| Dir | Runtime | Port | Role |
|---|---|---:|---|
| `client/` | Vite · React 18 · TS (ESM) | 3000 | SPA, MSAL auth, wouter routing, Tailwind + Radix UI, TanStack Query |
| `server/` | Node 20 · Express · TS (tsx, ESM) | 3002 | REST + SSE API, chat orchestration, RAG, DuckDB query execution, Cosmos DB |
| `python-service/` | FastAPI · Uvicorn | 8001 | pandas / sklearn data-ops (preview, transforms, ML training) |
| `api/` | Vercel serverless wrappers | — | `api/index.ts` wraps `server/createApp()`; `api/data-ops/index.py` exposes `python-service/main.py` as ASGI |

No top-level `package.json` — each service owns its dependencies. CI
runs `npm ci && npm run build` (and `npm test` for server + client) per
service.

## Dev loop

Start three terminals, in order — server boots some data-ops eagerly:

```bash
cd python-service && python3 main.py            # :8001
cd server && npm run dev                         # :3002
cd client && npm run dev                         # :3000 (proxies /api → :3002)
```

`.cursor/rules/restart-servers.mdc` enforces that "restart servers" kills
PIDs on 8001 / 3002 / 3000 and restarts in that order.

## Env files (non-standard names)

- `server/server.env` — loaded by `server/loadEnv.ts` which **must** be
  the first import in `server/index.ts`.
- `client/client.env` — loaded by `client/vite.config.ts` via `dotenv`
  before `loadEnv()`, because Vite only auto-reads `.env*` names.

Critical flags (see `CLAUDE.md` for the full list):

- `AGENTIC_LOOP_ENABLED=true` → agentic plan/act loop (requires
  `RAG_ENABLED=true` + Azure Search creds; `assertAgenticRagConfiguration`
  fails boot on misconfig).
- `DEEP_ANALYSIS_SKILLS_ENABLED` → exposes the Phase-1 skills to the
  planner.
- `DASHBOARD_AUTOGEN_ENABLED` → Phase-2 dashboard draft loop; requires
  `AGENTIC_LOOP_ENABLED` (guarded at boot).

## Data / storage

- **Cosmos DB** — session + chat documents (`server/models/*.model.ts`),
  lazy-initialised at startup.
- **Azure Blob Storage** — uploaded datasets (optional).
- **Azure AI Search** — RAG index for session chunks
  (`server/lib/rag/**`). Index created via
  `cd server && npm run create-rag-index`.
- **DuckDB** — in-process analytical executor for query plans
  (`server/lib/queryPlanDuckdbExecutor.ts`,
  `lib/ensureSessionDuckdbMaterialized.ts`).
- **Snowflake** — optional import source.

## Deployment

Vercel. `api/index.ts` sets `process.env.VERCEL = '1'`; `server/index.ts`
skips `http.createServer` when `VERCEL` is set. `client/vercel.json`
rewrites all routes to `index.html` and caches `/assets/*` immutably.

## Conventions that bite

- **ESM everywhere on the server.** Relative imports use `.js`
  extensions even from `.ts` source (`tsx` + `esbuild` both resolve
  this). Don't drop the extensions.
- **`loadEnv.ts` must be the first import in `server/index.ts`.**
- **Agentic-on has no legacy fallback.** See `agent-runtime.md`.
- **Server `npm test` is an explicit file list**, not a glob — see
  `server/package.json`. New tests must be appended or CI silently
  skips them.

## Recent changes

- Living architecture docs seeded — initial set: README, overview,
  agent-runtime, skills, tool-registry, schemas, brand-system.
