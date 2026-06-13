# Convention: Audit-style ring buffer on `ChatDocument`

> Introduced in Wave W61-audit-log (2026-05-20). See `docs/WAVES.md` for the original context.

## Rule

When a wave adds a "history of state X" feature to `ChatDocument`, follow this shape:

1. **Pure module** named `<feature>AuditLog.ts` (e.g. [`semanticModelAuditLog.ts`](../../server/lib/semantic/semanticModelAuditLog.ts)) co-located with the feature's other helpers (the W61 trail keeps audit / source-bump / inference under `server/lib/semantic/`; other features pick the matching subsystem dir).
2. **Exported entry interface** (`<Feature>AuditEntry`) with at minimum: `savedAt: number` (ms-epoch), `savedBy: string` (admin email or `"unknown"`), and a full snapshot field (`priorModel`, or the prior-state field named for whatever the feature snapshots).
3. **Exported cap const** (`<FEATURE>_AUDIT_LOG_MAX_ENTRIES`, typically `10`). Bounded ring buffer keeps Cosmos doc footprint predictable.
4. **Single pure function** `append<Feature>AuditEntry(prior, entry, max = CAP): T[]` that prepends newest-first, caps at `max`, and returns a fresh array. Accepts `undefined` for `prior` to handle the first-save-ever case.
5. **Optional field on `ChatDocument`** named `<feature>AuditLog?: <Feature>AuditEntry[]` sibling to the feature's primary field, with a doc-comment that names the introducing wave and the cap const.
6. **Write inside the existing `withSessionWriteLock`** (per [invariant #9](../../CLAUDE.md)). Capture `Date.now()` once and reuse the value for both the audit entry's `savedAt` and any companion timestamps (e.g. `doc.lastUpdatedAt`) so a future history-tab UI can correlate without clock-skew confusion.
7. **Snapshot the *prior* state, not the next.** The buffer's role is to remember what was just lost; the next state already lives on the canonical field.
8. **Pin the cap const in tests.** A future bump should require touching the test in the same diff as the const change.

## Why

- **Bounded doc growth.** Cosmos has a 2 MB per-document limit. A capped buffer (10 entries × ~50 KB snapshot worst-case = ~500 KB) leaves headroom while supporting the common-case "revert my recent edit" use case.
- **Atomicity with the primary write.** The audit-write and the primary state overwrite must happen together — a process crash between them would leave either an orphan audit entry (no corresponding state change) or a lost state change (no audit trail). Nesting both inside `withSessionWriteLock` makes the pair atomic at the per-session level.
- **Snapshot-not-delta simplicity.** Full snapshots are simpler to revert than deltas (apply the snapshot vs. compose deltas back). Storage cost is bounded by the cap, so the simplicity wins.
- **MRU ordering matches repo precedent.** WI6 `insightHistory`, the sidebar Recent Sessions, and the W61-filter-persist URL convention all use newest-first. A history-tab UI renders `[0]` as "most recent" without inverting.
- **No reference-identity optimization.** Every append is a state change; there's no default-case-is-no-op path. Return a fresh array unconditionally.

## How to apply

When you ship a wave that adds rollback / forensics for a `ChatDocument` field:

1. Create `server/lib/<subsystem>/<feature>AuditLog.ts` with the entry interface, cap const, and pure `append<Feature>AuditEntry` function.
2. Add `<feature>AuditLog?: <Feature>AuditEntry[]` to the `ChatDocument` interface in [`server/models/chat.model.ts`](../../server/models/chat.model.ts) via `import type` (keeps the runtime module dep light).
3. Inside the existing `withSessionWriteLock` callback in the controller / handler that mutates the primary field, snap the prior state into the buffer **before** the overwrite:
   ```ts
   const savedAt = Date.now();
   doc.<feature>AuditLog = append<Feature>AuditEntry(
     doc.<feature>AuditLog,
     { savedAt, savedBy: updatedBy, prior<Field>: doc.<field> /* ... */ },
   );
   doc.<field> = next<Field>;
   doc.lastUpdatedAt = savedAt;
   ```
4. Write tests covering: cap const pin, `undefined`-prior, newest-first prepend, cap-drops-oldest, exactly-at-cap, custom `max` override, non-mutation of input, fresh-array-reference contract, full snapshot preservation, plus controller-integration tests that verify the snapshot is the *prior* state and that consecutive saves prepend correctly.
5. Append the test file to [`server/package.json`](../../server/package.json)'s explicit test list per [invariant #4](../../CLAUDE.md).
6. **Do not** add a deep-clone (`structuredClone`) of the prior state. Rely on the replace-don't-mutate convention; tests pin the prior-snapshot semantics. A defensive clone wastes ~5–50 KB of allocation per save for a hypothetical scenario no existing code triggers.
7. **Do not** introduce a new lock. The unified per-session mutex is `withSessionWriteLock` per invariant #9.

## Related

- [Wave W61-audit-log entry](../WAVES.md)
- Pioneer file: [`server/lib/semantic/semanticModelAuditLog.ts`](../../server/lib/semantic/semanticModelAuditLog.ts)
- Tests: [`server/tests/semanticModelAuditLogW61AuditLog.test.ts`](../../server/tests/semanticModelAuditLogW61AuditLog.test.ts)
- Controller wiring example: [`patchSemanticModel` in adminSemanticModelController.ts](../../server/controllers/adminSemanticModelController.ts)
- Sibling pattern (per-entry bookkeeping inside the same lock): [`semanticModelSourceBump.ts`](../../server/lib/semantic/semanticModelSourceBump.ts)
