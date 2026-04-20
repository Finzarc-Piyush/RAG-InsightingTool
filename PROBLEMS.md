# Codebase problems

Master index of defects found across the repo. Each area has its own file under
`docs/problems/`. 86 findings, deduplicated from three independent audits.

## How to use

- Each finding has a stable ID (`P-NNN`), severity, category, location, evidence,
  fix sketch, and status (`todo` / `in-progress` / `done` / `wont-fix`).
- Work waves top-down. Within a wave, the areas listed run in order.
- When finishing a finding, flip its status in-place in the area file.

## Areas

| # | Area | File |
|---|------|------|
| 1 | Secrets, credentials, committed leakage | [docs/problems/01-secrets.md](docs/problems/01-secrets.md) |
| 2 | Data-corruption & silent-drop bugs | [docs/problems/02-data-corruption.md](docs/problems/02-data-corruption.md) |
| 3 | Agent runtime correctness | [docs/problems/03-agent-runtime.md](docs/problems/03-agent-runtime.md) |
| 4 | RAG pipeline | [docs/problems/04-rag.md](docs/problems/04-rag.md) |
| 5 | DuckDB & data pipeline | [docs/problems/05-duckdb-pipeline.md](docs/problems/05-duckdb-pipeline.md) |
| 6 | Snowflake & shared storage | [docs/problems/06-snowflake-storage.md](docs/problems/06-snowflake-storage.md) |
| 7 | Auth & middleware (server) | [docs/problems/07-server-auth.md](docs/problems/07-server-auth.md) |
| 8 | Server → Python bridge | [docs/problems/08-python-bridge.md](docs/problems/08-python-bridge.md) |
| 9 | Python service — correctness | [docs/problems/09-python-correctness.md](docs/problems/09-python-correctness.md) |
| 10 | Python service — resource & concurrency | [docs/problems/10-python-resources.md](docs/problems/10-python-resources.md) |
| 11 | Vercel & deployment topology | [docs/problems/11-vercel-deploy.md](docs/problems/11-vercel-deploy.md) |
| 12 | Client — auth & routing | [docs/problems/12-client-auth-routing.md](docs/problems/12-client-auth-routing.md) |
| 13 | Client — Home/chat surface | [docs/problems/13-client-home-chat.md](docs/problems/13-client-home-chat.md) |
| 14 | Client — TanStack Query & HTTP | [docs/problems/14-client-query-http.md](docs/problems/14-client-query-http.md) |
| 15 | Client — theming & a11y | [docs/problems/15-client-theming-a11y.md](docs/problems/15-client-theming-a11y.md) |
| 16 | Client — build & bundle hygiene | [docs/problems/16-client-build.md](docs/problems/16-client-build.md) |
| 17 | Dead code & unused deps | [docs/problems/17-dead-code-deps.md](docs/problems/17-dead-code-deps.md) |
| 18 | Tests & CI gaps | [docs/problems/18-tests-ci.md](docs/problems/18-tests-ci.md) |
| 19 | Env, config & docs drift | [docs/problems/19-env-docs-drift.md](docs/problems/19-env-docs-drift.md) |
| 20 | Repo hygiene & governance | [docs/problems/20-repo-hygiene.md](docs/problems/20-repo-hygiene.md) |
| 21 | Unexplored / follow-up audits | [docs/problems/21-unexplored.md](docs/problems/21-unexplored.md) |

## Execution waves

Each wave is a coherent set of PRs. Do not start a later wave before the earlier
one lands — earlier waves unblock the later ones and reduce merge conflict risk.

- **Wave 0 — Secret / credential hygiene.** Stop the bleeding. Area 1 + parts of 20.
- **Wave 1 — Data-corruption fixes.** Quiet killers. Area 2, plus related items in
  areas 4, 5, 6, 9.
- **Wave 2 — Hardening & safety.** Won't corrupt data, but will hang / leak /
  over-trust. Areas 3, 7, 8, 10, 12, 13, 14.
- **Wave 3 — Dead code & unused deps.** Shrinks blast radius. Area 17 + cleanup
  items in 16.
- **Wave 4 — Tests & CI.** Lock in the preceding waves. Area 18, plus theming CI
  gate from 15.
- **Wave 5 — Docs, governance, hygiene.** Onboarding & drift. Areas 11, 19, 20 +
  remaining items in 15.
- **Wave 6 — Re-audit.** Area 21, only if any items are still worth chasing.

## Decisions locked in (from initial scoping)

1. `server/snowflake.log` will be purged from git history via `git filter-repo`.
   A collaborator re-sync note will accompany the purge.
2. Dead deps with zero imports will be removed outright (no grace period for
   `drizzle-orm`, `@neondatabase/serverless`, `passport*`, `memorystore`,
   `connect-pg-simple`, `ws`).
3. `server/tsconfig.json` will ship with `strict: true` from the start; the
   errors it surfaces will be fixed in the same PR.
4. Unexplored audit items remain in this set as area 21 (not a separate file
   tree).

## Counts

- Critical: 6
- High: 11
- Medium: 36
- Low: 33
- **Total: 86**
