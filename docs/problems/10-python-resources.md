# 10 — Python service — resource & concurrency

Wave 2.

---

### P-010 — No resource caps on Python endpoints

- **Severity:** high
- **Category:** resource / DoS surface
- **Location:** `python-service/main.py` (all routes); `python-service/ml_models.py` (training routes)
- **Evidence:** `MAX_ROWS=1M` is enforced, but: no request-body size cap (a 500 MB JSON passes through); no per-endpoint timeout (a long LSTM/GRU run hangs a worker for hours); no concurrency cap (10 concurrent training jobs each allocate gigabytes).
- **Fix:** (a) body-size middleware (~50 MB default, configurable); (b) wrap training endpoints in `asyncio.wait_for(…, REQUEST_TIMEOUT)` with a clear 408 on timeout; (c) a module-level `asyncio.Semaphore(MAX_CONCURRENT_TRAINING)` that returns 503 when saturated.
- **Status:** todo

### P-034 — LSTM / GRU sessions not cleaned up

- **Severity:** medium
- **Category:** memory leak
- **Location:** `python-service/ml_models.py:2724-2815` (`train_lstm`), `:2818-2909` (`train_gru`)
- **Evidence:** `Sequential([...])` models retained in memory after the function returns metrics; no `tf.keras.backend.clear_session()`, no `del model`. With repeated training requests, RAM + GPU memory climb.
- **Fix:** Wrap the body in `try / finally` that calls `tf.keras.backend.clear_session()` and `del model`. Log RSS before/after in dev to confirm recovery.
- **Status:** todo

### P-035 — No per-endpoint timeout on `/train-model/*`

- **Severity:** medium
- **Category:** timeout / resource
- **Location:** `python-service/main.py` (training routes)
- **Evidence:** `REQUEST_TIMEOUT=300` exists in `config.py` but isn't enforced at the handler level.
- **Fix:** Same as P-010's (b): `asyncio.wait_for(handler_body, REQUEST_TIMEOUT)` for every training endpoint; return 408 on trip.
- **Status:** todo
