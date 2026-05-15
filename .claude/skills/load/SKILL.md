---
name: load
description: Pull a subsystem's deep-doc and related conventions into the current chat context on demand. Use this when you need to work on a specific subsystem (agent-runtime, charting, rag, mmm, wide-format, domain-context, schemas, etc.) without re-exploring the codebase. Saves tokens vs. spawning an Explore subagent for known subsystems. Takes one argument: the subsystem name.
---

# /load `<subsystem>` — fetch a subsystem deep-doc on demand

Argument: a subsystem name like `agent-runtime`, `charting`, `rag`, `mmm`, `wide-format`, `domain-context`, `schemas`, `brand-system`, `ci-and-env`, `upload_and_enrichment`, `tool-registry`, `skills`.

If the user typed something other than the canonical name (e.g. `/load chart` or `/load mmm-pipeline`), match leniently — list what you matched against and proceed.

## What to do

Run in parallel:

1. **Read [`docs/architecture/<subsystem>.md`](docs/architecture/)** — the subsystem deep-doc.
2. **Read [`docs/agents-architecture-inventory.md`](docs/agents-architecture-inventory.md)** ONLY IF subsystem is `agent-runtime`, `tool-registry`, or `skills` (it's the authoritative file-by-file map for agent internals).
3. **Read relevant conventions:** `ls docs/conventions/ 2>/dev/null` then read any whose filename contains the subsystem name as a token.
4. **Read relevant decisions:** `ls docs/decisions/ 2>/dev/null` then read any whose filename matches.
5. **Find recent waves that touched this subsystem.** Run `grep -n "<subsystem>" docs/WAVES.md | head -10` to identify wave-entry line numbers. Then `sed -n '<start>,<end>p' docs/WAVES.md` to read just those entries (NOT the whole file).
6. **Active plan check:** if a plan file in `/Users/tida/.claude/plans/` references this subsystem (case-insensitive grep), surface its filename.

## What to output

One short paragraph: "Loaded `<subsystem>` deep-doc + <N> conventions + <N> decisions + <N> recent wave entries. Active plan: <name | none>. Key files now in context: <list of 3–5 most-cited paths from the deep-doc>."

Then **stop**. Wait for the user's actual question. Do not propose work, do not start exploring code, do not call subagents — the deep-doc tells you everything.

## What NOT to do

- **Do not read `docs/WAVES.md` in full** — it's > 200 KB. Grep + sed for the relevant entries only.
- **Do not read `docs/archive/`** unless the user explicitly asks about a wave older than what's in `docs/WAVES.md`.
- **Do not call Explore / general-purpose subagents** for known subsystems — the deep-doc + waves grep is faster and cheaper.
- **Do not summarize the deep-doc back to the user** — they know what it says, they want you grounded in it. Just confirm what's loaded.

## Fallback: subsystem not found

If `docs/architecture/<subsystem>.md` does not exist:

1. List available subsystem docs: `ls docs/architecture/*.md`.
2. Ask the user which one they meant, or whether a new deep-doc should be drafted.
3. As a fallback, spawn an `Explore` subagent with the user's intent — but flag that the architecture doc gap should be filled in the next `/wave-commit`.
