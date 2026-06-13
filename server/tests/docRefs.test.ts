/**
 * Wave CS7 · The doc-reference validator, run as a test so `npm test` (blocking
 * in CI) fails the moment any LIVE routing doc references a file that doesn't
 * exist — generalising the invariant firewall from ~8 kernels to every
 * machine-checkable claim across docs/architecture, docs/conventions,
 * docs/decisions, CLAUDE.md, and the skills. Warnings (phantom symbols) are
 * surfaced by the CLI but not gated here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runDocRefChecks } from "../scripts/check-doc-refs.js";

test("no live doc references a non-existent file, line anchor, or path", () => {
  const { hard } = runDocRefChecks();
  assert.equal(
    hard.length,
    0,
    `Broken references in live docs (they would mislead a fresh session):\n` +
      hard.map((f) => `  ✗ ${f.doc}:${f.line} [${f.kind}] ${f.detail}`).join("\n") +
      `\nFix the doc or the path; run: npm --prefix server run check:doc-refs`
  );
});
