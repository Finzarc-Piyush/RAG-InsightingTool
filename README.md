# RAG-InsightingTool

A three-service monorepo for agentic, retrieval-augmented data analysis over
user-uploaded datasets.

| Service | Stack | Port | Purpose |
|---------|-------|-----:|---------|
| `client/` | Vite + React 18 + TypeScript | 3000 | SPA; Azure MSAL auth; `wouter` routing; Tailwind + Radix UI; TanStack Query |
| `server/` | Node 20 + Express + TS via `tsx` | 3002 | REST + SSE API, chat orchestration, RAG, file parsing, DuckDB query execution |
| `python-service/` | FastAPI + Uvicorn | 8001 | Data operations (pandas / sklearn): preview, transforms, ML training |
| `api/` | Vercel serverless wrappers | — | `api/index.ts` wraps `server/createApp()`; `api/data-ops/index.py` wraps `python-service/main.py` |

## Quick start

```bash
# Python data-ops
cd python-service && pip install -r requirements.txt && python3 main.py  # :8001

# Node API (in another terminal)
cd server && npm ci && npm run dev                                        # :3002

# Vite SPA (in a third terminal)
cd client && npm ci && npm run dev                                        # :3000
```

Non-standard env files (loaded by code, not tooling defaults):

- `server/server.env` — copy from `server/.env.example`.
- `client/client.env` — copy from `client/client.env.example`.

See `CLAUDE.md` for the per-service conventions and `docs/DEPLOY.md` for the
multi-service Vercel topology.

## Key docs

- `CLAUDE.md` — architecture, dev loop, conventions that bite.
- `docs/agents-architecture-inventory.md` — canonical map of the legacy handler
  orchestrator and the agentic runtime.
- `docs/plans/agentic_only_rag_chat.md` — product invariants (RAG always on
  when agentic is on, no legacy fallback).
- `docs/architecture/upload_and_enrichment.md` — in-process upload queue and
  enrichment ordering.
- `PROBLEMS.md` — consolidated defect inventory driving the current cleanup.

## License

See `LICENSE` at the repo root.
