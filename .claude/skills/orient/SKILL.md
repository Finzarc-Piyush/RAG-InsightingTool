---
name: orient
description: Bring a new Claude Code chat up to speed on the current Marico RAG project state without re-exploring the codebase. Reads STATE.md, recent git activity, the active plan file, and the lessons file. Use this at the start of every new chat or whenever you need a quick "where are we now" refresh.
---

# /orient — fast warmup for a new chat

You are starting work on the Marico RAG Insighting Tool. **Do not** re-explore the codebase via subagents — the doc routing system gives you everything you need in seconds.

## What to do

Run these in parallel (single message, multiple Bash + Read tool calls):

1. **Read [`docs/STATE.md`](docs/STATE.md)** — HEAD wave, live feature streams, last 5 waves, known WIP, next wave hint.
2. **`git log --oneline -10`** — last 10 commits, gives you the "what's been shipping" view.
3. **`git status -uno`** — uncommitted modifications. Important to know what's in flight vs. clean.
4. **`git diff --stat HEAD~3..HEAD`** — what files have churned recently. Hints at the active subsystem.
5. **Active plan file** — `ls -t /Users/tida/.claude/plans/*.md | head -3` then Read the newest. If nothing recent, say "no active plan".
6. **Read [`docs/lessons.md`](docs/lessons.md)** — cross-session gotchas. Surface any whose subject overlaps with what `git diff --stat` shows churning.

## What to output

A **short** synthesis. Three sentences max, no fluff:

> "We're at <HEAD wave>, branch <branch>. Active streams: <list from STATE.md>. Last shipping activity <N days ago> in <subsystem from diff>. <N> uncommitted files (or working tree clean). Active plan: <plan filename> (or 'none'). Relevant lessons: <L-NNN if any match the diff subject>."

Then **stop**. Wait for the user's actual request. Do not start exploring deeper, do not open subsystem docs, do not call subagents. The next user message will tell you what to do.

## What NOT to do

- **Do not read [`CLAUDE.md`](CLAUDE.md)** — it's already in your context.
- **Do not read [`docs/WAVES.md`](docs/WAVES.md)** — too large for warmup. Read STATE.md instead, which has last-5 already.
- **Do not read [`docs/archive/`](docs/archive/)** — historical, subagent-fetch only.
- **Do not read [`docs/architecture/`](docs/architecture/)** unless the active plan or git diff explicitly touches that subsystem.
- **Do not summarize old waves** the user already knows about — STATE.md has the recent five, that's enough.
- **Do not propose work** — wait for the user's instruction.

Target: < 10 seconds, < 5 K tokens of additional context loaded.
