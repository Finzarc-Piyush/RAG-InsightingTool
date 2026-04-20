# 09 — Python service — correctness

Wave 1 (P-005) + Wave 2 (P-037) + Wave 5 (P-044). P-006 lives in area 2.

---

### P-005 — `python-service/requirements.txt` vs `api/data-ops/requirements.txt` diverge

- **Severity:** critical
- **Category:** correctness (prod ImportError)
- **Location:** `python-service/requirements.txt`, `api/data-ops/requirements.txt`
- **Evidence:**
  - `fastapi 0.115.0 → 0.104.1`
  - `pandas 2.2.3 → 2.1.3`
  - `numpy 1.26.4 → 1.26.2`
  - `scikit-learn 1.5.2 → 1.3.2`
  - `pydantic ≥2.6.0 → 2.5.0`
  - **`asteval==1.0.6` missing entirely from wrapper** — derived-column creation does `from asteval import Interpreter` and will `ImportError` on Vercel.
- **Fix:** Make `python-service/requirements.txt` the single source of truth. Change `api/data-ops/requirements.txt` to `-r ../../python-service/requirements.txt` (or copy at build time via CI). Add a CI step that diffs them and fails if they disagree.
- **Status:** todo

### P-006 — Silent row drop via `to_numeric(errors='coerce')` (carried forward)

See `02-data-corruption.md`.

### P-037 — `PYTHON_SERVICE_API_KEY` not required in production

- **Severity:** medium
- **Category:** security (missing-key silently disables auth)
- **Location:** `python-service/config.py:24-25`; `python-service/main.py:71-76`
- **Evidence:** Comment says "If unset, key is not enforced"; middleware only enforces when `INTERNAL_API_KEY` is set. Forgetting to set the env in prod leaves the Python service world-accessible.
- **Fix:** Fail boot when `PYTHON_SERVICE_API_KEY` is unset AND the service detects it's on Vercel (e.g. `VERCEL=1`) or `ENV=production`. Log a loud single-line warning otherwise. Document the requirement in `server/.env.example` and the new `docs/DEPLOY.md` (area 11).
- **Status:** todo

### P-044 — CORS default includes unused `http://localhost:5173`

- **Severity:** low
- **Category:** config
- **Location:** `python-service/config.py:14`
- **Evidence:** Default list is `http://localhost:3000,http://localhost:5173`. The Vite client here runs on 3000; 5173 is a default from a different project template and adds surface area for nothing.
- **Fix:** Drop `http://localhost:5173`.
- **Status:** todo
