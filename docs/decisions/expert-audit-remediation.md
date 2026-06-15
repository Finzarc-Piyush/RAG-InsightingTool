# Expert-audit remediation (EX waves)

## Context

A 15-dimension multi-agent audit (2026-06-15) graded the codebase **C+** —
"strong bones, inconsistent finish" — with 110 adversarially-verified findings
(0 critical, 33 high, 54 medium, 23 low). The full findings + live status are a
checked-in living document, [`docs/expert-audit/REMEDIATION-TRACKER.md`](../expert-audit/REMEDIATION-TRACKER.md),
maintained across sessions (legend: DONE / PARTIAL / STAGED / TODO). This ADR
records the cross-cutting decisions the remediation introduced, so they aren't
re-litigated.

## Decisions

1. **Security is enforced fail-safe, not by remembering.** The upload-status
   IDOR was closed with an ownership check + CSPRNG job ids; the `DISABLE_AUTH`
   dev bypass now fails closed (mandatory `AUTH_BYPASS_DEV_TOKEN` + explicit
   `NODE_ENV=development|test`, refused on Vercel/unset); admin/queue endpoints
   are gated by `requireSuperadmin`; the per-user budget gate defaults to
   `warn_only` (a no-op default "control" is not a control). The unsafe
   `getChatBySessionIdEfficient` carries a do-not-use-in-controllers contract.

2. **One env config, validated at boot.** [`server/config/env.ts`](../../server/config/env.ts)
   `assertRequiredEnv()` runs in `createApp` and fails fast (prod) / warns (dev)
   on a missing credential cluster — no more lazy mid-request credential
   failures. New subsystems read config here, not `process.env` directly.

3. **Structured, correlated observability.** [`server/lib/logger.ts`](../../server/lib/logger.ts)
   emits JSON + `traceId`/`sessionId`/`userId` (from the AsyncLocalStorage
   request context) under `LOG_FORMAT=json` / production; `agentLog` auto-stamps
   the same ids; a per-request access log ([`requestLogger`](../../server/middleware/requestLogger.ts))
   and a superadmin `/api/metrics` endpoint make production debuggable.
   Confidential user-question text is `debug`-only.

4. **Ratchets, not one-time cleanups.** New escape hatches can only decrease:
   [`check-type-escapes.ts`](../../server/scripts/check-type-escapes.ts) fails CI
   if `as any` / `as unknown as` grows past a committed baseline; an ESLint
   size/complexity gate (warn) flags the god-files; the SSE contract has an
   exhaustiveness test that fails on a new unregistered `safeEmit` kind; tests
   are type-checked (`tsconfig.test.json`) and the Python tests run in CI.

5. **One definition per concept.** `schema.ts` (3,479 lines, fan-in 616) was
   split into [`shared/schema/charts.ts`](../../server/shared/schema/charts.ts) +
   a re-export barrel; duplicated helpers were unified
   ([`utils/errorMessage.ts`](../../server/utils/errorMessage.ts),
   [`shared/parseNumericCell.ts`](../../server/shared/parseNumericCell.ts)).

6. **The hard core is staged, not faked.** The two behavioral god-files
   (`runAgentTurn`, `dataOpsOrchestrator`) are decomposed only **after**
   phase-level test scaffolding exists (the audit's own guidance — they are
   ~50-accumulator stateful functions). The infra trio (Cosmos repartition,
   durable upload runner, parquet read-path flip) is written code-ready but
   validated against live Azure/Vercel. These stay `STAGED` in the tracker
   rather than marked done — an honest tracker is the deliverable.

## Consequences

- Every remediation ships green: server+client `typecheck`, `build`, invariants
  32/32, the type-escape ratchet, `check:doc-refs`, and (where applicable) a live
  `/api/ready` boot check.
- The tracker is the cross-session engine; CLAUDE.md stays byte-stable (only the
  `check:type-escapes` gate is new tooling).
- See [`docs/lessons.md`](../lessons.md) L-014/L-015 for the codemod-collision and
  verify-audit-prose lessons surfaced during the work.
