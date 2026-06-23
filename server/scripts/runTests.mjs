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
 *      wedges anyway (a SYNC infinite loop can't be interrupted by
 *      `--test-timeout`), SIGKILL the group and exit 124.
 * `--test-timeout` (per-test) is opt-in via `TEST_TIMEOUT_MS` so it can't fail
 * legitimately-slow live-integration tests on the default CI path.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

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

const timeoutArgs = process.env.TEST_TIMEOUT_MS
  ? [`--test-timeout=${Number(process.env.TEST_TIMEOUT_MS)}`]
  : [];

const RUN_TIMEOUT_MS = Number(process.env.TEST_RUN_TIMEOUT_MS || 20 * 60 * 1000);

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
  console.error(
    `\n✖ Test run exceeded ${RUN_TIMEOUT_MS}ms — SIGKILLing process group ${child.pid} (a test is wedged). ` +
      `Override with TEST_RUN_TIMEOUT_MS.`,
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
