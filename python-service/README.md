# python-service

FastAPI + Uvicorn data-operations service for the Marico RAG Insighting Tool.
Runs pandas/sklearn data ops (preview, transforms, type conversion, derived
columns, aggregation, ML training) and the MMM (marketing-mix-model) optimiser.
The Node `server/` tier calls it over HTTP (`PYTHON_SERVICE_URL`); on Vercel it
is wrapped by `api/data-ops/index.py`.

## Run locally

```bash
cd python-service
python3 -m venv .venv && source .venv/bin/activate    # optional
pip install -r requirements.txt
cp .env.example .env        # then edit (at minimum set PYTHON_SERVICE_API_KEY for non-local)
python3 main.py             # serves on :8001
```

## Layout

| File | Purpose |
|---|---|
| `main.py` | FastAPI app: routes, the internal-API-key gate, body-size limit, the MMM concurrency/timeout gate. |
| `config.py` | Env-driven config (`config` singleton). |
| `data_operations.py` | pandas data ops: preview, type conversion, derived columns (asteval-evaluated), aggregation, pivot, outlier treatment. |
| `ml_models.py` | sklearn/optional-lib model training. |
| `mmm/` | Marketing-mix-model: `transforms.py`, `fit.py`, `optimize.py`. |
| `tests/` | `python -m unittest discover -s tests` (run in CI). |

## Auth

When `PYTHON_SERVICE_API_KEY` is set, every request must send a matching
`X-Internal-Api-Key` header (constant-time compared). The Node tier sends the
same value. In production (`VERCEL` / `ENVIRONMENT=production` / `NODE_ENV=production`)
the service **refuses to start** without the key, so it is never world-accessible.

## Configuration

See `.env.example`. Key vars: `PYTHON_SERVICE_API_KEY` (auth), `PYTHON_SERVICE_PORT`,
`MAX_ROWS` / `MAX_PREVIEW_ROWS` (memory caps), `REQUEST_TIMEOUT`,
`ASTEVAL_MAX_TIME_SEC` (derived-column expression timeout), `CORS_ORIGINS`.

## Tests / lint

```bash
python -m unittest discover -s tests -v   # unit tests (MMM + data-ops coercion)
ruff check .                              # lint (blocking in CI)
mypy .                                    # type check (report-only)
```
