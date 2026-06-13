# Shared schemas (server ↔ client mirror)

> ℹ Line numbers in this doc are indicative and known to drift (the zod *shapes*
> stay accurate). For an exact current location of any schema symbol, grep it or
> look it up in `docs/index/symbols.generated.tsv`.

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
- A drift gate (historical) hashed both files' structural shape and
  failed CI on deltas beyond the allowlist. It is no longer present — see
  the caveat at the end of this doc: Wave W5 collapsed the client mirror
  into a single re-export, so the gate is no longer load-bearing.

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

Per-wave history lives in [`docs/WAVES.md`](../WAVES.md) (search the wave id). The detailed
pre-2026-06 subsystem changelog was moved out of this routing doc to keep `/load` cheap —
see [`docs/archive/schemas-changelog.md`](../archive/schemas-changelog.md). Keep new
entries here to ONE line each; full prose belongs in `docs/WAVES.md`.
