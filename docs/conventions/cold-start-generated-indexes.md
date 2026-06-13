# Generated cold-start indexes — generate-and-gate, never hand-edit

**The rule:** every Claude-facing fact a machine can derive — branch/HEAD, the
tool/route/skill list, where a symbol is defined, whether an invariant still
holds — is **generated from the tree, never hand-typed**, and **gated** so drift
fails loudly. Prose docs carry judgment; generated indexes carry facts. This is
the fix for the June-2026 audit finding (≈46% of doc claims stale, 100% of
line-number anchors stale, STATE.md 62 commits behind on the wrong branch, two
invariants instructing dead workflows that survived 62 commits).

## The artifacts and their freshness tier

| Artifact | Generator | npm | Tier |
|---|---|---|---|
| Invariant firewall | `server/scripts/check-invariants.ts` (spec: `invariants.spec.ts`) | `check:invariants` | **hard** — `npm test` + blocking CI step |
| Orient pack (live state) | `server/scripts/generate-bootstrap.ts` | `orient` | **on-demand** — never committed |
| Registry manifest (`docs/index/registries.generated.md`) | `server/scripts/generate-registries.ts` | `gen:registries` | **hard** — committed + blocking CI `git diff` |
| Symbol index (`docs/index/symbols.generated.tsv`) | `server/scripts/generate-symbols.ts` | `gen:symbols` | **warn** — committed, regen at wave-commit, CI warns |
| Doc-reference validator | `server/scripts/check-doc-refs.ts` | `check:doc-refs` | **hard** (broken links/paths/line-anchors in live docs) + **warn** (phantom symbols) |

## Enforcement layers (where the gates actually run)

The gates run at four points, so drift is caught no matter the workflow:

1. **`npm test`** — `invariants.test.ts`, `docRefs.test.ts`, and the generator
   sanity tests are glob-discovered, so the full suite fails on drift.
2. **CI** (`.github/workflows/ci.yml`, server job) — blocking steps:
   `check:invariants`, `check:doc-refs`, and `git diff` on the registries
   manifest; symbol-index drift is a warning.
3. **Pre-commit hook** (`.githooks/pre-commit`, enabled via
   `git config core.hooksPath .githooks`) — runs the hard gates **locally at
   commit time** so drift never reaches a session, not just CI-on-push. Bypass
   with `git commit --no-verify`.
4. **SessionStart hook** (`.claude/hooks/session-warmup.sh`) — auto-injects the
   orient pack (incl. the firewall verdict) into every new session, so warmup is
   automatic, not opt-in.

## The irreducible residual (be honest)

Generation + gating kills drift for every **machine-checkable** fact. It cannot
verify **judgment prose** ("this design is better because…") — that can always
diverge from code. The mitigations: minimise load-bearing prose, surface its
staleness (orient pack shows per-doc size + last-touched), and the standing rule
in CLAUDE.md #8 — **trust generated facts, verify prose against code** (now one
grep via `symbols.generated.tsv`). A doc claim is a hint until confirmed.

## Why three different tiers (this is the important part)

- **On-demand (orient pack):** embeds volatile git state (branch/HEAD/churn). A
  *committed* snapshot of volatile state is exactly what rotted STATE.md, and a
  `git diff` gate on it would fail on every commit (HEAD changes). So it is
  recomputed each session and committed nowhere — it cannot drift.
- **Hard-gate (registries):** a pure function of source that changes *rarely*
  (only when a tool/route/skill is added). Commit it for one-read browsing; a
  blocking CI `git diff --exit-code` (the P-005 pattern) guarantees freshness at
  low friction.
- **Warn-tier (symbols):** carries line numbers, which move on *most* edits. A
  hard gate would fail unrelated PRs, so it is regenerated at `/wave-commit`
  (fresh for the next session) and CI only *warns* on drift. If a line looks
  off, the **file** column is still correct — grep the symbol there.

## Rules for whoever touches these

1. **Never hand-edit a `*.generated.*` file** — re-run its generator. Each
   carries an `AUTO-GENERATED … Do not edit by hand` header.
2. **They are COMMITTED**, unlike `server/lib/domainContext/generatedPacks.ts`
   (which is gitignored because it is a build-time bundle input). Cold-start
   indexes ship in the repo so a fresh session reads them without running code.
3. **Never hand-type a line number in prose docs.** It will rot (8/8 sampled
   anchors were stale). Reference the stable symbol name and point at
   `docs/index/symbols.generated.tsv` for the exact line.
4. **Tool names sit on the line AFTER `registry.register(`** — the naive
   `grep 'registry.register("name"'` returns zero matches; use `grep -A1`. The
   generator handles this; humans auditing by hand should remember it.
5. **Changing an invariant?** Edit `server/scripts/invariants.spec.ts` (the SoT),
   not just the CLAUDE.md prose — CI checks the kernel against code.
