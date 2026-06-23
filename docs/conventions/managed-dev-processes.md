# Convention — code-started dev/test processes are auto-reaped (no more leaks)

> Why your machine kept filling with hung Node processes, and the mechanism that
> now stops it. Added 2026-06-22 after a cleanup found **60+ orphaned
> `node --import tsx --test` processes** dating back days — one pegged at 96.9%
> CPU for ~63 hours. See [[L-030]] in [`docs/lessons.md`](../lessons.md).

## The leak (what was happening)

When a test wedges, `node --import tsx --test <file>` never exits. Two classes:

1. **Sync infinite loop** — pegs a CPU core forever. `--test-timeout` can't
   interrupt it (the timer never fires; the event loop is blocked). This is the
   63-hour / 96.9%-CPU case.
2. **Open handle** — a test passes but leaves a `setInterval` / socket / DuckDB
   connection open, so `node:test` hangs waiting on a non-empty event loop.

**The test files themselves were innocent.** When the leak was traced, both
chronic offenders (`chartInsightUnification.test.ts`, `parseContentDispositionFilename.test.ts`)
*passed* and exited cleanly under the hardened runner. The open handle belongs to
the `node --import tsx` ESM **loader**, not the tests — proof: a test that imports
ZERO repo code (only `node:fs`/`node:test`) leaked identically. So the fix is the
runner, not the tests; there is nothing to "fix" in an individual test file.

These run via the agent's Bash tool as **detached grandchildren** with no
controlling terminal. When the turn/session ends they reparent to `launchd` and
**survive**, accumulating across sessions for days.

Three things made it sticky:
- **SIGTERM doesn't kill a CPU-bound loop** — it never yields to run its handler.
  Cleanup must use **SIGKILL**.
- **The Bash tool is sandboxed** — it gets `EPERM` trying to signal processes it
  didn't spawn (i.e. cross-session orphans). It literally *cannot* clean up after
  itself. A **hook runs outside the sandbox**, so it can.
- **Nothing auto-reaped** — the only `Stop` hook checked doc freshness.

## How "code-started" is told apart from "you started it in a terminal"

A server you launch by hand in one of the three dev terminals has a controlling
**TTY** (`ttys003`). A process spawned by code execution has **TTY `??`** (none).
The reaper only ever touches **TTY `??`** processes, so your terminal servers are
always spared. This survives reparenting (orphans keep `??`), which ppid-ancestry
does not.

## The fix (3 layers — all default-on, behaviour-preserving)

1. **Stop the hang at the source** —
   [`server/scripts/runTests.mjs`](../../server/scripts/runTests.mjs):
   - `--test-force-exit` → exits even if a test leaks an open handle (does **not**
     fail any passing test).
   - child spawned **detached (own process group)** + signal forwarding → killing
     `npm test` SIGKILLs the *whole group*, so per-file workers die too.
   - **wall-clock watchdog** (`TEST_RUN_TIMEOUT_MS`, default 20 min) → if the run
     wedges anyway (sync loop), SIGKILL the group and exit `124`.
   - `--test-timeout` (per-test) is opt-in via `TEST_TIMEOUT_MS` so it can't fail
     legitimately-slow live-integration tests on the default path.

2. **Guaranteed reaping** — [`.claude/hooks/kill-stray-servers.sh`](../../.claude/hooks/kill-stray-servers.sh),
   wired in [`.claude/settings.json`](../../.claude/settings.json):
   - **`Stop` hook** runs `--tests-only` at the END OF EVERY TURN — kills leaked
     `node:test`/`vitest` runners + tsx workers. Leaves dev servers alone so
     cross-turn verification still works.
   - **`SessionEnd` hook** runs `--all` — also kills leaked dev servers
     (server `tsx watch`, client `vite`, python `uvicorn`/`main.py`) and any
     TTY-`??` listener on **3000 / 3002 / 8001**. Nothing survives the session.
   - Logs one line per reap to `.claude/hooks/.kill-stray.log` (gitignored via the
     root `*.log` rule). Always exits 0 (advisory; never blocks the chat).

3. **Manual escape hatch** — `cd server && npm run kill:strays` (= the hook in
   `--all` mode). Run it any time from a terminal to nuke leaked code-started
   dev/test processes by hand.

## Running a SINGLE test file (do this, not raw `node --test`)

```bash
cd server && npm test -- tests/foo.test.ts            # one file, with force-exit + watchdog
cd server && npm test -- ../client/src/x/bar.test.ts  # client node:test file too
```

`runTests.mjs` accepts explicit file args, so a single-file run gets the SAME
hang containment as the full suite. **Do not** run `node --import tsx --test <file>`
directly: `--test-force-exit` is rejected in `NODE_OPTIONS`, so a direct run can't
inherit it — it will hang on the loader handle (or return a spurious exit-1 even
when every test passes). If you slip and a direct run leaks, the `Stop` hook reaps
it at turn end anyway.

## Env knobs

| Var | Default | Effect |
|---|---|---|
| `TEST_RUN_TIMEOUT_MS` | `1200000` (20 min) | Whole-suite watchdog; SIGKILLs the group + exits 124 past this. |
| `TEST_TIMEOUT_MS` | unset | When set, adds node's per-test `--test-timeout`. |

## Safe-tooling exclusions

The reaper never kills short-lived tsx tooling (orient pack, invariant firewall,
registry/symbol generators, domain-pack build, RAG/seed scripts) — see the
`EXCL` list in the hook. If you add a long-running tsx **dev tool** that should
survive a `Stop`, add its script name to `EXCL`.
