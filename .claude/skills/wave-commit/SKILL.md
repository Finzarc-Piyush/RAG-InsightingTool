---
name: wave-commit
description: Finalize a wave by writing the WAVES.md changelog entry, updating STATE.md HEAD, touching the affected docs/architecture/<sub>.md files, creating docs/conventions/<slug>.md if a new convention was introduced, and committing the doc updates. Run this at the end of every wave. The Stop hook nudges you if you forget.
---

# /wave-commit — finalise a wave and update docs

Pre-condition: a wave's code changes are either staged, committed, or about to be. If unclear, **ask** the user before proceeding.

## Steps

1. **Inspect the wave.** Run in parallel:
   - `git log -1 --format='%H %s%n%b'` — get the latest commit subject/body to extract the wave id (`Wave W<n> · <subject>`). If the user hasn't committed yet, ask whether to commit first or assume "current diff is the wave".
   - `git diff HEAD~1 --stat` (or `git diff --stat` for uncommitted) — see what files changed.
   - `git diff HEAD~1 | head -300` — sample the actual changes so the entry has real depth.

2. **Identify the touched subsystems.** Map changed paths to subsystem deep-docs:

   | Path prefix | Subsystem doc |
   |---|---|
   | `server/lib/agents/runtime/` | `docs/architecture/agent-runtime.md` |
   | `server/lib/agents/runtime/tools/` | `docs/architecture/tool-registry.md` |
   | `server/lib/agents/runtime/skills/` | `docs/architecture/skills.md` |
   | `server/lib/wideFormat/` | `docs/architecture/wide-format.md` |
   | `server/lib/rag/` | `docs/architecture/rag.md` (if absent, see `docs/agents-architecture-inventory.md`) |
   | `server/lib/domainContext/` | `docs/architecture/domain-context.md` |
   | `python-service/mmm/` or `server/lib/dataOps/mmmService.ts` | `docs/architecture/mmm.md` |
   | `client/src/lib/charts/` or chart renderers | `docs/architecture/charting.md` |
   | `server/utils/uploadQueue.ts` or `server/lib/datasetProfile.ts` | `docs/architecture/upload_and_enrichment.md` |
   | `server/shared/schema.ts` or `client/src/shared/schema.ts` | `docs/architecture/schemas.md` |

3. **Compose the WAVES.md entry.** Match the existing prose voice — multi-paragraph technical depth, NOT bullet shorthand. Use this template:

   ```markdown
   - **YYYY-MM-DD** — **Wave W<n> · <subject>.** <One-paragraph problem statement: what was broken / what was missing.>
     - **What landed.** Files touched with markdown link syntax: [`path/to/file.ts`](path/to/file.ts), key functions added/changed, key constants. Be specific.
     - **Why this design.** Root cause, what alternatives were considered, why this one wins. Reference any plan file at `/Users/tida/.claude/plans/<plan>.md`.
     - **Tests.** New test files with paths + case count. Note if appended to `server/package.json`'s explicit `test` list.
     - **Verified.** Server tests N/N pass, client tests N/N pass, `npx tsc --noEmit` baseline preserved (X errors, identical to <prior wave>).
     - **Conventions added** (if any). State the rule, why, where it applies. If a convention is named, create [`docs/conventions/<slug>.md`](docs/conventions/<slug>.md) with the same content expanded.
     - **Out of scope.** Deferred items + reason. Prevents future-Claude from reopening settled scope.
   ```

   The entry should be 200–800 words depending on wave size. Match the depth of existing entries in `docs/WAVES.md`. Do NOT compress to bullets — future Claude needs the prose.

4. **Prepend the entry** to `docs/WAVES.md`, right under the front-matter header block (above the previous newest entry).

5. **Update `docs/STATE.md`:**
   - Bump HEAD to the new wave: subject line, branch (`git branch --show-current`), last commit hash + date.
   - Update working tree status (`git status -uno` summary).
   - Rotate "Last 5 waves" — prepend the new one, drop the oldest 6th.
   - If this wave starts or ends a feature stream, update "Live feature streams".
   - Update WIP / next-wave hints if applicable.

