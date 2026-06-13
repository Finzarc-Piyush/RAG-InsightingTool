---
name: orient
description: Bring a new Claude Code chat up to speed on the current Marico RAG project state without re-exploring the codebase. Runs the generated orient pack (live git state, invariant-firewall verdict, churn, WIP, doc sizes, recent lessons) in one command. Use this at the start of every new chat or whenever you need a quick "where are we now" refresh.
---

# /orient — fast warmup for a new chat

You are starting work on the Marico RAG Insighting Tool. **Do not** re-explore the codebase via subagents, and **do not** read STATE.md / git logs by hand — one generated command gives you everything, always current.

## What to do

Run **one** command and read its output:

```bash
npm --prefix server run orient
```

It prints, computed FRESH from the live tree (so it can never be stale):

1. **Branch / HEAD / dirty state** — where you actually are right now.
2. **Invariant-firewall verdict** — `✓ N/N kernels hold` (docs trustworthy) or `✗ FIREWALL FAILING` with the failing checks. **If it shows FAILING, treat CLAUDE.md as suspect and fix the drift before relying on docs.**
3. **Recent activity** — last ~10 commits + inferred active subsystem.
4. **WIP** — newest plan file + durable feature streams from STATE.md.
5. **Docs table** — each key doc's ~token size + last-touched date, with `LARGE` flags so you don't blow context by opening the wrong one.
6. **Recent lessons** — L-NNN titles (open `docs/lessons.md` only for the ones that matter).

## What to output

A **short** synthesis (≤3 sentences), e.g.:

> "We're on `<branch>` @ `<head>` (<subject>); firewall <green/FAILING>. Recent activity in <subsystem>. <N> uncommitted files. Active plan: <title or none>. Watch <L-NNN> if it overlaps your task."

Then **stop** and wait for the user's request. Do not open subsystem docs, do not call subagents, do not propose work.

## What NOT to do

- **Do not read [`CLAUDE.md`](CLAUDE.md)** — already in context.
- **Do not read [`docs/WAVES.md`](docs/WAVES.md)** or [`docs/archive/`](docs/archive/) — too large / historical.
- **Do not read [`docs/architecture/`](docs/architecture/)** unless the plan or churn explicitly touches that subsystem (the docs table shows you which are LARGE).
- **Do not hand-read STATE.md or run raw git** — the orient pack already did, fresher.

If `npm run orient` fails (e.g. deps not installed), fall back to reading `docs/STATE.md` + `git log --oneline -10` + `git status -uno`, but note the firewall verdict will be missing.

Target: one command, < 3.5 K tokens of additional context.
