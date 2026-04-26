# Domain Context Packs

> **Wave**: WD1–WD9 · 2026-04-26
>
> Authored Marico/FMCG knowledge that is injected into every analytical chat
> turn. Toggleable per-pack from the admin UI.

## Why this exists

The Marico analyst team uploads datasets that the agent has no standing
knowledge about. With nothing else to go on, the agent treats "Parachute" and
"X-brand" identically and can't recognise that monsoon, Onam or copra prices
matter to a quarter. Domain context packs are an authored layer of background
knowledge — what Marico is, the brands it sells, who it competes with, when
demand spikes, what the input-cost cycle looks like — that the agent reads
on every turn so its analysis is grounded in the right operating reality.

## What the packs are

- 13 markdown files under [`server/lib/domainContext/packs/`](../../server/lib/domainContext/packs/) — covering Marico's India and Vietnam portfolios, FMCG industry context, competitors, seasonality, commodities, regulation, KPI glossary and geography codes.
- Each starts with YAML frontmatter:
  ```markdown
  ---
  id: marico-haircare-portfolio
  title: Marico Haircare Brand Portfolio
  category: products | industry | competition | seasonality | events | glossary
  priority: 2
  enabledByDefault: true
  version: 2026-04-26
  ---
  <markdown body>
  ```
- The `id` is the toggle marker. The admin UI addresses packs by id.
- The body is **qualitative only**. No market-share percentages, no revenue
  figures, no growth rates with numbers. Numeric claims must come from the
  dataset / tools / RAG citations — never from a pack. The verifier
  ([`sharedPrompts.ts:30`](../../server/lib/agents/runtime/sharedPrompts.ts#L30))
  enforces this; the prompt block label tells the model the same.

## How they reach the LLM

1. Build time: [`scripts/build-domain-packs.ts`](../../server/scripts/build-domain-packs.ts)
   compiles every `.md` into a typed `generatedPacks.ts` module so esbuild
   can bundle them. Runs automatically on `npm run dev` and `npm run build`.
2. Runtime: [`loadEnabledDomainContext()`](../../server/lib/domainContext/loadEnabledDomainContext.ts)
   reads the toggle overrides from Cosmos and composes the enabled packs into
   one string with stable `<<DOMAIN PACK: id>> ... <</DOMAIN PACK>>` markers.
   Memoised at process scope; invalidated by the admin PATCH handler.
3. Plumbing: [`dataAnalyzer.ts:answerQuestion`](../../server/lib/dataAnalyzer.ts)
   calls the loader and passes the composed text to
   [`buildAgentExecutionContext`](../../server/lib/agents/runtime/context.ts).
4. Prompt assembly: [`formatUserAndSessionJsonBlocks`](../../server/lib/agents/runtime/context.ts)
   emits a labelled block between `permanentContext` and
   `sessionAnalysisContext`. Both the planner summary and the reflector
   appendix call this function, so both phases see the domain context.

## Toggle store

- Single Cosmos document. Container: `domain_context_toggles`. Doc id: `global`.
- Shape: [`domainContextToggles.model.ts`](../../server/models/domainContextToggles.model.ts).
- Atomic concurrent writes via etag-guarded `replace` (retry once on 412).
- Audit log: ring-buffered last 50 events embedded in the same doc.
- Cosmos cold / unconfigured → frontmatter defaults still apply; the chat path
  is never blocked on toggle-store availability.

## Admin surface

- `GET  /api/admin/domain-context/packs` — list packs with current enabled
  state and total enabled tokens.
- `PATCH /api/admin/domain-context/packs/:packId` body `{ enabled: boolean }` —
  flip a single pack and invalidate the loader cache.
- Both gated by [`isAdminRequest()`](../../server/utils/admin.helper.ts#L25)
  (`ADMIN_EMAILS` env allow-list).
- UI: [`client/src/pages/Admin/AdminContextPacks.tsx`](../../client/src/pages/Admin/AdminContextPacks.tsx) at
  `/admin/context-packs`.

## Conflict-resolution policy

When sources of context speak about the same thing, follow this order:

1. **Tool output** (analytical queries, statistical tests, segment driver
   analysis) → authoritative for any numeric claim. Beats everything below.
2. **RAG citations** from the session corpus → next most authoritative for
   facts; treated as evidence by the verifier.
3. **`permanentContext`** (per-session user notes) → user knows their
   session better than the global pack. Overrides domain context where they
   speak about the same thing.
4. **`domainContext`** (this feature) → orientation only. Never used as
   evidence for figures.

## Token budget

- 13 packs × ~600–800 words ≈ 10–11k tokens of domain context per LLM call.
- The block is positioned in the user-message-side context (after
  `permanentContext`, before `sessionAnalysisContext`); `ANALYST_PREAMBLE`
  stays byte-stable so the system-prompt prefix-cache discount survives.
- The loader logs total enabled tokens at startup and warns when > 12,000.
- The admin UI shows a badge when total enabled tokens cross the warn
  threshold.

## Adding or editing a pack

1. Drop a new file under `server/lib/domainContext/packs/`. Filename stem
   must equal the frontmatter `id`.
2. Bump the `version` field on every edit (just a date string).
3. Restart `server/npm run dev` (the dev script runs `build:domain-packs`).
4. Verify in the admin UI that the new pack appears.

## Tests

| File | What it covers |
|------|----------------|
| [`tests/domainContextSchema.test.ts`](../../server/tests/domainContextSchema.test.ts) | Frontmatter parser + zod validation |
| [`tests/domainContextDiscover.test.ts`](../../server/tests/domainContextDiscover.test.ts) | Directory scan, error tolerance, sort order |
| [`tests/domainContextToggleStore.test.ts`](../../server/tests/domainContextToggleStore.test.ts) | Cosmos store fallback when unconfigured |
| [`tests/domainContextLoader.test.ts`](../../server/tests/domainContextLoader.test.ts) | Memoization, override application, empty-state |
| [`tests/domainContextWiring.test.ts`](../../server/tests/domainContextWiring.test.ts) | Block injection in planner + reflector prompts |
| [`tests/adminDomainContextRoute.test.ts`](../../server/tests/adminDomainContextRoute.test.ts) | Admin endpoint auth, validation, error paths |
| [`tests/promptCacheEligibility.test.ts`](../../server/tests/promptCacheEligibility.test.ts) (existing) | Confirms WD7 did not break the system-prompt prefix cache |
