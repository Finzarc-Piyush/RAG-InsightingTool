# Living architecture docs

This directory carries one Markdown file per subsystem. Each file is the
**contract** for that subsystem: what it owns, what it exposes, what
invariants hold, where to extend, where the footguns live.

## Contributor contract

> Any PR whose diff touches files inside a subsystem's path list must
> update that subsystem's doc in the same commit. If the change doesn't
> affect the doc's content, the PR still adds a one-liner under the
> doc's **Recent changes** section with the commit subject and a short
> sentence.

Reviewers reject PRs that silently mutate a subsystem without a doc
touch. The convention ships first; a future `scripts/doc-gate.mjs` can
automate the check.

## Reading order

1. [`overview.md`](./overview.md) — the monorepo at a glance.
2. [`agent-runtime.md`](./agent-runtime.md) — the engine every chat
   turn runs through.
3. [`skills.md`](./skills.md) — Phase-1 analytical competencies.
4. [`tool-registry.md`](./tool-registry.md) — how tools are declared,
   registered, validated, executed.
5. [`schemas.md`](./schemas.md) — the `server/shared/schema.ts` ↔
   `client/src/shared/schema.ts` mirror rule.
6. [`brand-system.md`](./brand-system.md) — design tokens, the
   `theme-check` gate, the tempDebt allowlist.
7. [`upload_and_enrichment.md`](./upload_and_enrichment.md) — already
   the canonical doc for the upload/enrichment pipeline.
8. [`ci-and-env.md`](./ci-and-env.md) — CI matrix, env-file quirks,
   critical flags.

Additional subsystem docs are added as each wave touches a new area;
the current tree is intentionally small so nothing grows stale.

## Path → doc map

| Paths touched (glob-ish) | Doc to update |
|---|---|
| `server/lib/agents/runtime/agentLoop.service.ts` · `**/runtime/planner.ts` · `**/runtime/verifier.ts` | `agent-runtime.md` |
| `server/lib/agents/runtime/skills/**` | `skills.md` |
| `server/lib/agents/runtime/toolRegistry.ts` · `**/runtime/tools/**` | `tool-registry.md` |
| `server/lib/agents/**` (legacy orchestrator) | `agent-runtime.md` "Legacy layer" |
| `server/shared/schema.ts` · `client/src/shared/schema.ts` | `schemas.md` |
| `server/services/upload/**` · `server/utils/uploadQueue.ts` | `upload_and_enrichment.md` |
| `client/src/index.css` · `client/tailwind.config.ts` · `client/scripts/theme-check.mjs` | `brand-system.md` |
| `.github/workflows/*` · `server/loadEnv.ts` · `client/vite.config.ts` · `client/vitest.config.ts` · server/client `.env.example` | `ci-and-env.md` |

## Doc skeleton (copy when adding a new subsystem)

```
# <subsystem>

## Purpose

## Key files

## Data contracts

## Runtime flow

## Extension points

## Known pitfalls

## Recent changes
- <commit-subject> — one-line note on what changed and why
```

## History

This tree was seeded alongside the override/break audit documented at
[`docs/plans/i-suggest-we-start-keen-koala.md`](../plans/) (if present)
or recoverable from `git log`. The audit identified five correctness
issues (skill selection, registry duplicate silent-overwrite, verdict
enum duplication, dark-mode on three surfaces, legacy-agentic capability
gap); each fix lands with its own doc update.
