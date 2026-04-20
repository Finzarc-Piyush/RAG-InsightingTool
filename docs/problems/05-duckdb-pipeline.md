# 05 — DuckDB & data pipeline

Wave 1 (P-024) + Wave 2 (P-019, P-028). P-003, P-058, P-061 live in area 2.

---

### P-019 — 1 GiB in-memory upload via multer `memoryStorage()`

- **Severity:** medium
- **Category:** resource (OOM risk)
- **Location:** `server/routes/upload.ts:11-12`
- **Evidence:** `fileSize: 1024 * 1024 * 1024` + `multer.memoryStorage()`. Two concurrent max-size uploads will OOM the Node process.
- **Fix:** Drop the cap to ~200 MB (matches realistic dataset sizes) and/or switch to `multer.diskStorage()` with a streamed parse into the existing file-parser pipeline.
- **Status:** todo

### P-024 — DuckDB `storage.close()` cleanup path fragile

- **Severity:** medium
- **Category:** resource leak
- **Location:** `server/lib/largeFileProcessor.ts:101-127`
- **Evidence:** `await storage.close()` in `finally`, but if the error is thrown before `storage` is fully initialized the `finally` can attempt to close a partially-initialized resource. Over time, failed requests leak file handles.
- **Fix:** Narrow the `try { … } finally { storage.close(); }` to the smallest critical section where `storage` is guaranteed non-null. Make `close()` idempotent if it isn't already.
- **Status:** todo

### P-028 — Pivot temp-file leak: cleanup only in catch

- **Severity:** medium
- **Category:** resource leak
- **Location:** `server/lib/dataOps/pythonService.ts:694-715`
- **Evidence:** `fs.unlinkSync(tempFile)` appears in the catch branch only; a happy-path early return or an error after the write-but-before-use leaves `/tmp` files stranded.
- **Fix:** Move the unlink into a `finally` block that runs regardless of outcome. Add a `process.on('exit', …)` best-effort cleanup for leftover temp files matching the prefix.
- **Status:** todo
