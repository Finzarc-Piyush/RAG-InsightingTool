# 08 — Server → Python bridge

Wave 2. Applies to `server/lib/dataOps/pythonService.ts`.

---

### P-027 — Python-service timeout does not abort streaming body

- **Severity:** medium
- **Category:** resource leak
- **Location:** `server/lib/dataOps/pythonService.ts:231-236, 284-293`
- **Evidence:** `setTimeout(() => controller.abort(), REQUEST_TIMEOUT)` is created but the `AbortSignal` is not attached to every `fetch` call consistently, and responses already streaming continue to consume bandwidth after abort.
- **Fix:** Attach `controller.signal` to the `fetch` call. On abort, explicitly destroy the response stream (`res.body?.cancel()`) and `clearTimeout`. Add a single wrapper helper so all callers get identical behavior.
- **Status:** todo

### P-029 — No Zod validation on Python-service responses

- **Severity:** medium
- **Category:** correctness
- **Location:** `server/lib/dataOps/pythonService.ts`
- **Evidence:** Responses from FastAPI are `JSON.parse`'d and cast to TS types; if the Python side returns an unexpected shape (e.g. during an error path or version skew), a call site deep in the stack crashes with an opaque error.
- **Fix:** Define a Zod schema per endpoint that matches the FastAPI pydantic model. Parse after `JSON.parse`. On failure, throw a structured `PythonServiceShapeError` with endpoint + path of violation.
- **Status:** todo
