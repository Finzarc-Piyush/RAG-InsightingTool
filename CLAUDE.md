# CLAUDE.md — Marico RAG Insighting Tool

> Routing index for Claude Code. **Read [`docs/STATE.md`](docs/STATE.md) first** (or run `/orient`).
>
> This file is intentionally small (~5 KB). It tells you WHERE to find things, not WHAT they are.
> Wave-by-wave history lives in [`docs/WAVES.md`](docs/WAVES.md). Subsystem deep-docs live in [`docs/architecture/`](docs/architecture/).

---

## What this product is

A multi-tenant analytical chat tool for Marico (FMCG / haircare) and adjacent enterprise data. Upload a dataset (CSV / Excel / Snowflake) → LLM enrichment + RAG index → answer analytical questions via an **agentic plan/act loop** that calls structured tools (DuckDB queries, correlation, segment-driver analysis, MMM optimiser, web search) and synthesises a decision-grade answer envelope (TL;DR, findings, implications grouped by horizon, magnitudes, methodology, caveats). Charts and dashboards are first-class outputs.

## Current state

**Always read [`docs/STATE.md`](docs/STATE.md) at session start** — HEAD wave, live feature streams, last 5 waves, known WIP. Or run `/orient` for a 10-second warmup.

## Critical invariants — Claude MUST honor these

