# Execution status — live

Updated after every commit during the audit-driven cleanup.
Last updated: Waves 0–5 complete on `claude/add-claude-documentation-PaA9h`.

## Closed

| ID | Title | Commit / file |
|----|-------|---------------|
| P-001 (HEAD) | `server/snowflake.log` untracked; gitignore expanded | Wave 0 |
| P-002 | `client/client.env` templated → `client.env.example`, tracked copy removed | Wave 0 |
| P-003 | `Infinity`→JSON leak in dataTransform.ts fixed via first-touch check | Wave 1 |
| P-004 | Snowflake `sharedConnectionPromise` single-flight; key includes role | Wave 1 |
| P-005 | `api/data-ops/requirements.txt` now `-r`'s python-service; CI gate added | Wave 1 / Wave 4 |
| P-006 | `coerce_numeric_with_warning` helper; wired into `aggregate_data` | Wave 1 |
| P-007 | Embedding-dim mismatch now throws | Wave 1 |
| P-008 | `chatWithAIStream` wall-clock timeout + terminal error SSE | Wave 2 |
| P-009 | `DISABLE_AUTH` hardened: prod refuse, dev token, audit log | Wave 2 |
| P-011 | Python CI job + requirements sync gate | Wave 4 |
| P-012 | `server/.env.example` regenerated (86 vars, grouped) | Wave 5 |
| P-013 | AuthContext 5s `isLoading` failsafe | Wave 2 |
| P-014 | TanStack Query defaults (5 min stale, retry 1, refetch on focus) | Wave 2 |
| P-015 | InsightCard bold → `text-foreground` | Wave 3 |
| P-016 | MSAL lazy singleton via `getMsalInstance()` | Wave 2 |
| P-017 | `useHomeMutations` aborts in-flight stream on unmount | Wave 2 |
| P-018 | `chatWithAIStream` validates payload → 400 | Wave 2 |
| P-019 | Upload cap dropped to `UPLOAD_MAX_BYTES` (200 MB default) | Wave 2 |
| P-020 | Agent replan budget promoted to `AgentConfig.maxReplansPerStep` | Wave 2 |
| P-021 | `completeJson` third minimal-schema pass | Wave 2 |
| P-022 | `deleteRagDocumentsBySessionId` fails on partial delete | Wave 1 |
| P-023 | Azure Search retry wrapper (exp backoff + jitter, 3 attempts) | Wave 2 |
| P-024 | `getDataForAnalysis` close-path narrowed + tolerant | Wave 1 |
| P-026 | `sendSSE` observes closed responses via WeakSet; `isSseClosed()` helper | Wave 2 |
| P-027 | `pythonServiceFetch` wrapper (timeout + guaranteed cleanup) | Wave 2 |
| P-028 | Pivot tempfile cleanup moved to `finally` | Wave 1 |
| P-030 | `sanitizeIdentifier` / `sanitizeStringLiteral` helpers; Snowflake ad-hoc escapes folded | Wave 1 |
| P-031 | Pre-auth per-IP limiter (`authPreflightLimiter`) | Wave 2 |
| P-033 | `server/tsconfig.json` (strict) + `npm run typecheck` script + CI step | Wave 4 |
| P-034 | LSTM/GRU now release TF resources in `finally` | Wave 2 |
| P-036 | Vercel wrapper asserts `python-service/main.py` exists | Wave 5 |
| P-037 | Python service refuses to boot without API key in prod | Wave 2 |
| P-038 | `@assets` alias removed from vite.config + tsconfig | Wave 3 |
| P-039 | `docs/DEPLOY.md` documents `PYTHON_SERVICE_URL` options | Wave 5 |
| P-040 | Root `.gitignore` expanded | Wave 0 |
| P-041 | README, LICENSE, CODEOWNERS, PR template added | Wave 5 |
| P-042 | `client/dist/` untracked | Wave 0 |
| P-043 | `npm run theme:check` in client CI | Wave 4 |
| P-044 | Python CORS default trimmed (no more localhost:5173) | Wave 5 |
| P-045 | Redirect effect guards against re-invoking `setLocation` | Wave 2 |
| P-046 | `acquireIdTokenForApi` emits `auth:token-failed` event on double-fail | Wave 2 |
| P-047 | `handleEditMessage` captures timestamp sync; no more `setTimeout(…, 0)` | Wave 2 |
| P-048 | SSE reader already in try/finally — verified, no change needed | Wave 2 |
| P-049 | HTTP retry drops aborted signal from cloned config | Wave 2 |
| P-054 | Dead server deps removed (`ws`, `passport*`, `memorystore`, etc.) | Wave 3 |
| P-055 | Dead Python deps removed (`matplotlib`, `seaborn`) | Wave 3 |
| P-057 | Server `npm test` file list reconciled; 6 missing files added; alphabetized | Wave 4 |
| P-060 | Blob Storage init memoized to fix first-use race | Wave 2 |
| P-065 | `AuthRedirectHandler` computes redirect flag synchronously | Wave 2 |
| P-066 | `.DS_Store` untracked | Wave 0 |
| P-067 | `.cursor/dev-logs/*.log` untracked + gitignored | Wave 0 |
| P-068 | Two-project Vercel topology documented in DEPLOY.md | Wave 5 |
| P-069 | `UserEmailDebug` deleted (unused) | Wave 3 |
| P-070 | False positive — `AvailableModelsDialog` IS used; finding closed | Wave 3 |
| P-071 | `main.tsx` throws clear error when `#root` missing | Wave 3 |
| P-072 | Legacy `/data-ops` `/modeling` redirects annotated | Wave 2 |
| P-078 | Stale IE11 comment removed from `msalConfig.ts` | Wave 3 |
| P-025 | Intermediate SSE preview clamped to `AGENT_INTERMEDIATE_PREVIEW_ROW_CAP` rows | PR B.5 |
| P-029 | Zod schemas + `parsePythonResponse()`; wired into `/preview` and `/aggregate` | PR B.1 |
| P-032 | `assertPlanColumnsAllowed` returns did-you-mean suggestions | PR A.4 |
| P-059 | `scripts/check-shared-schema-drift.mjs` landed (not yet CI-wired; surfaces real drift) | PR B.5 |
| P-073 | `console.*` → `logger.*` in `msalConfig.ts`, `AuthContext.tsx`, `envCheck.ts` | PR B.2 |
| P-074 | Verified: `httpClient.ts` DEV logger already scoped to method + route + status | PR B.2 |
| A.1 (query quality) | Upfront RAG hits injected into initial planner prompt | PR A.1 |
| A.2 (query quality) | RAG keyword-search fallback + content-hash dedup | PR A.2 |
| A.3 (query quality) | Reflector sees working-memory columns + 12k observation cap | PR A.3 |
| A.5 (query quality) | Deferred-chart drops now emit `deferredChart.dropped` agentLog | PR A.5 |
| Dashboard UX (cascade push) | Swap-on-collision via `resolveLayoutsDropBySwap`; stable re-layout helpers + unit tests | dashboard-ux-fix |
| Phase-1 1.A | `questionShape` + `candidateDriverDimensions` on `AnalysisBrief`; `intent_parsed` SSE | PR 1.A |
| Phase-1 1.B | `skills/` registry + planner manifest hook (flag-gated, zero behavior when off) | PR 1.B |
| Phase-1 1.C | `variance_decomposer` skill + agent-loop dispatch + `skill_execution` SSE | PR 1.C |
| Phase-1 1.D | `driver_discovery` skill | PR 1.D |
| Phase-1 1.E | Parallel step runner (`preResolveParallelSteps`) + `skill_parallel_batch` SSE | PR 1.E |
| Phase-1 1.F | Verifier completeness codes (`INCOMPLETE_DRIVERS`, `MISSING_DECOMPOSITION`, `MISSING_MAGNITUDES`) | PR 1.F |
| Phase-1 1.G | Rich envelope (`magnitudes`, `unexplained`) threaded synthesiser → persisted Message | PR 1.G |
| Phase-1 1.H (insight_explorer) | Auto-exploration skill for open prompts | PR 1.H |
| Phase-2 2.A | `DashboardSpec` schema + `POST /api/dashboards/from-spec` + client API | PR 2.A |
| Phase-2 2.B | Brief `requestsDashboard` trigger + `buildDashboard` module + `dashboard_draft` SSE | PR 2.B |
| Phase-2 2.C | Layout templates + inline `DashboardDraftCard` + "Create dashboard" CTA | PR 2.C |

