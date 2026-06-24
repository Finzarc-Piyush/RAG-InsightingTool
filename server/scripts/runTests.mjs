/**
 * Wave R26 · node:test runner with GLOB auto-discovery.
 *
 * Replaces the hand-maintained ~552-entry file list in package.json's `test`
 * script. That list was invariant #4's footgun: a new `*.test.ts` had to be
 * appended by hand or CI silently skipped it. This script discovers every
 * node:test file under `tests/` (server) and `../client/src/` (the client
 * node:test files run by the server suite), so new tests are picked up
 * automatically.
 *
 * EXCLUSIONS — vitest files (`*.vitest.test.ts` / `*.vitest.spec.ts`) import
 * from "vitest" and must NOT run under node:test; the client runs those via its
 * own `vitest` config. node's runner isolates each file in its own subprocess,
 * so discovery order is irrelevant (we sort for stable output).
 *
 * HANG CONTAINMENT (added after a single client test pegged a core for ~63h and
 * 60+ orphaned `node --import tsx --test` processes accumulated across days —
 * see docs/conventions/managed-dev-processes.md). Three layers, all
 * default-on and behaviour-preserving for a healthy run:
 *   1. `--test-force-exit` — node:test exits even if a test leaks an open handle
 *      (timer/socket/duckdb) instead of hanging on a non-empty event loop. Does
 *      NOT fail any passing test; only stops the post-run hang.
 *   2. detached PROCESS GROUP + signal forwarding — the child runs in its own
 *      group, so when `npm test` is interrupted (Ctrl-C, the agent's Bash-tool
 *      timeout, etc.) we SIGKILL the WHOLE group, killing per-file worker
 *      subprocesses too rather than orphaning them.
 *   3. wall-clock watchdog (`TEST_RUN_TIMEOUT_MS`, default 20 min) — if the run
 *      wedges anyway (a SYNC infinite loop, or a node:test runner-side TAP-drain
 *      spin, neither interruptible by `--test-timeout`), it NAMES the still-
 *      running file(s) in our process group, then SIGKILLs the group and exits 124.
 *   4. per-test timeout — now DEFAULT-ON (`--test-timeout`, default 4 min,
 *      override/disable via `TEST_TIMEOUT_MS`) so a hung test BODY fails fast and
 *      NAMED instead of riding up to the wall clock. The default is generous so
 *      it can't fail a legitimately-slow live test; set `TEST_TIMEOUT_MS=0` off.
 *   5. pre-run STRAY SWEEP — reap orphaned `--import tsx --test` workers left by
 *      a prior SIGKILLed run (the case signal-forwarding can't cover) so they
 *      can't starve this run into spurious timeouts.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "dist", ".git"]);

function isNodeTestFile(name) {
  return (
    name.endsWith(".test.ts") &&
    !name.endsWith(".vitest.test.ts") &&
    !name.endsWith(".vitest.spec.ts")
  );
}

function findTests(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // missing root — skip
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) findTests(full, acc);
    } else if (isNodeTestFile(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// Optional explicit file list: `npm test -- tests/foo.test.ts` runs just those
// files (still under the watchdog), so ad-hoc single-file runs get the same
// hang containment as the full suite. No args → glob-discover everything (the
// CI / `npm test` behaviour).
const argv = process.argv.slice(2);
const roots = ["tests", "../client/src"];
const files = argv.length ? argv : roots.flatMap((r) => findTests(r)).sort();
console.log(`▶ ${argv.length ? "Running" : "Discovered"} ${files.length} node:test file(s)`);
if (files.length === 0) {
  console.log("No test files matched.");
  process.exit(0);
}

// COVERAGE=1 turns on Node 20's built-in test coverage reporter (report-only;
// the normal `npm test` path is unchanged when the flag is absent). Wired here
// rather than as a separate script so discovery stays single-sourced.
const coverageArgs =
  process.env.COVERAGE === "1" || process.env.COVERAGE === "true"
    ? ["--experimental-test-coverage"]
    : [];

// Per-test timeout — now DEFAULT-ON (was opt-in). A hung test BODY fails fast
// with node:test's own named "test timed out" line instead of riding the run
// up to the wall-clock watchdog. The default is generous (4 min) so it can't
// fail a legitimately-slow live-integration test; override with TEST_TIMEOUT_MS,
// or set TEST_TIMEOUT_MS=0 to disable entirely for a live run with slower tests.
const DEFAULT_TEST_TIMEOUT_MS = 4 * 60 * 1000;
const perTestTimeoutMs =
  process.env.TEST_TIMEOUT_MS != null && process.env.TEST_TIMEOUT_MS !== ""
    ? Number(process.env.TEST_TIMEOUT_MS)
    : DEFAULT_TEST_TIMEOUT_MS;
const timeoutArgs =
  Number.isFinite(perTestTimeoutMs) && perTestTimeoutMs > 0
    ? [`--test-timeout=${perTestTimeoutMs}`]
    : [];

const RUN_TIMEOUT_MS = Number(process.env.TEST_RUN_TIMEOUT_MS || 20 * 60 * 1000);

// STRAY SWEEP — orphaned node:test workers from a prior aborted run (Ctrl-C, an
// agent Bash-tool timeout that kills the wrapper but not the detached group)
// peg cores and starve THIS run, manifesting as spurious slowness/timeouts in
// late-scheduled files. Reap any leftover `--import tsx --test` workers before
// we start. Best-effort and self-excluding (our own group doesn't exist yet);
// never touches a `tsx watch` dev server. See docs/conventions/managed-dev-processes.md.
function sweepStrayTestWorkers(phase) {
  try {
    const out = execSync(
      "ps -axo pid=,command= | grep -E 'node .*--import tsx --test' | grep -v 'tsx watch' | grep -v grep || true",
      { encoding: "utf8" },
    );
    const pids = out
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((p) => p && /^\d+$/.test(p) && Number(p) !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* gone */
      }
    }
    if (pids.length) console.error(`▶ stray-sweep (${phase}): reaped ${pids.length} orphaned test worker(s)`);
  } catch {
    /* ps unavailable (non-POSIX) — skip; the watchdog group-kill is the backstop */
  }
}
sweepStrayTestWorkers("pre-run");