6. **Touch affected subsystem docs.** For each subsystem identified in step 2, append a one-line "Recent changes" entry to its `docs/architecture/<name>.md` file:

   ```markdown
   ### Recent changes
   - Wave W<n> (YYYY-MM-DD) — <one-line summary>. See `docs/WAVES.md`.
   ```

   If the file doesn't have a "Recent changes" section yet, add one at the bottom. Don't rewrite the body of the subsystem doc unless the wave actually changed the subsystem's contract — most waves don't.

7. **New convention?** If the wave's "Conventions added" entry names a new rule, create `docs/conventions/<slug>.md`:

   ```markdown
   # Convention: <name>

   > Introduced in Wave W<n> (YYYY-MM-DD). See `docs/WAVES.md` for the original context.

   ## Rule
   <one-paragraph statement>

   ## Why
   <root cause / motivation>

   ## How to apply
   <when this rule kicks in, code-level guidance>

   ## Related
   - [Wave W<n> entry](../WAVES.md)
   - Files: [`path/to/anchor.ts`](../../path/to/anchor.ts)
   ```

   Add a one-line entry to CLAUDE.md's "Critical invariants" list ONLY if this is a top-10 invariant — otherwise just leave it in `docs/conventions/<slug>.md` and let the routing table point at the directory.

8. **New cross-session lesson?** If the user corrected Claude on something non-obvious during the wave, append an L-NNN entry to [`docs/lessons.md`](../../docs/lessons.md).

9. **Stage and commit the doc updates.** Run:

   ```bash
   git add docs/STATE.md docs/WAVES.md docs/architecture/ docs/conventions/ docs/lessons.md
   git commit -m "$(cat <<'EOF'
   docs(W<n>): update STATE/WAVES + touched subsystems

   - WAVES.md: prepend Wave W<n> entry
   - STATE.md: bump HEAD + rotate Last 5
   - Touched: <list affected subsystem docs>

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

   Use a SEPARATE commit, not `--amend` (per CLAUDE.md git safety: never amend; create new commits).

10. **Check archive rotation.** If `wc -l docs/WAVES.md` > 600 lines OR `wc -c docs/WAVES.md` > 300000 bytes OR `docs/WAVES.md` contains > 50 top-level dated entries (`grep -c '^- \*\*[0-9]' docs/WAVES.md`):
    - **Propose** (do not auto-execute): "WAVES.md is approaching the rotation threshold. Would you like me to move the oldest 20 entries into `docs/archive/waves-W<from>-W<to>.md`?"
    - Wait for user confirmation before moving anything.

11. **Report briefly.** One sentence: "Wave W<n> documented in WAVES.md + STATE.md. <N> subsystem docs touched. <Commit hash>."

## What NOT to do

- **Do not push** unless the user explicitly authorises.
- **Do not amend** the wave commit. Doc updates are a separate commit.
- **Do not edit CLAUDE.md** unless an invariant, repo layout, dev command, or slash command actually changed. CLAUDE.md stays byte-stable to preserve prompt cache.
- **Do not compress the WAVES.md entry** to bullets. Match the existing prose depth.
- **Do not auto-rotate the archive** without asking. Rotation is a user-confirmed action.
- **Do not invent file paths or function names.** If you're not sure something exists, grep first.

## Example entry voice (read this before composing)

The existing `docs/WAVES.md` has dozens of entries. Read the first 2–3 (newest) before writing yours — match their voice. They:
- Open with date, wave id, subject, and a problem statement.
- Cite specific file paths via markdown link syntax `[path](path)`.
- Name functions, constants, schemas, env vars by their actual identifiers.
- Quantify ("12 new tests", "98 errors, identical to baseline", "60 K → 5 K tokens").
- End with explicit "Out of scope" so future-Claude doesn't reopen settled scope.

Bullet-form summaries are NOT the voice — full-prose technical depth is.
