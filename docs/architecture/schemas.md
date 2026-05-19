# Shared schemas (server ↔ client mirror)

## Purpose

Every schema the wire touches is defined **twice** — once in
`server/shared/schema.ts`, once in `client/src/shared/schema.ts` — with
byte-for-byte equivalent shape. Zod's default `strip` means a
mismatched shape silently drops fields on re-validate, which has burned
us before.

## Key files

- `server/shared/schema.ts` — authoritative server-side schemas.
- `client/src/shared/schema.ts` — client mirror, imported as
  `@shared/schema` via the `@shared/*` alias.
- `scripts/check-shared-schemas.mjs` (if present) — the drift gate that
  hashes both files' structural shape; CI fails on deltas beyond the
  allowlist.

## Mirror pairs

| Schema | Purpose | Both files? |
|---|---|---|
| `messageSchema` | Chat message (user + assistant) | ✅ |
| `agentWorkbenchSchema` | Workbench entry rows streamed over SSE | ✅ |
| `chartSpecSchema` | Chart rendering contract | ✅ |
| `dashboardSpecSchema` | Dashboard spec from autogen / user | ✅ |
| `dashboardPatchSchema` | Incremental dashboard edits (add/remove/reorder tiles) | ✅ |
| `analysisBriefSchema` | Planner brief (outcome metric, filters, comparisonPeriods) | ✅ |
| `thinkingStepSchema` / `thinkingSnapshotSchema` | Live thinking panel | ✅ |
| `pivotDefaultsSchema` | Query-derived pivot fields | ✅ |

**`agentTrace`** on `messageSchema` is carried as
`z.record(z.unknown()).optional()` in both files — it is **not** a
strict schema today. The server writes a capped `AgentTrace` blob; the
client reads it opportunistically. Typing it strictly is a future
improvement (would also let the drift gate check trace shape), not a
bug.

## Data contracts

- **Nothing on the wire should come from `any` alone.** If a field
  isn't in the mirrored schema, the drift gate should flag it.
- **Optional vs strict.** Prefer `.optional()` over `.passthrough()`;
  prefer `.strict()` for request bodies parsed by route handlers.
- **Shape mirrors, not identity.** `server/shared/schema.ts` and
  `client/src/shared/schema.ts` are physically separate modules — each
  service imports its local copy. Don't attempt to `import` one from
  the other (the Vite SPA cannot see the server filesystem at build
  time).

## Extension points

- **Add a shared schema**: define it in `server/shared/schema.ts`, copy
  the same declaration into `client/src/shared/schema.ts`, and run the
  drift gate if present. Types via `z.infer<typeof X>` travel through
  `@shared/schema` on both sides.
- **Add a field to `messageSchema`**: apply to both files in the same
  commit. The drift gate should catch any asymmetry.

## Known pitfalls

- **`strip` silently drops.** If you forget to mirror a field, the
  parser simply removes it on round-trip — no error, no warning. Always
  mirror.
- **Enum values must match.** `z.enum([...])` compares literals
  case-sensitively; `"pass"` ≠ `"Pass"`.
- **Default values live in schemas, not in handlers.** A schema's
  `.default(x)` runs at parse time; a handler's `?? x` runs after
  validation. Prefer the schema unless you need request-context.

## Recent changes

- Wave W61-list (2026-05-20) — `chat.model.ts` exports a new lightweight `AdminSemanticModelListEntry` (index-row projection over `ChatDocument.semanticModel`) + `ADMIN_SEMANTIC_MODEL_LIST_SELECT` (the Cosmos SELECT) + `finalizeAdminSemanticModelEntry` (pure coercion) + `getAllSessionsWithSemanticModel` (network boundary). The projection cherry-picks root fields + nested `semanticModel.{version,name,updatedAt,updatedBy}` + per-collection counts via the defensive `IIF(IS_DEFINED ... AND IS_ARRAY, ARRAY_LENGTH, 0)` triple. `WHERE IS_DEFINED(c.semanticModel)` filters pre-W57 docs; `ORDER BY c.lastUpdatedAt DESC` surfaces the active sessions. Powers the admin index page at `/admin/semantic-models` (first of three W61 sub-waves; W61-detail surfaces the full payload via `formatMetricCatalog`; W61-save lands the PATCH endpoint). The `enableCrossPartitionQuery: true` FeedOption was deliberately omitted because Cosmos SDK v4 dropped it from `FeedOptions` and including it would have added a 6th instance of the existing `TS2769` overload baseline (lines 583/979/1063/1493/1762). See `docs/WAVES.md` for full entry.
- Wave W57 (2026-05-16) — `ChatDocument` gains optional `semanticModel?: SemanticModel` field in [server/models/chat.model.ts](../../server/models/chat.model.ts) (ChatDocument is a TS interface, not a zod schema, so no mirror needed). Populated at the upload understanding-ready checkpoint via [`server/lib/semantic/inferModel.ts`](../../server/lib/semantic/inferModel.ts).
- Wave W56 (2026-05-16) — Semantic & metrics layer type foundation. Adds `semanticMetricSchema`, `semanticDimensionSchema`, `semanticHierarchySchema`, `semanticModelSchema` to [server/shared/schema.ts](../../server/shared/schema.ts). Auto-mirrored to client via the W5 re-export. Foundation for W57–W64 per the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md). See `docs/WAVES.md` for full entry.
- Initial seed of this doc.

**Caveat — out-of-date description above.** The "every schema defined twice" line at the top of this doc predates Wave W5, which collapsed the client mirror into a single re-export (`export * from "../../../server/shared/schema"` in [client/src/shared/schema.ts](../../client/src/shared/schema.ts)). The drift gate is no longer load-bearing; manual mirroring is no longer possible. Refresh in a future doc-hygiene wave.
