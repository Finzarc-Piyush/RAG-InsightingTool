# Lessons — Marico RAG Insighting Tool

> Cross-session gotchas, patterns that bit us, and corrections worth remembering.
> Append to this file via `/wave-commit` when a wave introduced a new lesson, or manually
> when a chat-level correction is worth keeping across sessions.
>
> Newest at top. One lesson per section. Each lesson states: the rule, why (what went wrong),
> and how to apply it next time.

## L-001 — Don't restore the legacy orchestrator fallback

**Rule:** `dataAnalyzer.answerQuestion` MUST throw when `AGENTIC_LOOP_ENABLED` is false. No fallback.

**Why:** The handler-based orchestrator chain was deleted in commit `9422bed7` (2026-04-26). Reintroducing a fallback re-creates the silent-divergence failure mode where two pipelines drift, masking agent regressions.

**How to apply:** If a test or scenario seems to need a "non-agentic" path, the right fix is `AGENTIC_ALLOW_NO_RAG=true` for that path, not a code-level fallback. See [docs/plans/agentic_only_rag_chat.md](plans/agentic_only_rag_chat.md).

## L-002 — Audit summaries are NOT ground truth

**Rule:** Before acting on an audit / inventory / "system overview" that flags a bug, re-verify against the live code with grep + Read. Audit text can lag the tree by weeks.

**Why:** The 2026-05-06 audit pass corrected three drifted sections in CLAUDE.md that had accumulated over 2-3 weeks of waves. The audit caught real drift, but if Claude had implemented changes based on the pre-audit text, work would have been wasted. Similarly, A1's "race" finding turned out partially false-positive (pivot cache was already correct via FA2).

**How to apply:** Whenever the user's question references "the audit says X" or "the system overview claims Y", verify X/Y against the actual file at the cited line numbers before proposing changes.

## L-003 — The unified `withSessionWriteLock` is the per-session write mutex

**Rule:** All RMW writes to a `ChatDocument` must acquire `withSessionWriteLock(sessionId, fn)` from [server/lib/sessionWriteLock.ts](../server/lib/sessionWriteLock.ts) (Wave A2).

**Why:** Pre-A2 there were three independent in-process mutex maps (`sessionPersistChain`, `sessionPatchChain`, `activeFilterLocks`) that serialized within their own call sites but did NOT coordinate with each other. The BAI patch could race against turn-end persist and silently corrupt `messages[]`.

**How to apply:** Single-instance correctness only — multi-instance horizontal scaling still needs Cosmos `ifMatch` ETag or external lock. New code that touches the chat doc from outside an existing locked path MUST acquire this lock.

## L-004 — `loadEnv.ts` must be the first import in `server/index.ts`

**Rule:** Never reorder imports in `server/index.ts`.

**Why:** `loadEnv.ts` populates `process.env` from `server/server.env` (the non-standard env file name) before any module reads config. Any earlier import that touches env at module load time will read undefined values silently.

**How to apply:** When adding new imports, append them after `loadEnv`. When reorganizing modules, leave `loadEnv` alone.

## L-005 — Server `npm test` is an explicit file list, not a glob

**Rule:** When you add a new test file (server-side OR client-side imported via `../client/...`), append it to the `test` script in [server/package.json](../server/package.json). Glob-style discovery is NOT in play.

**Why:** CI runs exactly what's in the script. A new test file not appended is silently skipped — coverage feels green, real regressions ship.

**How to apply:** Wave-commit step verifies every new `tests/*.ts` file appears in `server/package.json`'s `test` script.

## L-006 — Don't put wave-by-wave history back into CLAUDE.md

**Rule:** CLAUDE.md is the routing index, ~5–8 KB. The wave-by-wave changelog lives in `docs/WAVES.md` and is updated by `/wave-commit`. Never inline wave entries back into CLAUDE.md.

**Why:** Before the 2026-05-15 routing-system migration, CLAUDE.md grew to 298 KB / 75 K tokens — almost 80 % was the inline changelog. Every chat paid that cost on load. The 2026-05-06 audit pass exists *because* drift between inline CLAUDE.md text and `docs/architecture/*.md` had accumulated. Routing > replication.

**How to apply:** Wave entries go in `docs/WAVES.md`. New conventions get their own file in `docs/conventions/<slug>.md` with a one-line index entry in CLAUDE.md. Architectural decisions go in `docs/decisions/<slug>.md`. CLAUDE.md links — it does not duplicate.

## Adding new lessons

When the user corrects Claude on something non-obvious (an approach that failed, a rule they didn't articulate before, an invariant Claude tripped):

1. Write a new section here following the L-NNN format.
2. State the rule, why (what went wrong / why it matters), how to apply.
3. Reference the affected files / functions with markdown link syntax.
4. `/wave-commit` includes lesson additions in its summary so they survive across sessions.

When a recorded lesson is no longer true (the underlying code changed, the rule was wrong), strike it through with a one-line note pointing at the wave that obsoleted it — don't delete the lesson silently.
