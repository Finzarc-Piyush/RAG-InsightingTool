# 19 — Env, config & docs drift

Wave 5.

---

### P-012 — `server/.env.example` documents ~27 of ~78 env vars used

- **Severity:** high
- **Category:** docs drift
- **Location:** `server/.env.example`
- **Evidence:** Grep of `process.env.X` across `server/` yields ~78 unique names; `.env.example` lists ~27. Missing: all `AZURE_OPENAI_*`, all `COSMOS_*`, several `AZURE_STORAGE_*`, several `AGENT_*` (e.g. `AGENT_MAX_LLM_CALLS`, `AGENT_MAX_WALL_MS`, `AGENT_MAX_VERIFIER_ROUNDS_FINAL`, `AGENT_SAMPLE_ROWS_CAP`, `AGENT_OBSERVATION_MAX_CHARS`).
- **Fix:** Regenerate: `grep -rhoE 'process\.env\.[A-Z0-9_]+' server/ | sort -u`. Walk the list, add every var with a 1-line comment. Group by feature (`AZURE_AD_*`, `AZURE_OPENAI_*`, `COSMOS_*`, `AZURE_STORAGE_*`, `AZURE_SEARCH_*`, `SNOWFLAKE_*`, `AGENT_*`, `RAG_*`, `DIAGNOSTIC_*`).
- **Status:** todo

### P-059 — Cosmetic drift between `server/shared/schema.ts` and `client/src/shared/schema.ts`

- **Severity:** low
- **Category:** drift
- **Location:** `server/shared/schema.ts`, `client/src/shared/schema.ts`
- **Evidence:** Structural shapes match; JSDoc / comment content differs. Risk: one side gets a new field, the other doesn't notice.
- **Fix:** Either (a) treat one file as canonical and generate the other at build time, or (b) add a CI step that hashes both files (ignoring whitespace) and fails on divergence. (a) is cleaner if you're OK adding a small codegen script.
- **Status:** todo
