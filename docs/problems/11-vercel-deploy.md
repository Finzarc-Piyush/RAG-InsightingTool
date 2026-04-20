# 11 — Vercel & deployment topology

Wave 5.

---

### P-036 — `api/data-ops/index.py` sys.path munging is fragile

- **Severity:** medium
- **Category:** config / deployment
- **Location:** `api/data-ops/index.py:6-9`
- **Evidence:** Path to `python-service/` is computed from `__file__` and inserted at `sys.path[0]`. If the repo layout changes (rename, move), the wrapper silently imports the wrong module or the build succeeds with a stale module.
- **Fix:** After computing `PYTHON_SERVICE_DIR`, assert `os.path.isfile(os.path.join(PYTHON_SERVICE_DIR, "main.py"))` and raise a clear `RuntimeError` listing the attempted path if missing. Add one unit test that imports the wrapper from a clean CWD.
- **Status:** todo

### P-039 — `PYTHON_SERVICE_URL` production configuration not documented

- **Severity:** medium
- **Category:** docs (deployment)
- **Location:** `server/.env.example`; missing `docs/DEPLOY.md`
- **Evidence:** Default is `http://localhost:8001`. For Vercel-deployed Node API talking to a separately-deployed Python service (Railway, Fly, Azure Container Apps), there's no guidance on where the URL comes from or how to set it.
- **Fix:** Add `docs/DEPLOY.md` covering the 3-service topology, env var mapping per environment (local / staging / prod), and a sample Vercel project config for each half. Link from root `README.md` (see area 20).
- **Status:** todo

### P-068 — No root `vercel.json` coordinating multi-project deploy

- **Severity:** low
- **Category:** deployment
- **Location:** repo root
- **Evidence:** Only `client/vercel.json` exists. The monorepo has three services but only one Vercel config, so the deploy topology is implicit.
- **Fix:** Either (a) add two separate `vercel.json` files (root for API, `client/vercel.json` already covers SPA) plus matching Vercel project wiring, or (b) accept the two-project setup and document it explicitly in `docs/DEPLOY.md` (P-039).
- **Status:** todo