## Partially addressed / deferred follow-ups

| ID | Status | Reason |
|----|--------|--------|
| P-001 (history) | deferred — runbook only | `git filter-repo` rewrites shared history; requires coordination (see `docs/problems/RUNBOOK-history-purge.md`) |
| P-010 | partial | Body-size middleware + `_with_training_gate` helper added; per-endpoint wiring of ~40 training routes deferred |
| P-029 | partial | Zod helper + schemas landed; wired into `/preview` and `/aggregate`. Remaining call sites migrate incrementally (same pattern). |
| P-035 | partial | `REQUEST_TIMEOUT` exists; actual `asyncio.wait_for` wrap per training handler deferred |
| P-050 | deferred | Message sliding window needs UX design for history-on-scroll |
| P-051 | partial | Top offender (`InsightCard`) fixed; the other tempDebt files (Dialog / FilterApplied / DashboardModal) still need refactors |
| P-052 | deferred | Hard-trim of the `theme-check.mjs` allowlist blocked on P-051 cleanups |
| P-053 | deferred | a11y audit pass (aria labels, focus restoration) |
| P-056 | deferred | Negative-path tests for chart compiler / RAG retrieve / Snowflake / SSE flusher |
| P-058 | partial | CSV diagnostics surface malformed rows; strict-first fallback not yet implemented |
| P-059 | partial | Drift-check script landed; CI wiring blocks on real reconciliation (`agentTrace` is client-only today) |
| P-061 | deferred | Per-batch CSV schema revalidation |
| P-062 | deferred | Vitest + `test` script in `client/` (new tooling) |
| P-063 | deferred | `postcss.config.js` vs Tailwind v4 assumptions |
| P-064 | deferred | Recharts chunk split (perf polish) |
| P-073 | partial | Auth-path swept; remaining DashboardModal / DataSummaryModal / DatasetEnrichmentLoader sweeps left |
| P-074 | done (verified already narrow) | `httpClient.ts` already logs method + route + status + request-id only |
| P-075 | deferred | Context value memoization |
| P-076 | deferred | `useSessionLoader` dep stabilization |
| P-077 | deferred | `client.env` → `.env.local` rename decision |

## Still exploratory (Section 21)

P-079 through P-086 remain as future audit tasks (no code change).
