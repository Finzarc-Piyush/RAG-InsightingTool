/**
 * Wave CS2 · Unit tests for the pure orient-pack builders. No repo/git needed —
 * fixtures in, markdown out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assembleBootstrap,
  buildInvariantLine,
  buildRouting,
  inferSubsystem,
  LARGE_TOKENS,
  type BootstrapInput,
} from "../scripts/lib/bootstrapSections.js";

test("invariant line: green vs failing", () => {
  assert.match(
    buildInvariantLine({ passed: 14, total: 14, failures: [] }),
    /✓ 14\/14 kernels hold/
  );
  const failing = buildInvariantLine({ passed: 13, total: 14, failures: ["I4: CLAUDE.md omits ..."] });
  assert.match(failing, /FIREWALL FAILING/);
  assert.match(failing, /I4: CLAUDE\.md omits/);
});

test("routing flags LARGE docs over the budget", () => {
  const out = buildRouting([
    { path: "docs/architecture/charting.md", tokens: LARGE_TOKENS + 1, lastTouched: "2026-04-21" },
    { path: "docs/STATE.md", tokens: 1700, lastTouched: "2026-06-03" },
  ]);
  assert.match(out, /charting\.md.*\*\*LARGE\*\*/);
  assert.doesNotMatch(out.split("\n").find((l) => l.includes("STATE.md"))!, /LARGE/);
});

test("inferSubsystem picks the dominant area", () => {
  assert.equal(
    inferSubsystem(["server/lib/agents/runtime/planner.ts", "server/lib/agents/runtime/verifier.ts", "docs/x.md"]),
    "agent-runtime"
  );
  assert.equal(inferSubsystem([]), null);
});

test("assembleBootstrap includes every section", () => {
  const input: BootstrapInput = {
    git: { branch: "main", headShort: "abc1234", headSubject: "Wave CS2", dirtyCount: 0, commitsSinceMain: 3, newestDateRel: "1 hour ago" },
    recentCommits: [{ hash: "abc1234", subject: "Wave CS2 · orient pack" }],
    churnedFiles: ["server/scripts/generate-bootstrap.ts"],
    planTitle: "Cold-start firewall",
    streams: "- stream A\n- stream B",
    invariants: { passed: 14, total: 14, failures: [] },
    docs: [{ path: "CLAUDE.md", tokens: 2300, lastTouched: "2026-06-13" }],
    lessons: [{ id: "L-012", title: "composite key separators" }],
    generatedNote: "test note",
  };
  const pack = assembleBootstrap(input);
  for (const marker of ["# Orient", "**Branch**", "Invariants", "Recent activity", "## WIP", "Cold-start firewall", "## Docs", "Recent lessons", "L-012", "test note"]) {
    assert.ok(pack.includes(marker), `missing section marker: ${marker}`);
  }
});
