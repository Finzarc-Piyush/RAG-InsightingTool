# 01 — Secrets, credentials & committed leakage

Wave 0. Execute before any other fix — these stop bleeding.

---

### P-001 — `server/snowflake.log` (~350 KB) committed with credentials-adjacent data

- **Severity:** critical
- **Category:** secret leakage
- **Location:** `server/snowflake.log`, root `.gitignore`
- **Evidence:** File committed; contents include Snowflake usernames (e.g. `user: sameer raj`) and database name `MARICOINSIGHT`.
- **Fix:** Purge via `git filter-repo --path server/snowflake.log --invert-paths`. Add `*.log` to root `.gitignore`. Communicate force-push to collaborators. Rotate any Snowflake secret that can plausibly be inferred.
- **Status:** todo

### P-002 — `client/client.env` committed with real Azure AD tenant + client IDs

- **Severity:** critical
- **Category:** secret leakage (low-impact values, but still pins the repo to one tenant)
- **Location:** `client/client.env`, `client/vite.config.ts:9`
- **Evidence:** File tracked with `VITE_AZURE_CLIENT_ID=1e24c2a8-…`, `VITE_AZURE_TENANT_ID=5980857f-…`.
- **Fix:** Rename to `client/client.env.example` (template with placeholders), have `vite.config.ts` load `client.env` as it does today, and add `client/client.env` to `.gitignore`. Remove the current tracked copy with `git rm --cached client/client.env`.
- **Status:** todo

### P-042 — `client/dist/` tracked in git

- **Severity:** medium
- **Category:** repo hygiene (build artifact in VCS)
- **Location:** `client/dist/`
- **Evidence:** `git ls-tree` shows tracked `client/dist/index.html` + assets even though `client/.gitignore` contains `dist/`.
- **Fix:** `git rm -r --cached client/dist` and commit. Builds happen on deploy.
- **Status:** todo

### P-066 — `.DS_Store` tracked despite `.gitignore`

- **Severity:** low
- **Category:** repo hygiene
- **Location:** repo root
- **Evidence:** `.DS_Store` is in root `.gitignore` but file is still tracked (`git ls-tree -r HEAD | grep DS_Store`).
- **Fix:** `git rm --cached .DS_Store`.
- **Status:** todo

### P-067 — `.cursor/dev-logs/*.log` tracked (~76 KB, 3 files)

- **Severity:** low
- **Category:** repo hygiene
- **Location:** `.cursor/dev-logs/server.log`, `client.log`, `python-service.log`, `server 2.log`
- **Evidence:** IDE-generated dev logs committed.
- **Fix:** Add `.cursor/dev-logs/` to root `.gitignore`; `git rm --cached .cursor/dev-logs/*.log`.
- **Status:** todo
