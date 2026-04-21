# Deployment (Vercel)

The repo ships three services but deploys as **two Vercel projects**:

1. **SPA project** — root = `client/`. Uses `client/vercel.json` (SPA rewrite + immutable asset cache).
2. **API project** — root = repo root. Uses `api/index.ts` (Node/Express → wraps `server/createApp()`) and `api/data-ops/index.py` (Python/FastAPI → wraps `python-service/main.py`).

There is no root `vercel.json` because Vercel treats each project independently.
If you want to change that (e.g. one project, two runtimes), add root `vercel.json`
with explicit `functions` + `builds` entries.

## Env var matrix

### SPA project (client)

| Var | Purpose |
|-----|---------|
| `VITE_AZURE_CLIENT_ID` | Azure AD SPA app client ID. |
| `VITE_AZURE_TENANT_ID` | Azure AD tenant. |
| `VITE_API_URL` | Base URL of the API project. Omit in local dev to use the Vite proxy. |

Populate from `client/client.env.example`.

### API project (server)

All variables documented in `server/.env.example`. Minimum required in production:

- Auth: `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`.
- Azure OpenAI (chat): `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT_NAME`.
- Azure OpenAI (embeddings, when `RAG_ENABLED=true`): `AZURE_OPENAI_EMBEDDING_ENDPOINT`, `AZURE_OPENAI_EMBEDDING_API_KEY`, `AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME`, `AZURE_OPENAI_EMBEDDING_DIMENSIONS`.
- Azure AI Search (same condition): `AZURE_SEARCH_ENDPOINT`, `AZURE_SEARCH_ADMIN_KEY`, `AZURE_SEARCH_INDEX_NAME`.
- Cosmos: `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE_ID`, `COSMOS_CONTAINER_ID`, plus the three shared/dashboard container vars.
- Blob: `AZURE_STORAGE_ACCOUNT_NAME`, `AZURE_STORAGE_ACCOUNT_KEY`, `AZURE_STORAGE_CONTAINER_NAME`.
- Python bridge: **`PYTHON_SERVICE_URL`** (see below) and **`PYTHON_SERVICE_API_KEY`** (required in prod, P-037).

### Python function (bundled inside the API project under `api/data-ops/`)

Its env is the API project's env (Vercel passes everything through).

## `PYTHON_SERVICE_URL` — where does Node find Python?

Two options:

- **Same Vercel project**: both Node and Python are under `api/`, so the Python function is reachable as `https://<your-domain>/api/data-ops`. Set `PYTHON_SERVICE_URL=https://<your-domain>/api/data-ops`. This is the default Vercel setup.
- **Separate host** (Railway, Fly, Azure Container Apps): set `PYTHON_SERVICE_URL=https://<python-host>/` and configure matching `PYTHON_SERVICE_API_KEY` on both sides.

## Requirements sync

`api/data-ops/requirements.txt` is intentionally a single line:

```
-r ../../python-service/requirements.txt
```

CI (`.github/workflows/ci.yml` → `python` job) fails the build if this line
changes or if the two files drift apart (P-005).

## Git history — snowflake.log purge

Before rolling any new production deploy from a freshly-cloned host, run the
steps in `docs/problems/RUNBOOK-history-purge.md` to remove the committed
log blob from reachable history.