1. **`AGENTIC_LOOP_ENABLED` is mandatory.** `dataAnalyzer.answerQuestion` throws if false. Legacy orchestrator was deleted in commit `9422bed7` (2026-04-26). Don't reintroduce a fallback path.
2. **ESM everywhere on the server.** Relative imports use `.js` extension even from `.ts` source.
3. **[`server/loadEnv.ts`](server/loadEnv.ts) MUST be the first import in [`server/index.ts`](server/index.ts).** Don't reorder.
4. **Server `npm test` auto-discovers `*.test.ts`** via [`scripts/runTests.mjs`](server/scripts/runTests.mjs) (Wave R26) — new test files are picked up automatically; there is no hand-maintained list. Exclude vitest files (`*.vitest.test.ts`), which run under the client's own config.
5. **Two non-standard env file names:** `server/server.env`, `client/client.env`. Loaded by code, not tooling defaults.
6. **Single-flow policy.** Reflector `replan` / verifier `revise_narrative` emit `flow_decision` SSE rows but do NOT silently override the planner. Re-wiring deep-investigation requires a feature flag.
7. **Verifier verdicts are constants** from `VERIFIER_VERDICT.*` in [server/lib/agents/runtime/schemas.ts](server/lib/agents/runtime/schemas.ts). Never string literals.
8. **Tool / skill duplicate name = fatal at boot.** Register tools in `tools/<name>Tool.ts` + [`registerTools.ts`](server/lib/agents/runtime/tools/registerTools.ts); skills in `skills/<name>.ts` + `skills/index.ts`.
9. **`mutateChatDocument`** ([server/models/chat.model.ts](server/models/chat.model.ts)) is THE read-modify-write seam for a `ChatDocument`: it takes the per-session `withSessionWriteLock` ([server/lib/sessionWriteLock.ts](server/lib/sessionWriteLock.ts), Wave A2), reads **fresh** (cache-bypass), mutates, and writes with a Cosmos **IfMatch `_etag`** precondition (412 → re-read + retry) for multi-instance safety. Every contended RMW — message append, turn checkpoint, SAC merge, BAI patch, fingerprint — routes through it; the mutator may return `false` to abort. Don't write a bare `getChat → mutate → updateChatDocument` and don't call `mutateChatDocument` from inside another lock-holder (non-reentrant → deadlock). User-action PUT endpoints (hierarchy/schema/active-filter/admin) still serialise intra-instance on the shared `withSessionWriteLock` directly (ETag follow-up pending).
10. **Claude Opus 4.7 routing is opt-in per role** via `OPENAI_MODEL_FOR_*` env vars + `ANTHROPIC_API_KEY`. Don't hardcode provider — read [llmCallPurpose.ts](server/lib/agents/runtime/llmCallPurpose.ts).
11. **Temporal chart-axis grain has ONE authority:** [`temporalGrainAuthority.resolveTrendGrain`](server/lib/temporalGrainAuthority.ts). Every chart builder (planner patch, `periodColumnResolver.resolvePeriodAxis`, `dashboardFeatureSweep`, `visualPlanner`) delegates to it; none rolls its own span→grain logic or a local `DEFAULT_FACET_PREFERENCE`. The authority is span-aware AND counts MATERIALIZED buckets from the charted rows, so a single month of daily data yields a daily axis even when `dateRange` metadata is absent. Trend tiles build from the RAW frame (aggregation is destructive — a Month-grouped table can't recover daily detail). See [`docs/decisions/centralized-temporal-grain.md`](docs/decisions/centralized-temporal-grain.md).
12. **Question intent + answer depth have ONE authority:** [`queryIntentAuthority.classifyQueryIntent`](server/lib/agents/runtime/queryIntentAuthority.ts). It classifies a question ONCE into an intent class + a `depthBudget` (`minimal`/`standard`/`full`) and owns the canonical analytical / lookup / factual / multi-part vocabularies. `isDirectFactualQuestion` and `detectQuickLookup` are THIN VIEWS over it (they call it; they carry no private denylist regex). The full agent loop computes `ctx.depthBudget` once and every output-shaping gate (visual-planner extra charts, dashboard offer, feature sweep, spawned follow-ups, envelope recommendations/next-steps) reads it — a `minimal` ask (plain lookup / direct factual) is answered without auto-padding. This is what stops "simple question → plethora." See [`docs/decisions/centralized-query-intent.md`](docs/decisions/centralized-query-intent.md).

The checkable kernel of invariants #1/#3/#4/#5/#7/#8/#9/#10/#11/#12 is machine-verified against the tree by [`server/scripts/check-invariants.ts`](server/scripts/check-invariants.ts) (spec: [`invariants.spec.ts`](server/scripts/invariants.spec.ts)). `npm test` and CI fail if an invariant stops matching code — so when you change one, update the spec, not just this prose.

For more conventions see [`docs/conventions/`](docs/conventions/). For architectural decisions see [`docs/decisions/`](docs/decisions/). For lessons learned see [`docs/lessons.md`](docs/lessons.md).

## Working cadence — tiny waves

Every unit of work is ~100–200 LOC, one file class (pure fn OR schema OR one route OR one component) plus a test plus one doc line. Commit subject: `Wave W<n> · <subject>`. Plan in `/Users/tida/.claude/plans/` before non-trivial work. At wave end run `/wave-commit`.

## Repo layout

| Directory | Runtime | Port | Purpose |
|---|---|---:|---|
| [`client/`](client/) | Vite + React 18 + TS (ESM) | 3000 | SPA, MSAL auth, wouter routing, Tailwind + Radix, TanStack Query |
| [`server/`](server/) | Node 20 + Express + TS via `tsx` (ESM) | 3002 | REST + SSE API, agentic chat, RAG, file parsing, DuckDB exec |
| [`python-service/`](python-service/) | FastAPI + Uvicorn | 8001 | Data ops (pandas / sklearn), MMM optimiser |
| [`api/`](api/) | Vercel serverless wrappers | — | `api/index.ts` wraps `createApp()`; `api/data-ops/index.py` wraps FastAPI |
| [`docs/`](docs/) | — | — | Routing index target — see "Where to find what" below |

**No top-level `package.json`.** Each service has its own.

**First-time clone setup:** `git config core.hooksPath .githooks` enables the local pre-commit gate (invariants + doc-refs + registry freshness) so drift is caught at commit time, not just by CI. Per-clone (git config isn't shared); CI is the always-on backstop regardless.

## Dev loop (three terminals)

```bash
cd python-service && python3 main.py    # uvicorn :8001
cd server && npm run dev                 # tsx :3002
cd client && npm run dev                 # :3000 (proxies /api → :3002)
```

When user says "restart servers" plural, kill PIDs on 8001 / 3002 / 3000 then start in order ([.cursor/rules/restart-servers.mdc](.cursor/rules/restart-servers.mdc)). Single service = restart only that one.

## Build / test

```bash
cd server  && npm run build && npm test
cd client  && npm run build && npm run theme:check && npm test
cd server  && node --import tsx --test tests/<file>.ts   # single test file
```

Server tests run via [`scripts/runTests.mjs`](server/scripts/runTests.mjs), which glob-discovers every `tests/**/*.test.ts` (plus the client `node:test` files it drives). Client tests can be `node:test` OR vitest (`*.vitest.test.ts`). New `*.test.ts` files are picked up automatically — see invariant #4.

## Slash commands (your tools)

- **`/orient`** — run at the start of every new chat. Runs `npm --prefix server run orient`: live branch/HEAD/wave/dirty state + invariant-firewall verdict + recent churn + doc sizes + recent lesson titles, all generated fresh from the tree (cannot be stale). One command, ~3 KB.
- **`/wave-commit`** — run at the end of each wave. Writes the WAVES.md entry, updates STATE.md HEAD, touches affected `docs/architecture/<sub>.md`, creates `docs/conventions/<slug>.md` if new convention introduced, stages doc updates, commits.
- **`/load <subsystem>`** — pull a subsystem deep-doc into context. Example: `/load agent-runtime`, `/load charting`, `/load rag`, `/load mmm`, `/load wide-format`.

## Where to find what

| Need | Look here |
|---|---|
| Current state, HEAD wave, live streams, WIP | [`docs/STATE.md`](docs/STATE.md) |
| Wave-by-wave changelog (recent ~50 waves) | [`docs/WAVES.md`](docs/WAVES.md) |
| Older waves (rotated archives) | [`docs/archive/`](docs/archive/) (subagent-only) |
| Subsystem deep-dives | [`docs/architecture/<name>.md`](docs/architecture/) — 12 files: `agent-runtime`, `tool-registry`, `skills`, `mmm`, `wide-format`, `upload_and_enrichment`, `charting`, `domain-context`, `schemas`, `brand-system`, `ci-and-env`, `overview` |
| Conventions that bite | [`docs/conventions/`](docs/conventions/) — one file per gotcha |
| Generated indexes (tools/routes/skills · symbol→file:line) | [`docs/index/`](docs/index/) — `registries.generated.md`, `symbols.generated.tsv` (regenerate: `npm --prefix server run gen:registries` / `gen:symbols`; never hand-edit — see [cold-start convention](docs/conventions/cold-start-generated-indexes.md)) |
| Architectural decisions (ADRs) | [`docs/decisions/`](docs/decisions/) |
| Cross-session lessons | [`docs/lessons.md`](docs/lessons.md) |
| Plan files | [`/Users/tida/.claude/plans/`](file:///Users/tida/.claude/plans/) |
| Past incidents (P-001 … P-NN) | [`docs/problems/`](docs/problems/) |
| Deploy guide | [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| Agent module file-by-file inventory | [`docs/agents-architecture-inventory.md`](docs/agents-architecture-inventory.md) |

## Workflow rules for Claude

1. **Plan-mode default** for any non-trivial task (3+ steps or architectural decisions). Write plans to `/Users/tida/.claude/plans/`.
2. **Subagents liberally.** Use `Explore` for "where is X", `Plan` for "how should I design Y", `general-purpose` for cross-file audits. Keeps main context clean.
3. **After ANY correction from the user:** add an L-NNN entry to [`docs/lessons.md`](docs/lessons.md).
4. **Verify before done.** Tests pass, types pass, behavior demonstrated. For UI changes: actually use the feature in a browser.
5. **Demand elegance (balanced).** For non-trivial changes: "is there a simpler way?" Don't over-engineer simple fixes.
6. **Autonomous bug fixing.** Point at logs/errors/failing tests → resolve them. No hand-holding required.
7. **Run `/wave-commit`** at the end of every wave. The Stop hook nudges if you forget.
8. **Trust generated facts; verify prose.** The `/orient` pack, the invariant firewall, and `docs/index/` (registries + symbols) are generated or CI-gated — trust them. Hand-written prose in `docs/architecture/` & `docs/conventions/` is a **hint, not ground truth**: before you rely on a specific path / symbol / line / behaviour from it, confirm against code (one grep, or `docs/index/symbols.generated.tsv`). `npm --prefix server run check:doc-refs` flags any live doc whose file references have broken. This is the rule that keeps "fast" from becoming "confidently wrong."

## Maintenance contract

When you change anything described in this file:

- **Wave entries** → [`docs/WAVES.md`](docs/WAVES.md) via `/wave-commit`. Never inline here.
- **Subsystem changes** → append a "Recent changes" line to the matching [`docs/architecture/<name>.md`](docs/architecture/) via `/wave-commit`.
- **New convention** → create [`docs/conventions/<slug>.md`](docs/conventions/) and add a one-line index entry above.
- **Architectural decision** → create [`docs/decisions/<slug>.md`](docs/decisions/) with context / decision / consequences.
- **Cross-session lesson** → append L-NNN to [`docs/lessons.md`](docs/lessons.md).
- **Critical invariant change** → update this file's invariant list AND match commit subject.

Only update **this file** (`CLAUDE.md`) when an invariant, repo layout, dev command, or slash command actually changes. CLAUDE.md should stay byte-stable across most waves so prompt cache holds.
