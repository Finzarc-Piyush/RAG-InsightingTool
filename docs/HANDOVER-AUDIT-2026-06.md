# Handover Audit — Marico RAG-InsightingTool

> **Date:** 2026-06-21 · **Method:** fresh multi-agent code-level audit (10 parallel dimension agents + direct code/git verification of every critical claim) · **Scope:** server / client / python-service (~311K LOC, 3 services).
> **Deliverable type:** assessment only — no code or git history was modified by this audit.
> **Handover shape:** new owner receives a **clean / squashed copy** → git-history purge is **not** required; live-credential and ownership rotation **is**.

---

## TL;DR — Pre-handover blockers (act on these; everything else is optional)

The code is in good shape. The blockers are **operational, not code**:

1. **Rotate every live credential** before transfer (they were never in git, but the running deployment's keys are known to the current owner). → §7.
2. **Transfer ownership identity:** the superadmin allowlist hardcodes `piyush@finzarc.com` (`server/lib/superadmin.ts:26`), `.github/CODEOWNERS` is `@finzarc-piyush`, and `SECURITY.md` routes there. Re-point all three. → §7.
3. **Set production config the defaults leave open:** `BUDGET_GATE_ENFORCEMENT=enforce` (defaults to `warn_only` — no hard per-user cost cap until set), and confirm `PYTHON_SERVICE_API_KEY` / `DISABLE_AUTH` posture. → §3, §7.
4. **Write the human operator docs that don't exist yet:** `HANDOVER.md`, an operations runbook, per-service READMEs, an env/deploy checklist, and a feature-flag reference. The existing docs are excellent but written **for Claude Code, not a human on-call team**. → §6.

There are **no live security holes** and **no must-fix code bugs gating the handover.** Optional code spot-checks (medium confidence) are in §5b.

---

## 1. Executive summary

This codebase was **not** what the starting context implied. A prior 53-agent expert audit (2026-06-15) graded it **C+** with 110 findings — but that audit has since been **substantially remediated**, and the remediation is **honestly tracked and verifiable in code**, not just claimed.

The authoritative record is [`docs/expert-audit/REMEDIATION-TRACKER.md`](expert-audit/REMEDIATION-TRACKER.md): **98 of 110 findings DONE (89%), 12 PARTIAL (11%)**. I independently verified a representative, high-stakes sample against code and git — the IDOR fix, the admin-endpoint gate, auth-bypass hardening, the budget gate, the Python boolean-coercion bug, the type-escape ratchet, the partition-key deferral — and **the tracker is accurate**. The 12 PARTIAL items are not unfinished sloppiness; they are **deliberately deferred** god-file decompositions (behind characterization-test safety nets, "code-motion ceiling reached") and **infra/decision-gated** scale migrations, each with a written migration path in [`docs/decisions/infra-migrations.md`](decisions/infra-migrations.md).

**Verified current engineering grade: ~B+ / A-** (up from C+). Security, type-safety, error-handling, observability, API design, build/CI, config/secrets, and Python correctness all reconcile to **DONE**. What holds it just below "A" is concentrated and known: a few god-files still awaiting a reviewed control-flow restructure, and the multi-tenant scale migrations (partition key, durable upload runner, Parquet read path) that can't be flipped blind on live infra.

**The real handover risk is elsewhere:** the project is documented *for an AI pair-programmer* (CLAUDE.md routing index, `/orient` /`/wave-commit` skills, wave cadence, generated registries) and is **missing the human-facing operational layer** a new team needs to stand it up, deploy it, and keep it alive at 2 AM. That — plus credential/ownership rotation — is the work between here and a clean handover.

### How to read this report
- §2 = the trust anchor (what's actually fixed vs deferred).
- §3 = dimension scorecard.
- §4 = the 12 known-deferred debt items (accepted, documented).
- §5 = fresh-audit findings: (a) corrections to false alarms, (b) candidate residuals to spot-check.
- §6 = handover-readiness doc gaps + artifacts to create.
- §7 = credential & ownership rotation checklist.
- §8 = recommended sequence.
- §9 = methodology & confidence.

---

## 2. State of prior remediation (the trust anchor)

Source of truth: [`docs/expert-audit/REMEDIATION-TRACKER.md`](expert-audit/REMEDIATION-TRACKER.md) (last synced 2026-06-17). Per-dimension completion:

| Dimension (prior grade) | Done | Status |
|---|---|---|
| Architecture & Modularity (C+) | 5/8 | 3 PARTIAL = god-files / cycles (deferred, gated) |
| Code Quality (C+) | 6/8 | 2 PARTIAL = same god-files |
| Type Safety (B-) | **7/7** | ✅ ratchet + persisted-read validation + `noUncheckedIndexedAccess` |
| Testing (B-) | **7/7** | ✅ coverage measured, write-seam/auth tests, python in CI, HTTP integration |
| Security (B+) | **6/6** | ✅ IDOR, central tenant-scoping, auth-bypass, constant-time key, admin gate, quota |
| Error Handling (B) | **5/5** | ✅ abort propagation, Cosmos retry policy, error envelopes |
| Performance (C) | 7/10 | 3 PARTIAL = full-rehydration / Parquet read path / shared rate-limiter (infra-gated) |
| Observability (C+) | **7/7** | ✅ structured logs + traceId, PII redaction, access logs, client telemetry, APM tier |
| API Design (C+) | **9/9** | ✅ ZodError→400, SSE registry, response envelopes, pagination |
| Data Layer & Concurrency (C+) | 4/7 | 3 PARTIAL = partition key / durable upload / deterministic doc-id (infra-gated) |
| Frontend / React (C+) | 6/7 | 1 PARTIAL = god-components |
| Documentation (B) | **5/5** | ✅ env-var docs, python README, ci-and-env corrections |
| Build / CI / Deps (B-) | **10/10** | ✅ test typecheck, python CI, formatter, blocking lint, coverage, node pin |
| Config & Secrets (C+) | **5/5** | ✅ central typed config, superadmin→env-overridable, flag registry |
| Python Service (C+) | **9/9** | ✅ async offload, missing-deps, boolean bug, asteval, error leak, CORS |

**Spot-checks I ran directly (all confirm the tracker):**
- **SEC-1 IDOR — FIXED.** `getUploadStatus` computes `requesterEmail` and enforces ownership before returning job status (`server/controllers/uploadController.ts`, DATA-2 ownership block ~line 151–212).
- **SEC-6 admin endpoint — FIXED.** `router.get('/upload/queue/stats', requireSuperadmin, getQueueStats)` (`server/routes/upload.ts:69`). *(One Round-1 agent wrongly called this open by reading only the controller body and missing the route-level `requireSuperadmin` middleware — see §5a.)*
- **SEC-3 DISABLE_AUTH — FIXED.** Refused unless `NODE_ENV` is explicitly `development`/`test` **and** not on Vercel, **and** requires the `AUTH_BYPASS_DEV_TOKEN` sentinel — fail-closed (`server/middleware/azureAdAuth.ts:139–184`).
- **SEC-4 budget gate — FIXED (default `warn_only`).** `server/middleware/budgetGate.ts:42`. Note: `warn_only` is not a hard cap — set `enforce` for production (§7).
- **PY-5 boolean coercion — FIXED.** `astype(bool)` replaced by explicit token mapping `_BOOLEAN_TRUTHY_TOKENS` (`python-service/data_operations.py:26, 106, 1646`); the three `astype(bool)` hits remaining are *comments warning against it*.
- **TYPE-4 type-escape ratchet — FIXED.** `server/scripts/check-type-escapes.ts` fails CI if the count exceeds a committed baseline (current server: 104 `as any` + 49 `as unknown as`; capped & ratchets down).
- **DATA-1 partition key — STILL PARTIAL (as documented).** Container is still partitioned on `/fsmrora` (username) while the hot path queries by `sessionId` (`server/models/database.config.ts:172`); deliberately deferred per `infra-migrations.md` (a live container's partition key is immutable).

**Bottom line:** the "P0 security + CI/logging waves shipped" note in project memory is **true and verifiable**. Treat the tracker as reliable.

---

## 3. Dimension scorecard (verified, this audit)

| Dimension | Prior | **Now** | One-line rationale |
|---|:--:|:--:|---|
| Security | B+ | **A-** | IDOR closed, central tenant-scoping, fail-closed bypass, admin gated. Residual handover action: rotate superadmin owner; set budget `enforce`. |
| Type Safety | B- | **A-** | Persisted-read Zod validation + escape ratchet + strict index access all shipped. |
| Error Handling | B | **A-** | Abort propagation, Cosmos retry policy, typed error envelopes. |
| Observability | C+ | **A-** | Structured JSON logs + traceId in ALS, PII redaction, access logs, client error sink. (No external aggregator wired — Sentry optional.) |
| API Design | C+ | **B+** | Shared `responseFormatter`, SSE registry, pagination. Possible residual in `dashboardController` error-status mapping (§5b). |
| Build / CI / Deps | B- | **A-** | Blocking lint, python CI, test typecheck, coverage, node pin, Dependabot. Watch transitive npm-audit items (§5b). |
| Config & Secrets | C+ | **B+** | Central typed config + boot validation; superadmin env-overridable (rotate on handover). |
| Testing | B- | **B+** | Write-seam/auth/HTTP tests, python in CI, coverage measured (not a *blocking threshold* — defensible). |
| Documentation (code) | B | **B** | `.env.example`/code docs complete. **Human operator docs missing** — scored separately in §6. |
| Performance | C | **B-** | Over-fetch fixes + compression shipped; full-rehydration/Parquet read path remain PARTIAL (infra-gated). |
| Frontend / React | C+ | **B-** | Memoization + query-key + a11y fixes shipped; god-components remain PARTIAL. |
| Architecture | C+ | **B** | Schema split, dead-code removal, service-boundary done; 2 god-files + cycles PARTIAL. |
| Code Quality | C+ | **B** | dataOps god-file decomposed; agentLoop/DataPreviewTable awaiting reviewed restructure. |
| Data Layer & Concurrency | C+ | **B-** | ETag write-safety + turn-guard done; partition key / durable upload / doc-id PARTIAL (infra-gated). |
| Python Service | C+ | **B** | All 9 prior findings done; 2 candidate residuals to spot-check (§5b). |

**Overall: C+ → ~B+/A- engineering.** Gated to "clean handover" by §6 (docs) and §7 (credentials/ownership), not by code.

---

## 4. Known deferred debt — the 12 PARTIAL items (accepted & documented)

These are **not** new findings and **not** blockers. They are tracked, justified, and have written migration paths. A new owner should *inherit them as a roadmap*, not treat them as surprises. Full rationale: [`REMEDIATION-TRACKER.md`](expert-audit/REMEDIATION-TRACKER.md) §"The 12 PARTIAL findings" and [`infra-migrations.md`](decisions/infra-migrations.md).

**God-file decomposition (test-first; "code-motion ceiling reached"):**
- **ARCH-1 / CQ-1** — `agentLoop.service.ts` (`runAgentTurn`, ~3.6K-line orchestrator). Decomposed to 8 sibling modules behind a 5-shape characterization gate; the remaining step-loop body needs a *reviewed control-flow restructure*, not more code-motion.
- **ARCH-5 / CQ-3 / FE-2** — `DataPreviewTable.tsx` (~3.2K-line component). useState 37→23, reducer + hooks + sub-components extracted behind a 5-flow interaction gate; `pivotConfig`/`filterSelections` fold remains.
- **ARCH-3** — 17 server circular deps masked by dynamic `import()`; type-edges reduced, runtime cycle-breakers documented in [`import-cycles.md`](decisions/import-cycles.md).

**Infra / decision-gated scale migrations (do NOT flip blind on live multi-tenant infra):**
- **DATA-1** — Cosmos partition key `username`→`sessionId` (immutable in place → needs new container + dual-write + backfill).
- **DATA-2** — durable upload **runner** (status is already instance-independent; the worker needs a real queue).
- **DATA-6** — deterministic doc `id == sessionId` (migration-sensitive core create/read path).
- **PERF-1 / PERF-2** — Parquet **read** path stays flag-OFF pending the DuckDB httpfs spike on the Vercel host (write path is wired).
- **PERF-7** — per-instance in-memory rate-limiter/job-state needs a shared store (Redis/Cosmos) for serverless.

> These are the right calls. Flipping any of them autonomously on a running multi-tenant system risks losing chat history, double-processing uploads, or weakening an abuse limiter. Leave them staged; execute behind infra + product sign-off.

---

## 5. Fresh-audit findings

### 5a. Corrections — false alarms from the dimension pass (do NOT action)

The fresh agents were seeded with the *original* C+ audit framing, so several "confirmed" issues that are in fact fixed. Recording them so they aren't re-raised:

| Claim raised | Reality (verified) |
|---|---|
| "`server/server.env` is a committed secret leak (CRITICAL)" | **False.** `git log --all` shows **0 commits** ever touched it. It exists only as a local untracked working file. The live keys were never in git. |
| "`getQueueStats` is open to any authenticated user" | **False.** Gated by `requireSuperadmin` at the route (`server/routes/upload.ts:69`); the agent read only the controller. |
| "Server has 0 `as any` (all removed)" | **False.** ~104 `as any` + 49 `as unknown as` remain — but they're **capped by a CI ratchet**, which is the actual control (and is what TYPE-4 asked for). |
| "`uploadQueue.ts` does bare last-writer-wins upserts" | **Unsubstantiated.** `uploadQueue.ts` contains **no Cosmos upserts at all**; persistence routes through the `mutateChatDocument` ETag seam (DATA-3 DONE). |
| "Cosmos read validation is asymmetric / unvalidated (HIGH)" | TYPE-1 is marked DONE; persisted-read Zod schemas exist. Treat as fixed unless a spot-check shows a specific unvalidated `.read()` path. |

**Lesson for the new owner:** when an agent (or a quick scan) flags a "leak" or "open endpoint," confirm against `git log --all` / route middleware before acting. Working-tree files ≠ git history; controller bodies ≠ the full middleware chain.

### 5b. Candidate residuals — medium confidence, spot-check before acting

These surfaced in the fresh pass and are **not clearly covered** by a tracker item. I did **not** independently confirm each to the depth of §2, so treat them as "verify, then fix if real" — none is a handover blocker.

| ID | Finding | Evidence (verify here) | Severity | Effort |
|---|---|---|---|---|
| **PY-a** | `remove_nulls(method="mean"/"median")` on an object column coerces unparseable strings to NaN **without** the warning that `convert_type` emits → silent numeric data loss. | `python-service/data_operations.py` ~ line 451 (`pd.to_numeric(..., errors="coerce")` with no before/after null delta). | Med | ~15 min |
| **PY-b** | `identify_outliers` / `treat_outliers` endpoints are **not** wrapped in `_with_training_gate` (no timeout / concurrency cap) while `aggregate`/`pivot`/`train` are → a 1M-row LOF can starve the worker pool. | `python-service/main.py` ~ lines 552, 580 vs the gated pattern at ~488. | Med (DoS-ability) | ~10 min |
| **API-a** | `dashboardController` catch blocks may still map non-Zod errors (Cosmos timeout / 412) to HTTP 400, and detect 409 via `message.includes('already exists')`. API-1/API-5 shipped a shared `responseFormatter`, but this controller may not use it everywhere. | `server/controllers/dashboardController.ts` catch blocks. | Low-Med | Low |
| **DEP-a** | `npm audit` reportedly surfaces high/moderate transitive vulns (form-data CRLF, multer DoS, uuid bounds via exceljs). CI gates `--audit-level=high`, so if CI is green these are either below threshold or freshly disclosed — confirm and patch/track. | `cd server && npm audit` / `cd client && npm audit`; Dependabot PRs. | Low-Med | Low-Med |
| **OBS-a** | Client error sink + cost telemetry exist, but **no external aggregator** (Sentry) is wired by default → frontend crashes live only in server logs, no alerting. | `client/src/lib/errorSink.ts`, `server/routes/clientError.ts`; `SENTRY_DSN` optional. | Low (operability) | Low |

> Quickest path: fix **PY-a** and **PY-b** (≈25 min combined, clear correctness/DoS wins), confirm **DEP-a** via `npm audit`, and decide on **OBS-a** as part of the ops setup (§6).

---

## 6. Handover-readiness gaps — the real work (human operator layer)

The repo's documentation is genuinely strong **for an AI pair-programmer**: a routing-index `CLAUDE.md`, 12 architecture deep-docs, ~18 ADRs, a generated registry/symbol index, a 47-flag typed registry (`server/lib/featureFlags.ts`), and a 372-line `server/.env.example`. A new **human team** cannot operate from these alone. Readiness by dimension:

| Area | Status | Gap a new owner hits |
|---|---|---|
| Human onboarding | **PARTIAL** | Top-level `README.md` + `python-service/README.md` exist; **no `server/`, `client/`, `api/` READMEs**, no prose "clone → configure → run → deploy" guide, no troubleshooting. CLAUDE.md is AI-routing, not human onboarding. |
| Env setup | **PARTIAL** | `.env.example` is exhaustive but there's no **checklist mapping each var → where to get it / required-in-prod / must-match-across-services** (e.g. client `VITE_AZURE_CLIENT_ID` ↔ server `AZURE_AD_CLIENT_ID`; `VITE_DEV_API_PORT` ↔ `PORT`). |
| Deployment | **PARTIAL** | `docs/DEPLOY.md` describes the two-project Vercel topology but has **no step-by-step setup, pre/post-deploy smoke test, rollback procedure, or cron (`CRON_SECRET`) setup**. |
| Operational runbook | **MISSING** | Only `RUNBOOK-history-purge.md` (and it's now N/A for a squashed handover). **No incident playbook** (Cosmos throttled / Azure OpenAI rate-limited / python timeout / DuckDB OOM), no health-check guide, no log-query guide, no alert thresholds, no escalation. |
| Feature flags | **PARTIAL** | The registry is in *code*; there's **no human-readable `FEATURE_FLAGS.md`** with default / what-it-gates / cost / safe-in-prod, and no rollout/deprecation guidance (e.g. `DASHBOARD_AUTOGEN_ROLLOUT_PCT`). |
| License / IP / ownership | **PRESENT, needs transfer** | Proprietary `LICENSE` ✓, `CODEOWNERS` + `SECURITY.md` ✓ — but all point at the current owner; **no ownership-transfer runbook**. → §7. |
| Architecture docs | **PRESENT** | 12 deep-docs + ADRs, current. Missing only a one-page **human system-overview / topology diagram** entry point. |

**Artifacts to create before handover (Tier 1 = blockers, Tier 2 = strongly recommended):**

- **Tier 1**
  - `docs/HANDOVER.md` — clone → configure → run → deploy, credential checklist, cross-service value matching, on-call basics.
  - `docs/OPERATIONS.md` — incident playbook (5–6 common failures + fixes), health checks (`/api/health`, `/api/ready`, python `/health`), log format + how to query by `traceId`/`sessionId`, alert thresholds.
  - `docs/FEATURE_FLAGS.md` — generated/derived from `server/lib/featureFlags.ts`: flag · default · gates · deps · cost · safe-in-prod.
  - `docs/ENV-CHECKLIST.md` — per-credential source + verify step + required/optional + must-match pairs.
  - Updated `.github/CODEOWNERS` + `SECURITY.md` contact (§7).
- **Tier 2**
  - `server/README.md`, `client/README.md`, `api/README.md` (quickstart + config pointers).
  - Expand `docs/DEPLOY.md` with Vercel walkthrough, pre/post-deploy smoke tests, rollback.
  - One-page system topology diagram (SPA ↔ server ↔ python; Cosmos / Blob / Search / OpenAI).

---

## 7. Credential & ownership rotation checklist (the #1 actual blocker)

Live secrets were **never committed** (verified), so there is nothing to purge — but the current owner *knows* the running deployment's keys, so for a true ownership transfer:

**Rotate (all live before transfer; do via the provider console, then update the new owner's `server.env` / Vercel env):**

| Credential | Where it lives | Source to rotate | Required in prod |
|---|---|---|---|
| `AZURE_OPENAI_API_KEY` | server env | Azure Portal → OpenAI resource → Keys | Yes |
| `COSMOS_KEY` | server env | Azure Portal → Cosmos DB → Keys | Yes |
| `AZURE_STORAGE_ACCOUNT_KEY` | server env | Azure Portal → Storage → Access keys | Yes |
| `PYTHON_SERVICE_API_KEY` | server **and** python-service env | generate new token, set both sides | Yes (boot-enforced) |
| `SNOWFLAKE_PASSWORD` / `_USERNAME` | server env | Snowflake console | If Snowflake used |
| `ANTHROPIC_API_KEY` | server env | Anthropic console | If Claude routing used |
| `TAVILY_API_KEY` | server env | Tavily console | If web search used |
| `SENTRY_DSN` | server env | Sentry project | If Sentry used |
| `CRON_SECRET` | Vercel env | regenerate | If scheduled refresh used |
| `AUTH_BYPASS_DEV_TOKEN` | local dev only | per-developer | No (dev only) |

**Transfer ownership identity:**
- `server/lib/superadmin.ts:26` — replace hardcoded `piyush@finzarc.com`, or (preferred, immutable) set `SUPERADMIN_OIDS` to the new owner's Azure AD `oid` and drop the email.
- `.github/CODEOWNERS` — replace `@finzarc-piyush`.
- `SECURITY.md` — update the vulnerability-report contact.
- GitHub org/repo access, Vercel project membership, Azure subscription/RBAC, `.github/dependabot.yml` alert routing.

**Set production config the defaults leave permissive:**
- `BUDGET_GATE_ENFORCEMENT=enforce` (+ tune `DAILY_QUESTION_QUOTA`) — otherwise there is no hard per-user LLM-spend cap.
- Confirm `DISABLE_AUTH` unset (it fail-closes on Vercel regardless) and `AGENTIC_LOOP_ENABLED`/`RAG_ENABLED` posture per invariant #1.

---

## 8. Recommended pre-handover sequence

1. **Credential + ownership rotation (§7)** — half a day; the only true blocker. Hard-gates a clean transfer.
2. **Write Tier-1 handover docs (§6)** — `HANDOVER.md`, `OPERATIONS.md`, `FEATURE_FLAGS.md`, `ENV-CHECKLIST.md`. ~3–4 days for a technical writer with one engineer. This is what lets a human team actually run it.
3. **Quick code spot-checks (§5b)** — fix PY-a + PY-b (~25 min), confirm `npm audit` (DEP-a), decide Sentry (OBS-a). Optional but cheap.
4. **Hand over the deferred-debt roadmap (§4)** — walk the new owner through the 12 PARTIALs and `infra-migrations.md` so the scale migrations are understood as planned work, not landmines.
5. **Tier-2 docs (§6)** — per-service READMEs, DEPLOY.md expansion, topology diagram. Can follow handover.

**Validation that the handover is real:** have someone *not* on the current team do a cold clone → env setup → local run → staging deploy using only the new docs, and time it. Target < 4 hours for a Node/Python/Azure-literate engineer. If they get stuck, the gap they hit is the next doc to write.

---

## 9. Methodology & confidence

- **Approach:** 10 parallel read-only dimension agents (security, architecture, type/API, data/concurrency, testing/CI, perf/observability, frontend, python, handover-readiness, prior-audit reconciliation), each instructed to cite `file:line` and stay skeptical — followed by **direct code/git verification of every critical and contradicted claim** by the auditor.
- **Why the verification round mattered:** the dimension agents produced **five material false positives** (§5a), including a "CRITICAL committed-secret leak" for a file that was never in git and a "STILL-OPEN admin endpoint" that is route-gated. Every high-severity claim in this report (§2, §7) was re-checked against code or `git log --all` before being asserted; candidate items I did *not* re-verify to that depth are explicitly fenced as such (§5b).
- **Trust ordering used:** generated/CI-gated facts (registries, invariant firewall, the remediation tracker) > direct code reads > single-agent prose. The tracker was validated against code on a sample and found accurate, then trusted for the rest.
- **Not done by this audit:** no code edits, no git-history rewrite, no credential rotation, no runtime/load testing. §5b items and §6 artifacts are recommendations, not completed work.

---

*Generated by a fresh multi-agent handover audit, 2026-06-21. Companion documents: [`REMEDIATION-TRACKER.md`](expert-audit/REMEDIATION-TRACKER.md) (the 110-finding ledger), [`infra-migrations.md`](decisions/infra-migrations.md) (deferred-migration rationale), [`expert-audit-remediation.md`](decisions/expert-audit-remediation.md) (the "hard core is staged, not faked" decision).*
