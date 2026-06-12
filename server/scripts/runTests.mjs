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
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

const roots = ["tests", "../client/src"];
const files = roots.flatMap((r) => findTests(r)).sort();
console.log(`▶ Discovered ${files.length} node:test file(s)`);

const res = spawnSync("node", ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
