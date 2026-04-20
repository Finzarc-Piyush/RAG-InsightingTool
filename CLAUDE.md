# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Monorepo with three deployable services. No top-level `package.json` — each service has its own dependencies and is run from its own directory.

| Directory | Runtime | Default port | Purpose |
|-----------|---------|-------------:|---------|
| `client/` | Vite + React 18 + TS (ESM) | 3000 | SPA; Azure MSAL auth; `wouter` routing; Tailwind + Radix UI; TanStack Query |
| `server/` | Node 20 + Express + TS via `tsx` (ESM) | 3002 | REST + SSE API, chat orchestration, RAG, file parsing, DuckDB query execution |
| `python-service/` | FastAPI + Uvicorn | 8001 | Data operations (pandas/sklearn): preview, transforms, ML training |
| `api/` | Vercel serverless wrappers | — | `api/index.ts` wraps `server/createApp()`; `api/data-ops/index.py` wraps `python-service/main.py` |
| `docs/` | — | — | Architecture and plans; **read `docs/agents-architecture-inventory.md` before changing agent code** |

## Dev loop

Start all three services (order matters — Node API needs Python at boot for some ops):

```bash
# Terminal 1: Python data-ops
cd python-service && python3 main.py           # uvicorn on :8001

# Terminal 2: Node API
cd server && npm run dev                        # tsx :3002

# Terminal 3: Vite client
cd client && npm run dev                        # :3000 (proxies /api → :3002)
```

When asked to **"restart servers"** (plural / "all"), kill PIDs on **8001, 3002, 3000** then start all three in the order above (this is enforced by `.cursor/rules/restart-servers.mdc`). If the user asks to restart a single service, only restart that one.

### Environment files (non-standard names — Vite/dotenv won't auto-load them)

- `server/server.env` — loaded by `server/loadEnv.ts` (must be first import in `server/index.ts`). See `server/.env.example` for the full list.
- `client/client.env` — loaded manually in `client/vite.config.ts` via `dotenv` before `loadEnv()`, because Vite only auto-reads `.env*` names.

Critical flags:
- `AGENTIC_LOOP_ENABLED=true` → use the agentic plan/act loop (**requires** `RAG_ENABLED=true` + `AZURE_SEARCH_*`; startup asserts this via `assertAgenticRagConfiguration`). When on, there is **no fallback** to the legacy orchestrator or monolithic `dataAnalyzer`.
- `AGENTIC_ALLOW_NO_RAG=true` — tests/local only; bypasses the RAG assertion.
- `PYTHON_SERVICE_URL=http://localhost:8001` — server → python-service bridge.
- Ports must stay in sync: if you change server `PORT`, set `VITE_DEV_API_PORT` (or `VITE_DEV_API_ORIGIN`) in `client.env` so the Vite proxy still reaches it.

### Build / test / lint

```bash
# Server (CI runs: npm ci && npm run build && npm test)
cd server
npm run build                                   # esbuild → dist/
npm test                                        # node --test via tsx (see below)
npm run create-rag-index                        # create Azure AI Search index
npm run rag-smoke                               # smoke test retrieval

# Client (CI runs: npm ci && npm run build)
cd client
npm run build                                   # vite build → dist/
npm run theme:check                             # scripts/theme-check.mjs (required pre-merge for UI)
```

There is no project-wide `lint` target. TypeScript `strict` is on in both services; rely on `tsc` via `npm run build` for type errors.

#### Running a single test

`server/package.json` → `test` is an **explicit file list** passed to Node's built-in test runner (`node --import tsx --test ...`). To run one file:

```bash
cd server
node --import tsx --test tests/chartSpecCompiler.test.ts
# filter by test name
node --import tsx --test --test-name-pattern="temporal facet" tests/temporalFacetColumns.test.ts
```

When you add a new test file, append it to the `test` script's file list — it will **not** be picked up by a glob, and CI runs exactly what's listed there. A handful of test files live under `client/src/lib/**/*.test.ts` and are also listed in that same script (relative `../client/...` paths) — keep them there so CI executes them.

## Architecture — the big picture

### Request → chat response

1. **Client** (`client/src/pages/Home/`) posts a chat message; SSE streaming endpoint is `/api/chat/stream` (see `server/routes/chat.ts` → `controllers/chatController.ts` → `services/chat/chatStream.service.ts`).
2. **Server auth gate**: `requireAzureAdAuth` middleware validates Azure AD JWTs on all `/api/*` routes (except `/api/health`). `TRUST_PROXY=true` / `VERCEL` puts Express behind a proxy.
3. **Chat pipeline**: `chatStream.service` does mode classification → schema binding → context assembly (`services/chat/answerQuestionContext.ts`) → delegates to `lib/dataAnalyzer.ts` → `answerQuestion`.
4. **Branch point in `answerQuestion`**: `isAgenticLoopEnabled()` picks between:
   - **Agentic path**: `lib/agents/runtime/agentLoop.service.ts` → `runAgentTurn` (Planner → Tools → Reflector → Verifier, with budgets in `runtime/types.ts`, working memory in `runtime/workingMemory.ts`, tool registry in `runtime/tools/registerTools.ts`). RAG must be configured.
   - **Legacy path**: `lib/agents/orchestrator.ts` → `AgentOrchestrator.processQuery` → dispatches to **one** handler registered in `lib/agents/index.ts` (Conversational, DataOps, MLModel, Statistical, Comparison, Correlation, General — order matters).
