# 06 — Snowflake & shared storage

Wave 1 (P-004) + Wave 2 (P-030) + Wave 5 (P-060).

---

### P-004 — Shared Snowflake connection not concurrency-safe; cache key incomplete

- **Severity:** critical
- **Category:** correctness
- **Location:** `server/lib/snowflakeService.ts:133-150` (module-level `sharedConnection`), `:136-138` (`connectionConfigKey`)
- **Evidence:** Module-global connection reused across concurrent requests; `connectionConfigKey()` hashes only `account|username|warehouse`, so different databases/schemas collide on the same socket.
- **Fix:** Switch to a connection pool keyed on the full tuple (`account|username|warehouse|database|schema|role`). Start with a tiny pool (e.g. 3) and tune under load. Document that the Snowflake SDK is not safe for concurrent `execute()` on one connection.
- **Status:** todo

### P-030 — Snowflake identifier escaping is inconsistent

- **Severity:** medium
- **Category:** security (injection surface, though currently exploited nowhere)
- **Location:** `server/lib/snowflakeService.ts:211, 240-244, 287-291`
- **Evidence:** Some sites escape `"` via doubling; others escape `'`. Pattern is copy-paste-prone.
- **Fix:** One `sanitizeIdentifier(name: string)` helper that always double-quotes and doubles embedded `"`; one `sanitizeStringLiteral(value: string)` helper for single-quoted literals. Grep-replace all ad-hoc escapes.
- **Status:** todo

### P-060 — Blob Storage initialization is fire-and-forget

- **Severity:** low
- **Category:** init race
- **Location:** `server/index.ts:57`
- **Evidence:** Init Promise is chained with `.catch(warn)` but nothing awaits it. First upload within a few ms of boot can 500.
- **Fix:** Make `getBlobServiceClient()` lazy-init on first use so callers implicitly await initialization; keep the startup attempt for fast failure logs.
- **Status:** todo
