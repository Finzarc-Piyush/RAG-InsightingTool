# Plans index

Forward-looking plans live here. Each plan is a small, scannable doc that
can stand alone. Status tracked in the plan itself.

| Plan | Problem | Status |
|------|---------|--------|
| [phase-1-deep-analysis.md](./phase-1-deep-analysis.md) | One-stop in-depth analysis (hypotheses → parallel evidence → ranked drivers → rich answer) | 1.A–1.G shipped; 1.H partial (insight_explorer done, time_window_diff deferred) |
| [dashboard-ux-collision-fix.md](./dashboard-ux-collision-fix.md) | Dragging a card over another cascades everything; fix to swap semantics + stable reflow | core fix shipped; polish remaining |
| [phase-2-dashboard-generation.md](./phase-2-dashboard-generation.md) | Generate a full dashboard from a chat answer with a preview-and-commit flow | 2.A–2.C shipped; 2.D rollout / 2.E patch tool remain |

## Dependencies

```
dashboard-ux-collision-fix   ─────┐
                                   │
phase-1-deep-analysis  ─── PR 1.G ─┼──►  phase-2-dashboard-generation
                                   │
                               (reuses fixed grid + rich answer fields)
```

## Conventions

- Each plan lists sub-problems, solution design in layers, file-level
  changes, verification, and open questions.
- Feature flags default off until rollout.
- Rollouts are staged (internal → staging → 10% → 100%).
- Every new cross-service type goes into both `server/shared/schema.ts`
  and `client/src/shared/schema.ts` so `scripts/check-shared-schema-drift.mjs`
  stays green.