const child = spawn(
  "node",
  ["--import", "tsx", "--test", "--test-force-exit", ...timeoutArgs, ...coverageArgs, ...files],
  { stdio: "inherit", detached: true }, // own process group → group-kill reaches workers
);

// Kill the child's whole process group (falls back to the bare child).
function nukeGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

let timedOut = false;
const watchdog = setTimeout(() => {
  timedOut = true;
  // NEVER MASK: name the culprit. node:test runs one worker process per file in
  // OUR process group (pgid === child.pid); a worker still alive at the wall
  // clock is the wedged/incomplete file. Print those paths so the failure is
  // actionable instead of a blind exit-124. (A pure node:test runner-side spin —
  // e.g. its TAP `processRawBuffer` drain — surfaces as the file whose worker
  // never finished.)
  let wedged = "";
  try {
    // Match WORKER processes in our group only: same pgid as the detached child,
    // but NOT the child itself (the parent's argv lists every file, which would
    // mis-name completed files as wedged). Each worker carries a single
    // *.test.ts in its argv — that's the file still running.
    const out = execSync(
      `ps -axo pid=,pgid=,command= | awk '$2==${child.pid} && $1!=${child.pid}' | grep -oE '[^ ]+\\.test\\.ts' | sort -u || true`,
      { encoding: "utf8" },
    ).trim();
    if (out)
      wedged =
        `\n  Wedged / incomplete file(s):\n` +
        out.split("\n").map((f) => `    • ${f}`).join("\n");
  } catch {
    /* ps unavailable — skip naming */
  }
  console.error(
    `\n✖ Test run exceeded ${RUN_TIMEOUT_MS}ms — SIGKILLing process group ${child.pid} (a test is wedged).` +
      `${wedged}\n  Bisect with \`npm test -- <file>\`; raise the budget with TEST_RUN_TIMEOUT_MS.`,
  );
  nukeGroup("SIGKILL");
}, RUN_TIMEOUT_MS);
watchdog.unref?.();

// Forward interrupts to the WHOLE group so killing `npm test` never orphans the
// node:test worker subprocesses (the leak this is fixing).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    nukeGroup("SIGKILL");
    process.exit(1);
  });
}

child.on("error", (err) => {
  clearTimeout(watchdog);
  console.error("Failed to launch test runner:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(watchdog);
  if (timedOut) process.exit(124);
  process.exit(signal ? 1 : (code ?? 1));
});
