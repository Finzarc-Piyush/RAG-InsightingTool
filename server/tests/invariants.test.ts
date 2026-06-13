/**
 * Wave W1 · The invariant firewall, run as a test.
 *
 * runTests.mjs glob-discovers this file, so `npm test` (blocking in CI) fails
 * the moment a CLAUDE.md invariant stops matching the code — turning silent
 * doc-drift into a red build. The standalone `npm run check:invariants` prints
 * the full pass/fail table; here we just assert zero failures with a readable
 * diff of any that slipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runInvariantChecks } from "../scripts/check-invariants.js";

test("every CLAUDE.md invariant kernel holds against the live tree", () => {
  const failed = runInvariantChecks().filter((r) => !r.ok);
  assert.equal(
    failed.length,
    0,
    `Invariant drift detected — CLAUDE.md would mislead a fresh session:\n` +
      failed.map((f) => `  ✗ ${f.invariantId}: ${f.detail}`).join("\n") +
      `\nFix the code, or update server/scripts/invariants.spec.ts if the truth changed.`
  );
});