5. **SSE → workbench**: agentic events flow through `services/chat/agentWorkbench.util.ts` into `AgentWorkbenchEntry` rows (shape shared via `server/shared/schema.ts` ↔ `client/src/shared/schema.ts`). Client renders them in `MessageBubble.tsx` and keeps live state in `useHomeMutations.ts`.

**Before editing anything under `server/lib/agents/` read `docs/agents-architecture-inventory.md` end-to-end** — it's the canonical map of the legacy handlers, the agentic runtime, cross-cutting modules (schema binding, column matcher), and every `AGENT_*` env flag. Rollout invariants (RAG mandatory when agentic is on, no legacy fallback) are in `docs/plans/agentic_only_rag_chat.md`.

### Data & storage

- **Cosmos DB** — session/chat documents, including `enrichmentStatus`, messages, dataSummary, sample rows (`server/models/chat.model.ts`, `dashboard.model.ts`, shared-analysis models). Initialized lazily on startup; first-use retry if creds missing.
- **Azure Blob Storage** — uploaded datasets; optional, initialized in background.
- **Snowflake** — optional import source (`lib/snowflakeService.ts`); connection verified at boot.
- **Azure AI Search** — RAG index for session chunks (`lib/rag/`). Create via `npm run create-rag-index`; vector dim must match `AZURE_OPENAI_EMBEDDING_DIMENSIONS`.
- **DuckDB** — in-process analytical execution for query plans (`lib/queryPlanDuckdbExecutor.ts`, `lib/duckdbPlanExecutor.ts`, `lib/ensureSessionDuckdbMaterialized.ts`).
- **Node → Python** bridge: `lib/dataOps/pythonService.ts` calls FastAPI at `PYTHON_SERVICE_URL`; optional `PYTHON_SERVICE_API_KEY` shared secret.

### Upload & enrichment pipeline (see `docs/architecture/upload_and_enrichment.md`)

- Uses an **in-process** queue in `server/utils/uploadQueue.ts`. Jobs are in-memory; session state lives in Cosmos.
- Order: persist **preview** first (heuristic `dataSummary`, ≤50 sample rows) → run **enrichment** (LLM profile + session context seed) → chat answers are **deferred** until `enrichmentStatus ∈ {complete, failed}`.
- Client polls `GET /api/upload/status/:jobId` for job phase.
- **Do not** add Redis, external queues, WebSockets, or worker processes speculatively — the doc lists explicit triggers (multi-instance deploy, event-loop saturation, failed flushes) that must be observed first. "Boring first" is the stated principle.

### Client routing & state

- Router: `wouter` (not React Router). Routes: `/analysis` (chat / Home), `/dashboard`, `/history` (Analysis), `/` redirects to `/analysis`.
- Code-split pages via `React.lazy` in `client/src/App.tsx`.
- Auth: `@azure/msal-browser` + `@azure/msal-react`. MSAL instance created once from `createMsalConfig()` and registered via `registerMsalInstance`; `ProtectedRoute` + `AuthRedirectHandler` gate rendering.
- Server state: TanStack Query with `queryClient` warmed in `App.tsx` (prefetches sessions). API clients live in `client/src/lib/api/`.
- Path aliases (`vite.config.ts` + `tsconfig.json`): `@/* → src/*`, `@shared/* → src/shared/*`, `@assets/* → ../attached_assets/*`.

### UI theming conventions (from `client/THEMING.md`)

- **Only** semantic token classes: `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, etc. **No** `text-gray-*`, `bg-white`, raw hex/rgb/hsl in JSX.
- For tables/lists use the shared utilities from `index.css`: `token-table-frame`, `token-table-head`, `token-table-row`, `surface-hover`, `surface-selected`, `surface-positive`.
- Prefer Radix/shadcn primitives in `client/src/components/ui/` before custom styling.
- Verify changes in **both** light and dark modes, and run `npm run theme:check`.

## Deployment

- **Vercel** is the target. `api/index.ts` sets `process.env.VERCEL = '1'` and exports the Express app from `createApp()`; `server/index.ts` skips the local `http.createServer` path when `VERCEL` is set. `api/data-ops/index.py` exposes the FastAPI `app` as ASGI.
- `client/vercel.json` rewrites all routes to `index.html` (SPA) and sets immutable cache headers on `/assets/*`.
- CI (`.github/workflows/ci.yml`) runs on push/PR to `main`/`master`: server (`build` + `test`) and client (`build`) on Node 20.

## Conventions that bite

- **ESM everywhere on the server.** All relative imports use `.js` extensions even from `.ts` source (e.g. `import { x } from "./routes/index.js"`). `tsx` resolves these; `esbuild` bundles with `--format=esm --packages=external`.
- **`loadEnv.ts` must be the first import in `server/index.ts`.** It populates `process.env` from `server/server.env` before any module reads config. Don't reorder.
- **`assertAgenticRagConfiguration()` runs inside `createApp()`** — if agentic is on without RAG configured, startup fails fast. Use `AGENTIC_ALLOW_NO_RAG=true` only in tests.
- **When agentic is enabled there is no legacy fallback.** Don't add one — see `docs/plans/agentic_only_rag_chat.md` for the invariant.
- **Server `npm test` is an explicit file list, not a glob.** New test files must be appended there; otherwise CI silently skips them.
- **Two env files have non-standard names** (`server.env`, `client.env`). They're loaded by code, not by tooling defaults — don't rename them without updating `loadEnv.ts` and `vite.config.ts`.
- **Agent architecture has two coexisting layers** (legacy handler orchestrator + agentic runtime). Confirm which layer you're in before editing; `docs/agents-architecture-inventory.md` §2–§4 maps every file to its role.
